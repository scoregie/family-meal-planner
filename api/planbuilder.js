// The built-in plan builder: makes a whole 4-week plan without AI, from everyone's About me
// answers and the meal library in library.json (built by tools/build_library.py).
//
// It works by rules, not judgement:
//   - Each person's answers become rules: allergies and diets (never broken), foods they won't eat,
//     textures and spice, cooking time, kitchen equipment, budget, and what they like.
//   - Shared family dinners are picked from the library to suit everyone where possible. Anyone a
//     dinner doesn't suit gets their own dinner that night instead.
//   - Portions come from age, size, activity and goal. Children are never given less to lose weight.
//   - Shopping lists add up every recipe's amounts for the people eating them, in whole packs.
//     Things that keep (pantry, freezer, cheese) carry over between weeks so nothing is bought twice.
//   - Outside Australia, shop names, pack sizes and prices come from library-prices.json
//     (opts.country), and recipe words change to the local ones ("capsicum" to "pepper").
//   - Exercise builds gently over the 4 weeks from each person's time, equipment and health notes.
//
// The result goes through the same review and approval as a plan drafted by AI (plandraft.js).
// The data files. On the server they're loaded here with require(). The phone app has no
// require(), so its local-api.js loads them itself and passes them in with useData().
const ON_SERVER = typeof require === 'function';
let LIB = ON_SERVER ? require('./library.json') : null;
let EXERCISES = ON_SERVER ? require('./exercises.json').exercises : [];

// Local shop names, pack sizes and prices for other countries (made by tools/build_prices.py).
// Australia's are in library.json. A copy of the app without the file prices everything in AUD.
let PRICES = { countries: {}, words: {} };
try { if (ON_SERVER) PRICES = require('./library-prices.json'); } catch (e) { /* Australian prices only */ }

// The country this build is for, set by useCountry() at the start of build().
let ING = LIB ? LIB.ingredients : {};   // ingredients with this country's names, packs and prices
let MISSING = new Set();     // ingredients that are hard to find there
let CURRENCY = 'AUD';
let LOCALE = 'en-AU';
// Sets up the module for one country: its ingredient names, pack sizes and prices, what's hard to
// find there, and its currency. Returns that country's price list (null for Australia).
function useCountry(country, locale) {
  LOCALE = locale || 'en-AU';
  const c = PRICES.countries && PRICES.countries[country];
  CURRENCY = c ? c.currency : 'AUD';
  MISSING = new Set(c ? c.missing || [] : []);
  ING = {};
  for (const [k, ing] of Object.entries(LIB.ingredients)) {
    const local = c && c.items[k];
    // An ingredient added to the library since the price list was made: its Australian price, converted.
    ING[k] = local ? Object.assign({}, ing, { name: local[0], pack: local[1], price: local[2] })
      : c ? Object.assign({}, ing, { price: Math.round(ing.price * (c.rate || 1) * 100) / 100 }) : ing;
  }
  return c || null;
}
// Whether a dish or snack can be made with what the shops there sell.
const available = d => !d.per.some(x => MISSING.has(x[0]));

// An amount in this build's currency, for notes: "$120", "£85", "¥12,000".
function priceText(n) {
  try {
    return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY, maximumFractionDigits: 0 }).format(n);
  } catch (e) {
    return '$' + Math.round(n);
  }
}

// Changes recipe words to the country's ("capsicum" to "pepper"), in every text and key of the plan.
function reword(value, pairs) {
  if (!pairs || !pairs.length) return value;
  const res = pairs.map(([from, to]) => [new RegExp('\\b' + from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'), to]);
  const fix = text => res.reduce((t, [re, to]) => t.replace(re, m => (m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase() ? to[0].toUpperCase() + to.slice(1) : to)), text);
  const walk = v => {
    if (typeof v === 'string') return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k === 'id' ? k : fix(k)] = k === 'id' ? x : walk(x);
      return out;
    }
    return v;
  };
  return walk(value);
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_NAMES = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
const SECTION = { fresh: 'Fruit and veg', meat: 'Meat and fish', dairy: 'Dairy and fridge', bread: 'Bread and wraps', frozen: 'Freezer', pantry: 'Pantry' };
// How many days things keep once bought (opened), for carrying leftovers into the next week.
const KEEPS = { fresh: 5, meat: 3, dairy: 7, bread: 7, frozen: 60, pantry: 60 };
const KEEPS_ITEM = {
  cheddar: 28, mozzarella: 21, butter: 30, carrot: 21, onion: 30, potato: 30, 'sweet potato': 21, apple: 21, pumpkin: 14,
  garlic: 30, lemon: 14, mandarin: 10, celery: 10, cabbage: 14, 'coleslaw mix': 5, milk: 7, 'greek yoghurt': 14, egg: 28,
  feta: 10, halloumi: 30, ricotta: 5, 'cottage cheese': 5, 'sour cream': 14, cream: 7, tzatziki: 5, hummus: 5, pesto: 7, tofu: 5,
  bread: 14, wraps: 21, rolls: 14, pita: 14, 'fruit bread': 14,   // bread and wraps keep in the freezer
};
const COOK_LIMIT = { '15 minutes or less': 20, 'About 30 minutes': 35, 'Up to an hour': 70, "I don't cook": 25 };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function list(v) {
  if (Array.isArray(v)) return v.map(String);
  return v ? [String(v)] : [];
}

// A number from an answer ("1,200" gives 1200), or null if it isn't one.
function num(v) {
  const n = parseFloat(String(v === undefined || v === null ? '' : v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// A repeatable random order, so the same seed gives the same plan and "Rebuild" gives a new one.
function random(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

// Words from free text, for matching against dish and ingredient names: "Mushrooms, olives and
// coriander" -> ["mushroom", "olive", "coriander"].
function words(text) {
  return String(text || '').toLowerCase()
    .split(/[,;\n/]|\band\b|\bor\b|\bno\b|\bnot\b/)
    .map(w => w.replace(/[^a-z\s-]/g, '').trim())
    .filter(w => w.length >= 3 && !/^(none|nothing|n\/a|any|all|food|foods|the|too|very|much|really|don|dont)$/.test(w))
    .map(w => w.replace(/(ies)$/, 'y').replace(/(oes)$/, 'o').replace(/s$/, ''));
}

// Rounds to the nearest step: round(237, 25) gives 225.
function round(n, step) {
  return Math.round(n / step) * step;
}

const money = n => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// People: rules and portions from About me
// ---------------------------------------------------------------------------

// Medicines people said they take (About me). Each adds considerations, written as things to
// check with their doctor or pharmacist; none of it changes their medicine.
const MAOI_FOODS = ['soy sauce', 'fish sauce', 'teriyaki', 'vegemite', 'pesto', 'curry paste'];
const MEDS = {
  'Blood thinner (like warfarin)': {
    food: 'You said you take a blood thinner. If it’s warfarin, it may help to keep the amount of leafy greens (spinach, broccoli, lettuce) about the same from week to week rather than avoiding them. Your doctor or pharmacist can say what applies to your medicine.',
    exercise: 'You said you take a blood thinner. Consider lower-risk activities over ones with falls or knocks, and checking with your doctor about any bruising or bleeding.',
  },
  'Insulin, or diabetes tablets that can cause low blood sugar': {
    food: 'You said your diabetes medicine can cause low blood sugar. It may be worth checking with your diabetes team before changing how much you eat, and not skipping meals or snacks.',
    exercise: 'You said your diabetes medicine can cause low blood sugar. Consider checking your levels before and after exercise, keeping fast-acting carbs with you, and asking your diabetes team how to adjust around sessions.',
  },
  'Weight-loss or diabetes injection (like Ozempic or Mounjaro)': {
    food: 'You said you use a weight-loss or diabetes injection. You may feel full sooner: smaller portions are fine, and it may help to eat the protein and vegetables first. Tell your doctor if you can’t keep food or fluids down.',
    exercise: 'You said you use a weight-loss or diabetes injection. Strength sessions may help keep muscle while you lose weight. Consider drinking water around exercise, and easing off if you feel faint.',
  },
  'Blood pressure or heart medicine': {
    food: 'You said you take blood pressure or heart medicine. Some of these don’t mix with grapefruit or with salt substitutes (which can contain potassium), so it may be worth asking your pharmacist.',
    exercise: 'You said you take blood pressure or heart medicine. Some of these keep your heart rate lower, so go by how hard it feels (you should be able to talk) rather than heart rate. Stand up slowly after floor exercises if you feel dizzy.',
  },
  'Fluid tablets (diuretics)': {
    food: 'You said you take fluid tablets. It may be worth asking your doctor how much to drink, and whether salt or potassium matter for your tablets.',
    exercise: 'You said you take fluid tablets. Consider asking your doctor how much to drink around exercise, and taking extra care in hot weather.',
  },
  'Cholesterol medicine (statin)': {
    food: 'You said you take a statin. Some statins don’t mix with grapefruit, so it may be worth asking your pharmacist.',
    exercise: 'You said you take a statin. If you get unusual muscle pain or weakness that isn’t normal soreness, consider stopping and telling your doctor.',
  },
  'Thyroid medicine': {
    food: 'You said you take thyroid medicine. It’s often taken on an empty stomach, away from calcium, iron, soy and coffee. Your pharmacist can say how to time it with breakfast.',
  },
  'Steroid tablets (like prednisolone)': {
    food: 'You said you take steroid tablets. They can raise appetite and blood sugar. It may help to keep filling snacks like fruit, yoghurt and vegetables handy, and to ask your doctor about calcium and vitamin D.',
    exercise: 'You said you take steroid tablets. Strength exercise may help your bones and muscles. Consider asking your doctor if there’s anything to avoid.',
  },
  'ADHD stimulant medicine': {
    food: 'You said you take ADHD stimulant medicine. It can lower appetite in the day, so it may help to eat a good breakfast before it starts working and to have a bigger snack or supper when it wears off.',
  },
  'An MAOI antidepressant': {
    food: 'You said you take an MAOI. Foods high in tyramine can raise blood pressure with these, so this plan leaves out soy sauce, fish sauce, Vegemite, pesto and curry paste. Aged cheese, cured meats and leftovers kept too long can also be high: ask your doctor or pharmacist which foods to avoid.',
  },
  'Iron or calcium supplements': {
    food: 'You said you take iron or calcium. They’re often taken apart from each other, and iron is often taken away from tea, coffee and dairy. Your pharmacist can say what applies to you.',
  },
  'Other medicines': {
    food: 'You said you take other medicines. It may be worth asking your pharmacist whether any foods or drinks affect them.',
  },
};

const ALLERGY = { Peanuts: 'peanut', 'Tree nuts': 'treenut', Milk: 'milk', Eggs: 'egg', 'Wheat or gluten': 'gluten', Soy: 'soy', Fish: 'fish', Shellfish: 'shellfish', Sesame: 'sesame', Lactose: 'lactose' };
const ALLERGY_WORDS = { peanut: 'peanuts', treenut: 'tree nuts', milk: 'milk', egg: 'eggs', gluten: 'gluten', soy: 'soy', fish: 'fish', shellfish: 'shellfish', sesame: 'sesame', lactose: 'lactose' };

// Turns one person's About me answers into rules for the builder: allergies and diets, foods they
// won't eat, how they like to eat, cooking time, budget, health conditions and so on.
function rulesFor(p) {
  const a = p.answers || {};
  const age = num(a.age);
  const r = {
    key: p.key, name: p.name, age, kid: age !== null && age < 13, teen: age !== null && age >= 13 && age < 18,
    hard: new Set(),      // tags never allowed (allergies)
    diet: new Set(),      // tags left out because of their diet (vegetarian and so on)
    avoidWords: [],       // foods they won't eat
    avoidTexture: new Set(),
    likeWords: words(a.likes).concat(words(a.safe_foods)),
    cuisines: new Set(list(a.cuisines)),
    cookLimit: COOK_LIMIT[a.cook_time] || null,
    cooks: a.cook_time !== "I don't cook",
    kitchen: new Set(list(a.kitchen).map(k => k.toLowerCase())),
    help: new Set(list(a.cooking_help)),
    sensory: new Set(list(a.sensory)),
    support: new Set(list(a.support_needs)),
    conditions: new Set(list(a.conditions)),
    meds: new Set(list(a.medicine_types).filter(m => m !== 'None of these')),
    packed: /Yes|Some/.test(String(a.packed_lunch || '')),
    budget: num(a.budget),
    notes: [],
  };
  for (const x of list(a.allergies)) if (ALLERGY[x]) r.hard.add(ALLERGY[x]);
  if (r.conditions.has('Coeliac disease')) r.hard.add('gluten');
  // MAOIs: foods high in tyramine can raise blood pressure, so leave out the obvious ones.
  if (r.meds.has('An MAOI antidepressant')) r.avoidWords.push(...MAOI_FOODS);
  r.avoidWords.push(...words(a.allergies_other));
  for (const d of list(a.diet)) {
    if (d === 'Vegetarian') ['meat', 'fish', 'shellfish'].forEach(t => r.diet.add(t));
    if (d === 'Vegan') ['meat', 'fish', 'shellfish', 'animal', 'honey', 'milk', 'egg', 'lactose'].forEach(t => r.diet.add(t));
    if (d === 'Pescatarian') r.diet.add('meat');
    if (d === 'Halal') { r.diet.add('pork'); r.notes.push('Choose halal-certified meat and stock.'); }
    if (d === 'Kosher') { r.diet.add('pork'); r.diet.add('shellfish'); r.notes.push('Choose kosher-certified products, and keep meat and dairy apart as you usually would.'); }
    if (d === 'No pork') r.diet.add('pork');
    if (d === 'No beef') r.diet.add('beef');
  }
  r.avoidWords.push(...words(a.dislikes));
  if (r.sensory.has('Spicy food')) r.diet.add('spicy');
  if (r.sensory.has('Lumpy or mixed textures (like stews)')) r.avoidTexture.add('mixed');
  if (r.sensory.has('Mushy or soft textures')) r.avoidTexture.add('soft');
  if (r.sensory.has('Crunchy or hard textures')) r.avoidTexture.add('crunchy');
  if (r.sensory.has('Slimy textures')) r.avoidWords.push('mushroom');
  return r;
}

// One person's portion: their energy needs compared with an average adult (about 8,700 kJ a day).
function portionFor(p, r) {
  const a = p.answers || {};
  const age = r.age;
  if (age === null) return Number(p.portion) || 1;
  if (age < 4) return 0.5;
  if (age < 9) return 0.65;
  if (age < 13) return 0.8;
  const sex = a.sex === 'Male' ? 'm' : a.sex === 'Female' ? 'f' : null;
  if (age < 18) return sex === 'm' ? 1.1 : 0.95;
  const w = num(a.weight), h = num(a.height);
  if (!w || !h || w < 30 || w > 300 || h < 120 || h > 230) return sex === 'm' ? 1.1 : sex === 'f' ? 0.9 : 1;
  const bmr = 10 * w + 6.25 * h - 5 * age + (sex === 'm' ? 5 : sex === 'f' ? -161 : -78);
  const activity = { 'Mostly sitting (desk job)': 1.35, 'On my feet some of the day': 1.5, 'On my feet most of the day': 1.65, 'Physical work all day': 1.85 }[a.activity] || 1.45;
  let kcal = bmr * activity;
  const goals = new Set(list(a.goal));
  const pregnant = r.conditions.has('Pregnant or breastfeeding');
  if (goals.has('Lose weight') && !pregnant) kcal *= { 'Slow and steady': 0.9, 'A moderate pace': 0.85, 'As fast as is safe': 0.8 }[a.pace] || 0.85;
  else if (goals.has('Gain weight') || goals.has('Build muscle')) kcal *= 1.1;
  if (pregnant) kcal += 350;
  return Math.min(1.5, Math.max(0.7, round(kcal * 4.184 / 8700, 0.05)));
}

// ---------------------------------------------------------------------------
// Choosing dishes
// ---------------------------------------------------------------------------

// A dish's name and ingredients as text, for matching foods people won't eat or love. Oil, salt and
// spices that are assumed on hand are left out (so "olives" doesn't match "olive oil").
function dishWords(d) {
  return (d.name + ' ' + d.per.filter(x => LIB.ingredients[x[0]].aisle !== 'assumed')
    .map(x => x[0] + ' ' + LIB.ingredients[x[0]].name + ' ' + ING[x[0]].name).join(' ')).toLowerCase();
}

// Whether a dish or snack is allowed for a person (allergies, diet, foods they won't eat, textures).
function allowed(d, r) {
  for (const t of d.tags || []) if (r.hard.has(t) || r.diet.has(t)) return false;
  for (const t of d.texture || []) if (r.avoidTexture.has(t)) return false;
  const text = d.what ? (d.what + ' ' + d.per.map(x => x[0]).join(' ')).toLowerCase() : dishWords(d);
  for (const w of r.avoidWords) if (w && text.includes(w)) return false;
  return true;
}

// Whether the household can make a dish: kitchen equipment (if anyone said what they have).
function canCook(d, house) {
  if (!house.kitchen.size) return true;
  return (d.kit || []).every(k => house.kitchen.has(k) || (k === 'oven' && house.kitchen.has('air fryer')) || false);
}

// A score for how well a dish fits the people eating it (higher is better).
function score(d, eaters, house, rnd) {
  let s = rnd() * 3;
  const text = dishWords(d);
  for (const r of eaters) {
    if (!allowed(d, r)) { s -= 10; continue; }   // they'll get their own dinner that night
    if (d.meal === 'lunch' && r.packed && !d.packable) s -= 4;
    for (const w of r.likeWords) if (w && text.includes(w)) s += 3;
    if (r.cuisines.has(d.cuisine)) s += 2;
    if (r.sensory.has('Foods touching on the plate') && d.separate) s += 2;
    if (r.help.has('Meals with only a few steps') && d.steps.length > 3) s -= 2;
    if (r.help.has('One-pan or tray-bake meals') && d.onepan) s += 2;
    if (r.help.has('Cooking a batch on a good day') && d.batch) s += 1.5;
    if (r.sensory.has('Strong smells') && (d.tags || []).includes('fish')) s -= 2;
  }
  if (house.cookLimit && d.minutes > house.cookLimit) s -= (d.minutes - house.cookLimit) / 5;
  if (house.budget) s -= d.cost * house.costWeight;
  return s;
}

// What a dinner is mostly made of, for variety ("not chicken three nights running").
function mainOf(d) {
  const t = new Set(d.tags || []);
  if (t.has('fish')) return 'fish';
  if (t.has('poultry') && !/stock/.test(d.per.map(x => x[0]).join())) return 'chicken';
  for (const k of ['beef', 'lamb', 'pork']) if (t.has(k)) return 'red';
  if (d.per.some(x => x[0] === 'chicken breast' || x[0] === 'chicken thigh' || x[0] === 'chicken drumsticks' || x[0] === 'turkey mince')) return 'chicken';
  return 'veg';
}

// Picks `count` dishes from `pool` for the eaters, with variety, avoiding `recent` names.
function pick(pool, count, eaters, house, rnd, recent) {
  const scored = pool.map(d => ({ d, s: score(d, eaters, house, rnd) - (recent.has(d.name) ? 6 : 0) }))
    .sort((a, b) => b.s - a.s);
  const out = [];
  const mains = {};
  for (const { d } of scored) {
    if (out.length >= count) break;
    const m = mainOf(d);
    const cap = m === 'red' ? 3 : m === 'veg' ? 4 : 3;
    if ((mains[m] || 0) >= cap) continue;
    out.push(d);
    mains[m] = (mains[m] || 0) + 1;
  }
  // Not enough variety allowed: fill up with the best of the rest, then repeat.
  for (const { d } of scored) if (out.length < count && !out.includes(d)) out.push(d);
  while (out.length && out.length < count) out.push(out[out.length % Math.max(1, out.length)]);
  return out;
}

// Puts dinners in an order that doesn't have the same main two nights running, with the
// slow and fiddly ones at the weekend.
function arrange(dishes) {
  const left = dishes.slice().sort((a, b) => a.minutes - b.minutes);
  const out = [];
  while (left.length) {
    const prev = out.length ? mainOf(out[out.length - 1]) : null;
    const weekend = out.length >= 5;
    let i = left.findIndex(d => mainOf(d) !== prev && (weekend || d.minutes <= 45));
    if (i < 0) i = left.findIndex(d => mainOf(d) !== prev);
    if (i < 0) i = 0;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exercise
// ---------------------------------------------------------------------------

function exerciseFor(p, r, rnd) {
  const a = p.answers || {};
  const equipment = new Set(list(a.equipment));
  const gentle = ['Low energy or chronic fatigue', 'Chronic pain'].some(x => r.support.has(x));
  const seated = r.support.has('Use a wheelchair or mobility aid');
  const pregnant = r.conditions.has('Pregnant or breastfeeding');
  const likes = String(a.exercise_likes || '').toLowerCase();
  const minutes = { 'Less than 15 minutes': 10, '15 to 30 minutes': 20, '30 to 60 minutes': 30, 'More than an hour': 45 }[a.exercise_time] || 20;
  const level = seated ? 'seated' : equipment.has('Gym membership') ? 'gym' : equipment.has('Dumbbells') ? 'dumbbells' : equipment.has('Resistance bands') ? 'bands' : 'none';
  let cardio = seated ? 'Seated cardio or a push/wheel' : 'Walk';
  if (!seated && (equipment.has('Pool') && /swim/.test(likes))) cardio = 'Swim';
  else if (!seated && (equipment.has('Exercise bike') || equipment.has('Bike')) && /bike|cycl|ride/.test(likes)) cardio = 'Ride';
  else if (!seated && /dance/.test(likes)) cardio = 'Dance or walk';

  const medical = [];
  const injuries = String(a.injuries || '').trim();
  const gp = String(a.gp || '').trim();
  const medicines = String(a.medicines || '').trim();
  if (injuries && !/^(no|none|nil|n\/a)\.?$/i.test(injuries)) medical.push('You mentioned: “' + injuries.slice(0, 300) + '”. Consider checking with your GP or physio which exercises suit you, and stop any exercise that causes pain.');
  if (gp && !/^(no|none|nil|n\/a)\.?$/i.test(gp)) medical.push('You said a doctor or dietitian told you: “' + gp.slice(0, 300) + '”. What they told you comes first. If this plan doesn’t fit it, go with what they said and let an admin know.');
  if (medicines && !/^(no|none|nil|n\/a)\.?$/i.test(medicines)) medical.push('You mentioned medicines or supplements: “' + medicines.slice(0, 200) + '”. It may be worth asking your pharmacist whether any foods or exercise affect them.');
  const C = {
    'Type 1 diabetes': 'You said you have type 1 diabetes. It may be worth checking with your diabetes team about insulin and carbs around exercise, and keeping fast-acting carbs with you during sessions.',
    'Type 2 diabetes or pre-diabetes': 'You said you have type 2 diabetes or pre-diabetes. Short walks after meals may help. If you take medicine that can cause low blood sugar, consider asking your GP about exercise.',
    'High blood pressure': 'You said you have high blood pressure. Consider breathing out as you lift rather than holding your breath, and checking with your GP before heavy lifting.',
    'Heart condition': 'You said you have a heart condition. It may be worth checking with your GP or cardiologist before starting, and stopping if you feel chest pain, dizziness or unusual breathlessness.',
    'Kidney condition': 'You said you have a kidney condition. Protein, salt and fluid needs can differ, so consider checking this plan with your doctor or dietitian.',
    'Pregnant or breastfeeding': 'You said you’re pregnant or breastfeeding. Consider checking with your midwife or GP before new exercise. This plan keeps to walking and gentle strength.',
  };
  for (const c of r.conditions) if (C[c]) medical.push(C[c]);
  for (const m of r.meds) if (MEDS[m] && MEDS[m].exercise) medical.push(MEDS[m].exercise);
  if (r.meds.size) medical.push('Because you take medicines, consider checking this exercise plan with your GP before you start.');
  if (gentle) medical.push('You mentioned low energy or chronic pain. On harder days, consider a shorter session or just a walk. Any movement counts.');

  const notes = [
    'If a session feels too hard, do less rather than skipping it.',
    'Warm up for 5 minutes first. You should be able to talk during walks.',
    'Sore muscles a day or two after a new exercise are normal. Sharp pain isn’t: stop and get it checked.',
  ];

  const weeks = [];
  if (r.kid) {
    for (let w = 0; w < 4; w++) {
      weeks.push({
        focus: 'Move every day', targets: ['About 60 minutes of active play a day, counting school and sport', 'Less screen time on school nights'],
        days: DAYS.map(day => ({ day, session: day === 'Sat' || day === 'Sun' ? 'Active play: park, bike, swim or sport' : 'Active play after school' })),
      });
    }
    return { weeks, top: { notes: ['Play counts: running around, riding, swimming, dancing and sport all count.', 'Kids don’t need diets or weigh-ins. Plenty of play and regular meals is the goal.'], medical } };
  }
  const plan = gentle || pregnant
    ? [[1, 3], [2, 3], [2, 4], [2, 4]]
    : r.teen ? [[2, 3], [2, 3], [2, 4], [2, 4]]
    : [[2, 3], [2, 4], [3, 4], [3, 5]];
  const strengthDays = { 1: ['Wed'], 2: ['Mon', 'Thu'], 3: ['Mon', 'Wed', 'Fri'] };
  const cardioOrder = ['Tue', 'Sat', 'Thu', 'Mon', 'Wed', 'Fri'];
  const focus = ['Build the habit', 'A little more', 'Step it up', 'Keep it going'];
  for (let w = 0; w < 4; w++) {
    const [s, c] = plan[w];
    const sDays = strengthDays[s];
    const mins = minutes + (minutes >= 20 ? w * 5 : 0);
    const cDays = cardioOrder.filter(d => !sDays.includes(d)).slice(0, c);
    let ab = 0;
    weeks.push({
      focus: focus[w],
      targets: [s + ' strength session' + (s > 1 ? 's' : ''), c + ' × ' + cardio.toLowerCase() + ' ' + mins + ' minutes', 'A few more steps each day than last week'],
      days: DAYS.map(day => {
        const o = { day };
        if (sDays.includes(day)) o.strength = 'Strength ' + (w < 2 ? '1' : '2') + (ab++ % 2 ? 'B' : 'A');
        if (cDays.includes(day)) o.cardio = cardio + ' ' + mins + ' minutes';
        if (day === 'Sun') o.mobility = 'Rest, or a gentle stretch';
        return o;
      }),
    });
  }
  const made = strengthWorkouts(p, r, { level, gentle, pregnant, seated, injuries: injuries + ' ' + gp }, rnd || Math.random);
  if (made.note) notes.push(made.note);
  return { weeks, top: { workouts: made.workouts, notes, medical } };
}

// Words in someone's injuries (or what their doctor said) -> exercise flags to leave out.
// Whole words only ("discussed" isn't a disc, "beforehand" isn't a hand), and not when just
// before it they said it's fine ("no knee problems"). Hips have no flag of their own, so they
// leave out the deep knee-bend moves (squats and lunges), which load the hips too.
const INJURY_FLAGS = [
  [/\b(knees?|acl|menisc\w*|patell\w*)\b/g, ['knees'], 'knees'],
  [/\b(hips?|hip replacement)\b/g, ['knees'], 'hips'],
  [/\b(spine|spinal|discs?|sciatica|lumbar|(?:lower|upper|bad|sore|injured|hurt|weak) back|back (?:pain|injur\w*|problems?|issues?|surgery|spasms?))\b/g, ['back'], 'back'],
  [/\b(shoulders?|rotator)\b/g, ['shoulders'], 'shoulders'],
  [/\b(wrists?|carpal|thumbs?|hands?)\b/g, ['wrists'], 'wrists or hands'],
  [/\b(balance|falls?|fell|dizz\w*|vertigo)\b/g, ['balance'], 'balance'],
];
const NOT_A_PROBLEM = /\b(no|not|never|without|none|don['’]?t|haven['’]?t|isn['’]?t)\b(\s+\S+){0,2}\s*$/;
// Whether a pattern is mentioned as a problem somewhere in the text.
function mentions(re, text) {
  re.lastIndex = 0;
  for (let m; (m = re.exec(text));) if (!NOT_A_PROBLEM.test(text.slice(0, m.index))) return true;
  return false;
}

// Which exercises suit someone: {usable(e), why: [body parts mentioned]}. `o` has seated,
// pregnant and injuries (their injuries and what their doctor said).
function exerciseRules(p, o) {
  // What they can use: bodyweight always; bands and dumbbells if they have them; all of it at a gym.
  const equip = new Set(list((p.answers || {}).equipment));
  const gym = equip.has('Gym membership');
  const have = new Set(['none']);
  if (gym || equip.has('Resistance bands')) have.add('bands');
  if (gym || equip.has('Dumbbells')) have.add('dumbbells');
  if (gym) have.add('gym');

  const skip = new Set();
  const why = [];
  const text = String(o.injuries || '').toLowerCase();
  for (const [re, flags, words] of INJURY_FLAGS) if (mentions(re, text)) { flags.forEach(f => skip.add(f)); why.push(words); }
  // Pregnant (and not exercising seated): bodyweight only, as the medical note says, and nothing lying flat.
  if (o.pregnant) {
    ['supine', 'prone', 'impact'].forEach(f => skip.add(f));
    if (!o.seated) { have.clear(); have.add('none'); }
  }
  const disliked = new Set(Array.isArray(p.avoid) ? p.avoid : []);
  const usable = e => have.has(e.equipment) && !disliked.has(e.id)
    && !e.flags.some(f => skip.has(f)) && (!o.seated || e.flags.includes('seated'));
  return { usable, why };
}

// The ids of the exercises that suit a person ({answers, avoid}), for swapping one in their plan.
// Sitting-only ones are left out unless they exercise seated.
function exerciseFits(p) {
  const r = rulesFor(p);
  const a = p.answers || {};
  const o = {
    seated: r.support.has('Use a wheelchair or mobility aid'),
    pregnant: r.conditions.has('Pregnant or breastfeeding'),
    injuries: String(a.injuries || '') + ' ' + String(a.gp || ''),
  };
  const { usable } = exerciseRules(p, o);
  return EXERCISES.filter(e => usable(e) && (o.seated || !e.flags.includes('chair'))).map(e => e.id);
}

// Two strength workouts (A and B) for weeks 1 and 2, and a harder pair for weeks 3 and 4, picked
// from exercises.json to suit the person's equipment, injuries, pregnancy, mobility and dislikes.
// Returns {workouts, note}.
function strengthWorkouts(p, r, o, rnd) {
  const { usable, why } = exerciseRules(p, o);
  const best = o.level === 'seated' ? 'none' : o.level;
  const caps = (o.gentle || o.pregnant || o.seated || r.teen) ? [1, 2] : [2, 3];
  const used = new Set();

  // The best exercise of a type for a level cap: close to the cap, the person's own equipment
  // first, something not used yet, with a little randomness so plans differ. One level harder
  // is allowed when nothing else fits. Sitting-only exercises are for people who exercise seated,
  // or a last resort (`chair`).
  function choose(type, cap, chair) {
    const pool = EXERCISES.filter(e => e.type === type && e.level <= cap + 1 && usable(e)
      && (o.seated || chair || !e.flags.includes('chair')));
    if (!pool.length) return null;
    let top = null, topScore = -Infinity;
    for (const e of pool) {
      const score = (e.level > cap ? -3 : e.level) + (e.equipment === best ? 1.5 : 0) - (used.has(e.id) ? 3 : 0) + rnd() * 1.2;
      if (score > topScore) { top = e; topScore = score; }
    }
    used.add(top.id);
    return top;
  }
  const FALLBACK = { lunge: 'squat', calf: 'balance' };
  const pickFor = (type, cap) => choose(type, cap) || (FALLBACK[type] && choose(FALLBACK[type], cap)) || choose(type, cap, true);
  const line = (e, twoSets) => e.name + ' (' + (twoSets ? e.dose.replace(/^3 ×/, '2 ×') : e.dose) + '): ' + e.how;
  const byId = id => EXERCISES.find(e => e.id === id);

  const warm = o.seated ? [byId('seated-warm-up')] : [byId('march-on-the-spot'), byId('arm-circles-and-leg-swings')];
  const coolPool = EXERCISES.filter(e => e.type === 'mobility' && usable(e) && !e.flags.includes('floor'));
  const cool = o.seated ? [byId('seated-stretches')] : coolPool.slice(0, 3);
  const SLOTS = {
    A: ['squat', 'push', 'hinge', 'pull', 'core'],
    B: ['lunge', 'pull', 'push', 'hinge', o.seated ? 'arms' : 'calf', 'core'],
  };
  const workouts = [];
  [0, 1].forEach(block => {
    const cap = caps[block];
    ['A', 'B'].forEach(letter => {
      const picked = [];
      for (const type of SLOTS[letter]) {
        const e = pickFor(type, cap);
        if (e) picked.push(e);
      }
      const minutes = Math.round((8 + picked.length * 5 + (o.seated ? 3 : 5)) / 5) * 5;
      workouts.push({
        name: 'Strength ' + (block + 1) + letter + ': ' + picked.slice(0, 3).map(e => e.name.toLowerCase()).join(', ') + ' (weeks ' + (block ? '3 and 4' : '1 and 2') + ')',
        time: 'About ' + minutes + ' minutes',
        items: [].concat(
          warm.filter(Boolean).map(e => 'Warm-up: ' + line(e)),
          picked.map(e => line(e, block === 0 && o.gentle)),
          cool.filter(Boolean).map(e => 'Cool-down: ' + line(e)),
        ),
      });
    });
  });
  const note = why.length
    ? 'You mentioned your ' + why.join(' and ') + ', so the exercises that put the most load there are left out. Swap anything that still doesn’t feel right from the Exercise library.'
    : '';
  return { workouts, note };
}

// ---------------------------------------------------------------------------
// Building the plan
// ---------------------------------------------------------------------------

function build(people, opts) {
  const local = useCountry(opts && opts.country, opts && opts.locale);
  const rnd = random(opts && opts.seed || Date.now());
  const rules = people.map(rulesFor);
  rules.forEach((r, i) => { r.portion = portionFor(people[i], r); });
  const adults = rules.filter(r => !r.kid);
  const budgets = rules.map(r => r.budget).filter(Boolean);
  const house = {
    hard: new Set(rules.flatMap(r => [...r.hard])),
    cookLimit: Math.min(...rules.filter(r => r.cooks && r.cookLimit).map(r => r.cookLimit), Infinity),
    kitchen: new Set(rules.flatMap(r => [...r.kitchen])),
    budget: budgets.length ? Math.min(...budgets) : null,
    costWeight: 0.6,
  };
  if (house.cookLimit === Infinity) house.cookLimit = null;
  const repeat = rules.some(r => r.help.has('Eating the same meals often (fewer decisions)') || r.sensory.has('A brand or recipe changing'));
  const forAdmin = [];

  let plan, tries = 0;
  do {
    plan = attempt(people, rules, house, rnd, repeat, forAdmin);
    tries++;
    const weekly = plan.weeks.reduce((n, w) => n + w.cost, 0) / 4;
    if (!house.budget || weekly <= house.budget * 1.1 || tries >= 4) {
      if (house.budget && weekly > house.budget * 1.1) forAdmin.push('The cheapest plan that fits everyone’s needs is about ' + priceText(weekly) + ' a week, over the ' + priceText(house.budget) + ' budget from About me. Swapping a couple of meat dinners for vegetarian ones would bring it down.');
      break;
    }
    house.costWeight *= 2.5;
    forAdmin.length = 0;
  } while (true);
  if (!adults.length) forAdmin.push('Everyone in the plan is a child, so portions are child-sized. Add the adults to the family for a full plan.');
  if (local && local.words) plan = reword(plan, PRICES.words[local.words]);
  return { plan, notesForAdmin: forAdmin.join(' ') };
}

// When no breakfast (or lunch) in the library suits the family, the plan says "your own choice"
// for that meal instead of failing, and tells the admin. Returns the dishes, or that one stand-in.
function orOwnChoice(dishes, meal, forAdmin) {
  if (dishes.length) return dishes;
  if (forAdmin) forAdmin.push('No ' + meal + ' in the app’s library suits everyone’s allergies and diets, so ' + meal + ' is left to each person’s own choice. You can add one in Edit plan.');
  return [{ name: 'Your own choice of ' + meal, meal, ownChoice: true, per: [], tags: [], kit: [], steps: [], minutes: 0,
    macros: { p: 0, c: 0, f: 0, kj: 0 }, groups: {}, cost: 0 }];
}

// One try at a whole plan: picks dinners, lunches, breakfasts and snacks for each week, makes the
// recipes and shopping lists, and adds exercise. build() calls this again (cheaper) if it's over budget.
function attempt(people, rules, house, rnd, repeat, forAdmin) {
  const byMeal = m => LIB.dishes.filter(d => d.meal === m && available(d) && canCook(d, house) && !(d.tags || []).some(t => house.hard.has(t)));
  const dinners = byMeal('dinner');
  const lunches = byMeal('lunch');
  const breakfasts = byMeal('breakfast');
  const everyone = d => rules.every(r => allowed(d, r));
  const shared = dinners.filter(everyone);
  // Family dinners are chosen from everything nobody is allergic to; the score prefers dinners that
  // suit everyone, and anyone a dinner doesn't suit gets their own that night.
  const familyPool = dinners.filter(d => rules.some(r => allowed(d, r)));
  const recent = new Set();
  const used = new Map();     // dish name -> dish, for recipes, macros and groups
  const notes = [];
  if (shared.length < 4) forAdmin.push('Only ' + shared.length + ' dinners in the app’s library suit everyone, so some nights have a separate dinner for someone.');

  const mealWeeks = [];
  let fixedDinners = null;
  for (let w = 0; w < 4; w++) {
    // Dinners for the week.
    let week;
    if (repeat && fixedDinners && w % 2 === 1) week = fixedDinners;
    else {
      const n = repeat ? 4 : 7;
      week = pick(familyPool.length ? familyPool : dinners, n, rules, house, rnd, recent);
      if (repeat) week = DAYS.map((_, i) => week[i % week.length]);
      week = repeat ? week : arrange(week);
      fixedDinners = week;
    }
    week.forEach(d => recent.add(d.name));
    // Breakfasts: three that suit everyone, rotated.
    const bShared = breakfasts.filter(everyone);
    const bPick = orOwnChoice(pick(bShared.length ? bShared : breakfasts, 3, rules, house, rnd, new Set()), 'breakfast', w ? null : forAdmin);
    // Lunches at home (adults): two that suit everyone, plus leftovers.
    const lShared = lunches.filter(everyone);
    const lPick = orOwnChoice(pick(lShared.length ? lShared : lunches, 2, rules.filter(r => !r.kid), house, rnd, new Set()), 'lunch', w ? null : forAdmin);

    const days = DAYS.map((day, i) => {
      const dinner = week[i];
      const breakfast = bPick[i % bPick.length];
      const prev = i > 0 ? week[i - 1] : null;
      const lunch = prev && prev.leftovers && ['Tue', 'Thu', 'Sat'].includes(day) ? { leftover: prev } : lPick[i % lPick.length];
      return { day, dinner, breakfast, lunch };
    });
    mealWeeks.push(days);
  }

  // Per-person swaps: anyone a shared dish doesn't suit gets one that does.
  const own = {};   // person key -> {dinner: [dishes], breakfast, lunch}
  for (const r of rules) {
    const myDinners = dinners.filter(d => allowed(d, r));
    const myBreakfasts = breakfasts.filter(d => allowed(d, r));
    const myLunches = lunches.filter(d => allowed(d, r));
    own[r.key] = {
      dinners: pick(myDinners, 7, [r], house, rnd, new Set()),
      breakfast: myBreakfasts.length ? pick(myBreakfasts, 1, [r], house, rnd, new Set())[0] : null,
      lunches: myLunches.filter(d => !r.kid || d.packable),
    };
    if (!myDinners.length) forAdmin.push('No dinners in the library suit ' + r.name + '’s needs. Their meals will need adding by hand in Edit plan.');
  }

  const planPeople = {};
  for (let i = 0; i < people.length; i++) {
    const p = people[i], r = rules[i];
    planPeople[p.key] = Object.assign({}, { name: p.name, portion: r.portion });
  }

  const weeks = [];
  const exercise = {};
  const topExercise = {};
  people.forEach((p, i) => {
    const ex = exerciseFor(p, rules[i], rnd);
    exercise[p.key] = ex.weeks;
    topExercise[p.key] = ex.top;
  });

  // Each week's meals, recipes and the amounts to buy.
  const needs = [];   // per meal week: {ingredient key: amount}
  mealWeeks.forEach((days, w) => {
    const need = {};
    const addNeed = (dish, serves) => {
      for (const [k, amount] of dish.per) {
        const ing = ING[k];
        if (ing.aisle === 'assumed') continue;
        need[k] = (need[k] || 0) + amount * serves;
      }
    };
    const cooked = new Map();   // dish name -> total serves this week (for the recipe)
    const addCooked = (d, serves) => cooked.set(d.name, (cooked.get(d.name) || 0) + serves);
    const meals = days.map((day, i) => {
      const m = { day: day.day };
      const overrides = {};
      // Breakfast.
      let bServes = 0;
      rules.forEach(r => {
        if (allowed(day.breakfast, r)) bServes += r.portion;
        else if (own[r.key].breakfast) {
          overrides[r.key] = Object.assign(overrides[r.key] || {}, { breakfast: own[r.key].breakfast.name });
          addNeed(own[r.key].breakfast, r.portion); addCooked(own[r.key].breakfast, r.portion); used.set(own[r.key].breakfast.name, own[r.key].breakfast);
        }
      });
      m.breakfast = day.breakfast.name;
      if (!day.breakfast.ownChoice) { addNeed(day.breakfast, bServes); addCooked(day.breakfast, bServes); used.set(day.breakfast.name, day.breakfast); }
      // Dinner (and extra for tomorrow's leftovers).
      let dServes = 0;
      rules.forEach(r => {
        if (allowed(day.dinner, r)) dServes += r.portion;
        else if (own[r.key].dinners.length) {
          const alt = own[r.key].dinners[i % own[r.key].dinners.length];
          overrides[r.key] = Object.assign(overrides[r.key] || {}, { dinner: alt.name });
          addNeed(alt, r.portion); addCooked(alt, r.portion); used.set(alt.name, alt);
        }
      });
      m.dinner = day.dinner.name;
      used.set(day.dinner.name, day.dinner);
      const tomorrow = days[i + 1];
      const leftoverFor = tomorrow && tomorrow.lunch.leftover === day.dinner ? rules.filter(r => !r.kid && allowed(day.dinner, r)) : [];
      const extra = leftoverFor.reduce((n, r) => n + r.portion, 0);
      addNeed(day.dinner, dServes + extra); addCooked(day.dinner, dServes + extra);
      if (extra) m.note = 'Cook extra tonight: pack ' + (leftoverFor.length === 1 ? 'a serve' : leftoverFor.length + ' serves') + ' for tomorrow’s lunch.';
      if (day.dinner.kit.includes('slow cooker')) m.note = 'Start the slow cooker this morning.' + (m.note ? ' ' + m.note : '');
      if (tomorrow && tomorrow.breakfast.name === 'Overnight oats with berries') m.note = (m.note ? m.note + ' ' : '') + 'Make tomorrow’s overnight oats tonight.';
      // Lunch.
      if (day.lunch.leftover) {
        m.lunch = 'Leftovers: ' + day.lunch.leftover.name;
        used.set(m.lunch, Object.assign({}, day.lunch.leftover, { name: m.lunch, leftoverOf: day.lunch.leftover.name }));
        rules.forEach(r => {
          if (r.kid && ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(day.day)) return;   // school lunch, below
          if (!allowed(day.lunch.leftover, r) || r.kid) {
            const alt = own[r.key].lunches[i % Math.max(1, own[r.key].lunches.length)];
            if (alt) {
              overrides[r.key] = Object.assign(overrides[r.key] || {}, { lunch: alt.name });
              addNeed(alt, r.portion); addCooked(alt, r.portion); used.set(alt.name, alt);
            }
          }
        });
      } else {
        m.lunch = day.lunch.name;
        if (!day.lunch.ownChoice) used.set(day.lunch.name, day.lunch);
        let lServes = 0;
        rules.forEach(r => {
          if (r.kid && ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(day.day)) return;
          if (allowed(day.lunch, r)) lServes += r.portion;
          else {
            const alt = own[r.key].lunches[i % Math.max(1, own[r.key].lunches.length)];
            if (alt) {
              overrides[r.key] = Object.assign(overrides[r.key] || {}, { lunch: alt.name });
              addNeed(alt, r.portion); addCooked(alt, r.portion); used.set(alt.name, alt);
            }
          }
        });
        if (!day.lunch.ownChoice) { addNeed(day.lunch, lServes); addCooked(day.lunch, lServes); }
      }
      if (Object.keys(overrides).length) m.people = overrides;
      return m;
    });

    // Children's school lunches and snacks (Mon to Fri), the same each week.
    rules.filter(r => r.kid).forEach(r => {
      const p = planPeople[r.key];
      if (!p.weekday) {
        const packs = own[r.key].lunches.filter(d => d.packable);
        const kidSnacks = LIB.snacks.filter(s => s.kids && available(s) && allowed(s, r));
        p.weekday = {};
        DAYS.slice(0, 5).forEach((d, i) => {
          const l = packs[i % Math.max(1, packs.length)];
          const s = kidSnacks[i % Math.max(1, kidSnacks.length)];
          p.weekday[d] = {};
          if (l) { p.weekday[d].lunch = l.name; used.set(l.name, l); }
          if (s) p.weekday[d].snack = s.what;
        });
      }
      DAYS.slice(0, 5).forEach(d => {
        const wd = p.weekday[d];
        const l = wd.lunch && LIB.dishes.find(x => x.name === wd.lunch);
        if (l) { addNeed(l, r.portion); addCooked(l, r.portion); }
        const s = wd.snack && LIB.snacks.find(x => x.what === wd.snack);
        if (s) addNeed(s, 1);
      });
    });

    // Recipes for every dish cooked this week, with amounts for everyone eating it.
    const recipes = [];
    for (const [name, serves] of cooked) {
      const d = used.get(name) || LIB.dishes.find(x => x.name === name);
      if (!d || d.leftoverOf || !serves) continue;
      recipes.push(recipeFor(d, serves, meals));
    }
    weeks.push({ name: 'Week ' + (w + 1), meals, recipes, exercise: Object.fromEntries(people.map(p => [p.key, exercise[p.key][w]])) });
    needs.push(need);
  });

  // Snacks: the same for every week, per person.
  for (let i = 0; i < people.length; i++) {
    const r = rules[i];
    const p = planPeople[people[i].key];
    p.snacks = snacksFor(r, exercise[people[i].key]);
    for (let w = 0; w < 4; w++) {
      const exWeek = exercise[people[i].key][w];
      for (const s of p.snacks) {
        const lib = LIB.snacks.find(x => x.what === s.what);
        if (!lib) continue;
        const days = DAYS.filter(d => {
          if (s.days && !s.days.includes(d)) return false;
          const exDay = exWeek.days.find(x => x.day === d) || {};
          if (s.exercise === 'strength') return !!exDay.strength;
          if (s.exercise === 'rest') return !exDay.strength;
          return true;
        }).length;
        for (const [k, amount] of lib.per) if (LIB.ingredients[k].aisle !== 'assumed') needs[w][k] = (needs[w][k] || 0) + amount * days * (s.optional ? 0.5 : 1);
      }
    }
    Object.assign(p, guideFor(r, people[i]));
  }

  // Shopping: buy in whole packs, carrying over what keeps.
  const shopping = shoppingFor(needs);
  const plan = { weeks: [] };
  for (let f = 0; f < 2; f++) {
    plan.weeks.push({ name: 'Stock-up ' + (f + 1), kind: 'stockup', shopping: shopping.stock[f] });
    for (let k = 0; k < 2; k++) {
      const w = weeks[f * 2 + k];
      w.shopping = shopping.weekly[f * 2 + k];
      plan.weeks.push(w);
    }
  }
  plan.weeks.forEach(w => {
    let sum = 0;
    Object.values(w.shopping).forEach(items => items.forEach(it => { sum += it[1]; }));
    w.cost = money(sum);
  });

  // Macros and food groups for every dish and snack used.
  const macros = {}, groups = {};
  for (const [name, d] of used) { macros[name] = d.macros; groups[name] = d.groups; }
  for (const p of Object.values(planPeople)) {
    for (const s of p.snacks || []) {
      const lib = LIB.snacks.find(x => x.what === s.what);
      if (lib) { macros[s.what] = lib.macros; groups[s.what] = lib.groups; }
    }
    for (const wd of Object.values(p.weekday || {})) {
      const lib = wd.snack && LIB.snacks.find(x => x.what === wd.snack);
      if (lib) { macros[wd.snack] = lib.macros; groups[wd.snack] = lib.groups; }
    }
  }

  const today = new Date();
  const stamp = today.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  plan.id = 'family-plan-built-' + stamp;
  plan.title = 'Meal and exercise plan';
  const f1 = plan.weeks.slice(0, 3).reduce((n, w) => n + w.cost, 0);
  const f2 = plan.weeks.slice(3, 6).reduce((n, w) => n + w.cost, 0);
  plan.subtitle = 'Built by the app from everyone’s answers. Fortnight 1 about ' + priceText(f1) + ', fortnight 2 about ' + priceText(f2) + '. Prices are estimates.';
  plan.currency = CURRENCY;
  plan.people = planPeople;
  plan.exercise = topExercise;
  plan.macros = macros;
  plan.groups = groups;
  return plan;
}

// A recipe in the plan's format, with amounts for `serves` average serves.
function recipeFor(d, serves, meals) {
  const items = [];
  const ingredients = [];
  for (const [k, amount] of d.per) {
    const ing = LIB.ingredients[k];
    if (ing.aisle === 'assumed') continue;
    const label = labelOf(k);
    let q, l, whole;
    if (k === 'garlic') {
      q = Math.max(1, Math.round(amount * serves * 10)); l = q === 1 ? 'clove garlic' : 'cloves garlic'; whole = 1;
    } else if (ing.unit === 'each') {
      const raw = amount * serves;
      q = k === 'egg' || k === 'wraps' || k === 'rolls' || k === 'pita' ? Math.max(1, Math.round(raw)) : Math.max(0.5, round(raw, 0.5));
      l = label.each; whole = 1;
    } else {
      const raw = amount * serves;
      q = raw >= 40 ? round(raw, 5) : Math.max(1, Math.round(raw));
      l = (ing.unit === 'ml' ? 'ml ' : 'g ') + label.name; whole = 0;
    }
    items.push({ q, l, i: whole });
    ingredients.push(q + (whole ? ' ' : ' ') + l);
  }
  const days = meals.filter(m => m.dinner === d.name || m.lunch === d.name || m.breakfast === d.name).map(m => m.day);
  const r = {
    name: d.name,
    makes: (Math.round(serves * 10) / 10) + ' average serves' + (days.length > 1 ? ' across ' + days.join(', ') : ''),
    ingredients,
    items,
    units: Math.round(serves * 100) / 100,
    steps: d.steps,
    pantry: d.per.some(x => x[0] === 'oil') ? ['olive oil', 'salt and pepper'] : ['salt and pepper'],
  };
  if (days.length > 1) r.others = ['Made on ' + days.join(', ') + ': the amounts above are for all of them together.'];
  if (d.kid) r.kid = d.kid;
  if (d.separate) r.others = (r.others || []).concat('Easy to serve with the parts separate.');
  return r;
}

const EACH = { egg: 'eggs', tomato: 'tomatoes', wraps: 'wraps', rolls: 'bread rolls', pita: 'Lebanese breads', avocado: 'avocados',
  lemon: 'lemons', lettuce: 'cos lettuces', cucumber: 'Lebanese cucumbers', capsicum: 'red capsicums', zucchini: 'zucchinis',
  broccoli: 'heads of broccoli', celery: 'half bunches of celery', cauliflower: 'cauliflowers', 'spring onion': 'bunches of spring onions' };

// The name and counting word for an ingredient in a recipe ("tomato", "tomatoes").
function labelOf(k) {
  return { name: k.replace(/ big$/, '').replace('stock', 'stock').replace('veg stock', 'vegetable stock'), each: EACH[k] || k };
}

// Two snacks a day for each person, tied to exercise where it helps.
function snacksFor(r, exWeeks) {
  const ok = LIB.snacks.filter(s => available(s) && allowed(s, r) && (!r.kid || s.kids));
  const by = kind => ok.filter(s => s.kind === kind);
  const protein = by('protein'), fruit = by('fruit'), other = by('other').concat(by('veg'));
  const out = [];
  const lifts = exWeeks.some(w => w.days.some(d => d.strength));
  if (r.kid) {
    if (fruit[0]) out.push({ when: 'After school', what: fruit[0].what, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] });
    if (other[0] || fruit[1]) out.push({ when: 'Afternoon', what: (other[0] || fruit[1]).what, days: ['Sat', 'Sun'] });
    return out;
  }
  if (fruit[0]) out.push({ when: 'Mid-morning', what: fruit[0].what });
  if (lifts && protein.length) {
    out.push({ when: 'After strength', what: protein.find(s => /milk|yoghurt/.test(s.what))?.what || protein[0].what, exercise: 'strength' });
    const rest = other[0] || fruit[1] || protein[1];
    if (rest) out.push({ when: 'Afternoon', what: rest.what, exercise: 'rest' });
  } else {
    const s = protein[0] || other[0];
    if (s) out.push({ when: 'Afternoon', what: s.what });
  }
  return out;
}

// The person's guide paragraph and tips.
function guideFor(r, p) {
  const bits = [];
  if (r.kid) bits.push('Child-sized serves (about ' + Math.round(r.portion * 100) + '% of an adult serve). Children aren’t put on diets: regular meals and plenty of play is the goal.');
  else if (Math.abs(r.portion - 1) >= 0.05) bits.push('Serves are about ' + Math.round(Math.abs(r.portion - 1) * 100) + '% ' + (r.portion > 1 ? 'bigger' : 'smaller') + ' than average, worked out from your age, size, activity and goal.');
  else bits.push('Serves are about average for your age, size, activity and goal.');
  const left = [...r.hard].map(t => ALLERGY_WORDS[t] || t);
  if (left.length) bits.push('Your meals leave out ' + left.join(', ') + '. Check labels too.');
  if (r.diet.has('meat') && r.diet.has('animal')) bits.push('All your meals are vegan.');
  else if (r.diet.has('meat') && r.diet.has('fish')) bits.push('All your meals are vegetarian.');
  else if (r.diet.has('meat')) bits.push('Your meals have no meat (fish is fine).');
  const tips = [];
  tips.push(...r.notes);
  if (r.sensory.has('Foods touching on the plate')) tips.push('Many dinners are easy to serve with the parts separate: the recipe says so.');
  if (r.help.has('Eating the same meals often (fewer decisions)') || r.sensory.has('A brand or recipe changing')) tips.push('Your weeks repeat a few dinners, so there are fewer decisions.');
  if (r.help.has('Ready-to-eat options for low-energy days')) tips.push('On a low-energy day, a sandwich, Weet-Bix or cheese and crackers is a fine dinner.');
  if (r.help.has('Cooking a batch on a good day')) tips.push('Dinners that freeze well (chilli, bolognese, curries, soups) can be doubled on a good day.');
  const safe = String((p.answers || {}).safe_foods || '').trim();
  if (safe) tips.push('Your safe foods (' + safe.slice(0, 120) + ') are kept in for hard days.');
  for (const m of r.meds) if (MEDS[m] && MEDS[m].food) tips.push(MEDS[m].food);
  if (r.conditions.has('Coeliac disease')) tips.push('You said you have coeliac disease: check every label for gluten, including sauces and stock.');
  if (r.conditions.has('Reflux')) tips.push('You mentioned reflux: smaller dinners earlier in the evening may help.');
  if (r.conditions.has('Irritable bowel (IBS)')) tips.push('You mentioned IBS: if some foods (like onion, garlic or beans) bother you, add them to “Foods you won’t eat” in About me and rebuild the plan.');
  tips.push('Drink water through the day.');
  return { guide: bits.join(' '), tips };
}

// The shopping lists: what each meal week needs, in whole packs. Pantry and freezer things go on
// the stock-up list before each fortnight. Leftover pack amounts carry over while they keep.
function shoppingFor(needs) {
  const weekly = needs.map(() => ({}));
  const stock = [{}, {}];
  const onHand = {};   // key -> [{amount, until (week index)}]
  const bought = needs.map(() => ({}));
  const stockBought = [{}, {}];
  needs.forEach((need, w) => {
    for (const [k, amount] of Object.entries(need)) {
      const ing = ING[k];
      if (!ing.pack) continue;
      let want = amount;
      const shelf = (onHand[k] || []).filter(x => x.until >= w);
      for (const x of shelf) {
        const use = Math.min(x.amount, want);
        x.amount -= use; want -= use;
      }
      onHand[k] = shelf.filter(x => x.amount > 0.01);
      if (want <= 0.01) continue;
      const packs = Math.ceil(want / ing.pack - 0.02);
      if (packs <= 0) continue;
      const keeps = KEEPS_ITEM[k] || KEEPS[ing.aisle] || 5;
      const longLife = ing.aisle === 'pantry' || ing.aisle === 'frozen';
      // Long-life things are bought on the stock-up before the fortnight, so they keep until its end.
      const until = longLife ? Math.max(w, 3) : w + Math.floor(keeps / 7);
      onHand[k].push({ amount: packs * ing.pack - want, until });
      if (longLife) stockBought[w < 2 ? 0 : 1][k] = (stockBought[w < 2 ? 0 : 1][k] || 0) + packs;
      else bought[w][k] = (bought[w][k] || 0) + packs;
    }
  });
  const toList = counts => {
    const out = {};
    for (const [k, packs] of Object.entries(counts)) {
      const ing = ING[k];
      const section = SECTION[ing.aisle];
      const name = ing.name + (packs > 1 ? ' × ' + packs : '');
      (out[section] = out[section] || []).push([name, money(ing.price * packs)]);
    }
    const ordered = {};
    for (const s of Object.values(SECTION)) if (out[s]) ordered[s] = out[s].sort((a, b) => a[0].localeCompare(b[0]));
    return ordered;
  };
  return { weekly: bought.map(toList), stock: stockBought.map(toList) };
}

// Gives the builder its data where require() isn't available (the phone app):
// {library: library.json, exercises: exercises.json, prices: library-prices.json}.
function useData(data) {
  LIB = data.library;
  EXERCISES = data.exercises.exercises || data.exercises;
  if (data.prices) PRICES = data.prices;
  ING = LIB.ingredients;
}

const PlanBuilder = {
  build, rulesFor, portionFor, allowed, exerciseFits, useData,
  get EXERCISES() { return EXERCISES; },
  get LIB() { return LIB; },
};
if (typeof module === 'object' && module.exports) module.exports = PlanBuilder;
else window.PlanBuilder = PlanBuilder;
