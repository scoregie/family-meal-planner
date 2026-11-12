// The built-in plan builder: makes a whole 4-week plan without AI, from everyone's About me
// answers and the meal library in library.json (built by tools/build_library.py).
//
// It works by rules, not judgement:
//   - Each person's answers become rules: allergies and diets (never broken), foods they won't eat,
//     textures and spice, cooking time, kitchen equipment, budget, and what they like.
//   - Shared family dinners are picked from the library to suit everyone where possible. Anyone a
//     dinner doesn't suit gets their own dinner that night instead.
//   - Portions come from age, size, activity and goal. Children are never given less to lose weight.
//   - Health comes before likes: everyone's days are topped up with vegetable sides and fruit until
//     they reach the guideline serves for their age and sex (healthtargets.js). What people find
//     hard to eat decides the form (soft, blended), and likes choose between dishes that fit.
//     Each person picks the pace in About me: from week 1, building up by week 3, or no change.
//   - Shopping lists add up every recipe's amounts for the people eating them, in whole packs.
//     Things that keep (pantry, freezer, cheese) carry over between weeks so nothing is bought twice.
//   - Food the family already has (the kitchen list on Plan setup, opts.pantry) is used first:
//     dishes that use it score higher, and what it covers is left off the shopping lists.
//   - Feedback counts: a meal someone scored well comes back more often for them and one they
//     scored poorly less often (each person's own scores, or the family's average, opts.rated).
//     Notes people wrote can't be read by rules, so they are passed on to the admin.
//   - Logged health numbers count: someone's latest logged weight is used in place of the one in
//     About me, and their average steps can lift their activity level.
//   - People who aren't keen on vegetables or fruit get one small new food to try each week,
//     a short step on from a food they already like ("small steps").
//   - Fresh food likely to be left at the end of a week is listed so it gets used up.
//   - Anyone who asked for eating reminders gets suggested eating times (ordinary ones to shift),
//     so the reminders on About me and the Meals tab have something to use.
//   - Fasting people already do is fitted around, never suggested. A daily fast (overnight, or
//     an eating window) keeps the same meals, with eating times inside the window. Set fast days
//     each week leave out the meals they go without. Weeks of fasting from sunrise to sunset keep
//     the same food, moved to before dawn and after sunset. Giving up some foods (like meat in
//     Lent) changes their meals on those days. Going without food isn't applied to under-18s.
//   - Supplements people already take add things to check, and an adult's protein powder is
//     counted as a snack in place of another one. The builder never suggests starting any.
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
// The vegetable and fruit serves to aim for, and how a plan measures up (healthtargets.js).
// The phone app loads healthtargets.js before this file, which puts it on window.
const TARGETS = ON_SERVER ? require('./healthtargets') : window.HealthTargets;

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

// Supplements people said they already take (About me). The plan never suggests starting one:
// it adds things to check, and counts an adult's protein powder as a snack so their day adds up.
// Supplements without an entry here share one general note (see supplementNotes).
const SUPPS = {
  'Creatine': {
    food: 'You said you take creatine. Drinking water through the day may help with it. Some people find it adds a little water weight in the first few weeks, which can show on the scales.',
  },
  'Pre-workout or caffeine tablets': {
    food: 'You said you use pre-workout or caffeine tablets. They add to the caffeine from coffee, tea and energy drinks, and later in the day they may affect sleep.',
    exercise: 'You said you use pre-workout or caffeine tablets. They can raise your heart rate, so consider going by how hard a session feels (you should be able to talk) rather than heart rate.',
  },
  'Electrolyte drinks or tablets': {
    food: 'You said you use electrolyte drinks or tablets. Some are high in salt or sugar, so the label may be worth a look. Water is often enough for sessions under an hour.',
  },
  'Meal replacement shakes': {
    food: 'You said you have meal replacement shakes. This plan has a meal in every slot and doesn’t count the shakes, so on a day a shake takes the place of a meal, the Macros tab will show more than you had. If a doctor or dietitian set them up, what they said comes first.',
  },
  'Fibre supplement': {
    food: 'You said you take a fibre supplement. Drinking water with it may help. Some medicines are taken a couple of hours apart from fibre, and your pharmacist can say what applies to you.',
  },
};

// An adult's own protein powder, written as a snack. The numbers are a typical 30 g scoop mixed
// with water; an admin can change them to match the tub on the Macros tab of Edit plan.
const SHAKE = 'Protein shake (1 scoop of your own powder)';
const SHAKE_MACROS = { p: 24, c: 2, f: 2, kj: 510 };
// The answers to "when do you usually have it?" -> how the snack is tied to their days.
const SHAKE_WHEN = { 'Every day': 'daily', 'On days I exercise': 'active', 'After strength training': 'strength', 'Now and then': 'sometimes' };

// A supplement's name as it reads in the middle of a sentence: "Vitamin D" -> "vitamin D",
// "Multivitamin" -> "a multivitamin".
function lowerFirst(name) {
  const text = name.charAt(0).toLowerCase() + name.slice(1);
  return name === 'Multivitamin' || name === 'Fibre supplement' ? 'a ' + text : text;
}

// A list as words: ["a", "b", "c"] -> "a, b and c".
function andList(items) {
  return items.length < 2 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1];
}

// The considerations for the supplements someone said they take: {food: [...], exercise: [...]}.
// Under-18s get one note and nothing is counted. Adults get a note for each supplement, plus
// extra ones where a supplement meets a condition or medicine they also listed.
function supplementNotes(r) {
  const food = [], exercise = [];
  if (!r.supps.size) return { food, exercise };
  const names = andList([...r.supps].map(lowerFirst));
  if (r.minor) {
    food.push('You said you take ' + names + '. This plan doesn’t count or plan around supplements for anyone under 18. If a GP or dietitian suggested them, what they said comes first. If not, it may be worth asking your GP about them.');
    return { food, exercise };
  }
  const has = s => r.supps.has(s);
  const cond = c => r.conditions.has(c);
  const med = m => r.meds.has(m);
  if (has('Protein powder')) {
    const counted = { daily: 'every day', active: 'on days you exercise', strength: 'after strength training' }[r.shake];
    if (counted) food.push('You said you have protein powder ' + counted + '. It’s in your snacks as one scoop mixed with water (about ' + SHAKE_MACROS.p + ' g of protein) and counted on the Macros tab, in place of another snack. If your tub’s label says something different, an admin can change the numbers in Edit plan.');
    else food.push('You said you have protein powder' + (r.shakeAnswered ? ' now and then' : '') + '. It’s listed as an optional snack and left out of your Macros totals.' + (r.shakeAnswered ? '' : ' To have it counted, say when you usually have it in About me and draft the plan again.'));
  }
  for (const s of r.supps) {
    if (SUPPS[s] && SUPPS[s].food) food.push(SUPPS[s].food);
    if (SUPPS[s] && SUPPS[s].exercise) exercise.push(SUPPS[s].exercise);
  }
  const general = [...r.supps].filter(s => s !== 'Protein powder' && !SUPPS[s]).map(lowerFirst);
  if (general.length) food.push('You said you take ' + andList(general) + '. Your pharmacist can say whether ' + (general.length > 1 ? 'any of these overlap' : 'it overlaps') + ' with anything else you take, and whether to take ' + (general.length > 1 ? 'them' : 'it') + ' apart from any medicines.');

  // Where a supplement meets a condition or medicine they also listed.
  const kidney = ['Protein powder', 'Creatine'].filter(has).map(lowerFirst);
  if (cond('Kidney condition') && kidney.length) food.push('You said you have a kidney condition and take ' + andList(kidney) + '. Protein needs can differ with kidney conditions, so it may be worth checking with your doctor or dietitian that ' + (kidney.length > 1 ? 'they suit' : 'it suits') + ' you.');
  if (has('Pre-workout or caffeine tablets') && (cond('High blood pressure') || cond('Heart condition') || med('Blood pressure or heart medicine') || med('ADHD stimulant medicine') || med('An MAOI antidepressant'))) {
    exercise.push('Pre-workout and caffeine tablets can raise heart rate and blood pressure. With what you said about your heart, blood pressure or medicines, it may be worth asking your GP or pharmacist whether they suit you.');
  }
  if (has('Electrolyte drinks or tablets') && (cond('High blood pressure') || cond('Heart condition') || cond('Kidney condition') || med('Blood pressure or heart medicine') || med('Fluid tablets (diuretics)'))) {
    food.push('Electrolyte drinks and tablets add salt, and some add potassium. With what you said about your blood pressure, heart, kidneys or medicines, it may be worth asking your GP or pharmacist about them.');
  }
  if (has('Fish oil') && med('Blood thinner (like warfarin)')) food.push('You said you take fish oil and a blood thinner. It may be worth asking your doctor or pharmacist about taking them together.');
  if ((has('Magnesium') || has('Multivitamin')) && med('Thyroid medicine')) food.push('Thyroid medicine is often taken a few hours apart from magnesium and from multivitamins with iron or calcium. Your pharmacist can say how to time them.');
  if (cond('Pregnant or breastfeeding')) food.push('You said you’re pregnant or breastfeeding. It may be worth going over your supplements with your GP, midwife or pharmacist.');
  return { food, exercise };
}

// About me cuisine choices whose wording differs from the cuisine names in the meal library.
const CUISINE = { 'Australian classics': 'Australian' };

const ALLERGY = { Peanuts: 'peanut', 'Tree nuts': 'treenut', Milk: 'milk', Eggs: 'egg', 'Wheat or gluten': 'gluten', Soy: 'soy', Fish: 'fish', Shellfish: 'shellfish', Sesame: 'sesame', Lactose: 'lactose' };
const ALLERGY_WORDS = { peanut: 'peanuts', treenut: 'tree nuts', milk: 'milk', egg: 'eggs', gluten: 'gluten', soy: 'soy', fish: 'fish', shellfish: 'shellfish', sesame: 'sesame', lactose: 'lactose' };

// The weekdays work or school provides lunch: the days they picked, or Mon to Fri if they said it
// does but didn't pick days.
function providedDays(a) {
  const picked = list(a.lunch_provided).filter(d => DAYS.includes(d));
  if (picked.length) return new Set(picked);
  return new Set(a.packed_lunch === 'Work or school provides lunch' ? DAYS.slice(0, 5) : []);
}

// Whether they can get to a pool (at home or a public one; "Pool" is the older answer).
const hasPool = equipment => ['Pool', 'Pool at home', 'Public pool or swim centre'].some(p => equipment.has(p));

// A dislike that names a whole food group rather than a food, after words() has tidied it:
// "most veggy" (from "most veggies"), "vegetable", "fruit", "greens".
const BROAD_DISLIKE = /^(most |all |any )?(veg|veggy|vegy|veggie|vegie|vegetable|fruit|green|salad stuff|healthy food)$/;

// What a meal slot says for someone who goes without that meal on a fast day.
const FASTING = 'Fasting';

// The first-meal answers in About me, as hours on a 24-hour clock.
const FIRST_MEAL = { 'About 6 am': 6, 'About 7 am': 7, 'About 8 am': 8, 'About 9 am': 9, 'About 10 am': 10, 'About 11 am': 11, 'About noon': 12, 'About 1 pm': 13, 'About 2 pm': 14 };

// The daily fast someone said they keep (About me): {hours, open, close, firm}, where open and
// close are the start and end of their eating window as hours on a 24-hour clock. Null if they
// don't fast, or are under 18 (fasting isn't applied to children and teenagers). Without a
// first-meal answer, the window is placed so that it closes at about 7:30 pm.
function fastFor(a, age) {
  const hours = num(a.fast_hours);
  if (hours === null || hours < 10 || hours > 20 || (age !== null && age < 18)) return null;
  const eating = 24 - hours;
  const open = FIRST_MEAL[a.fast_first_meal] || Math.max(6, Math.round((19.5 - eating) * 2) / 2);
  const firm = /Flexible/.test(String(a.fast_firm || '')) ? 'flexible' : /every day/.test(String(a.fast_firm || '')) ? 'daily' : /most days/.test(String(a.fast_firm || '')) ? 'most' : '';
  return { hours, open, close: Math.min(open + eating, 23.5), firm };
}

// "Week 2" and "Week 3" (About me) as numbers: [2, 3].
function weekNumbers(answer) {
  return list(answer).map(x => Number(String(x).replace(/\D/g, ''))).filter(n => n >= 1 && n <= 4);
}

// Fast days someone keeps each week (About me): {days: Set of "Mon"..., skip: Set of "breakfast",
// "lunch", "dinner", snacks: true if they go without snacks too}. Null if they don't, or are
// under 18. The plan leaves those meals out for them on those days; it doesn't set how much to
// eat on a fast day.
function weeklyFastFor(a, age) {
  const days = new Set(list(a.fast_days).filter(d => DAYS.includes(d)));
  if (!days.size || (age !== null && age < 18)) return null;
  const without = list(a.fast_day_skip).map(x => String(x).toLowerCase());
  return { days, skip: new Set(without.filter(x => x !== 'snacks')), snacks: without.includes('snacks') };
}

// Foods someone gives up on fast days or in a fasting season, like Lent (About me): the tags
// left out, in words, and when. An empty set of days or weeks means every day or every week.
const FOOD_FAST = {
  'No meat (fish is fine)': { tags: ['meat'], words: 'meat' },
  'No meat or fish': { tags: ['meat', 'fish', 'shellfish'], words: 'meat and fish' },
  'No meat, fish, dairy or eggs': { tags: ['meat', 'fish', 'shellfish', 'animal', 'milk', 'egg', 'lactose'], words: 'meat, fish, dairy and eggs' },
};
function foodFastFor(a) {
  const kind = FOOD_FAST[a.fast_food];
  if (!kind) return null;
  return { tags: kind.tags, words: kind.words, days: new Set(list(a.fast_food_days).filter(d => DAYS.includes(d))), weeks: new Set(weekNumbers(a.fast_food_weeks)) };
}

// How someone's fasting changes one day of the plan: {food: true if they give up some foods that
// day, skip: the meals ("breakfast", "lunch", "dinner") they go without that day}.
// `week` is the meal week number (1 to 4) and `day` is "Mon" to "Sun".
function fastingOn(r, week, day) {
  const f = r.foodFast;
  const food = !!f && (!f.weeks.size || f.weeks.has(week)) && (!f.days.size || f.days.has(day));
  const skip = r.fastDays && r.fastDays.days.has(day) ? r.fastDays.skip : new Set();
  return { food, skip };
}

// Weeks or days as words: [2, 3] -> "weeks 2 and 3"; every one -> the `all` text.
function weeksText(weeks) {
  return weeks.length >= 4 ? 'every week of this plan' : (weeks.length === 1 ? 'week ' : 'weeks ') + andList(weeks.map(String));
}

// A time as people write it: 7.5 -> "7:30 am", 13 -> "1:00 pm". Rounded to the half hour.
function clock(hour) {
  const half = Math.round(hour * 2) / 2;
  const h = Math.floor(half), m = half % 1 ? '30' : '00';
  return ((h + 11) % 12 + 1) + ':' + m + ' ' + (h % 24 < 12 ? 'am' : 'pm');
}

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
    usualWords: words(a.usual_day),   // what they eat now, so the plan can start near it
    rated: (p.feedback && p.feedback.rated) || {},   // their own scores for earlier meals, out of 10
    tried: p.tried || {},             // new foods they've been offered: "tried", "liked" or "not yet"
    cuisines: new Set(list(a.cuisines).map(c => CUISINE[c] || c)),
    cookLimit: COOK_LIMIT[a.cook_time] || null,
    cooks: a.cook_time !== "I don't cook",
    kitchen: new Set(list(a.kitchen).map(k => k.toLowerCase())),
    help: new Set(list(a.cooking_help)),
    sensory: new Set(list(a.sensory)),
    support: new Set(list(a.support_needs)),
    conditions: new Set(list(a.conditions)),
    meds: new Set(list(a.medicine_types).filter(m => m !== 'None of these')),
    supps: new Set(list(a.supplements).filter(s => s !== 'None of these')),   // supplements they already take
    minor: age !== null && age < 18,   // supplements are noted, not counted, for under-18s
    remind: /remind me to eat/i.test(String(a.reminders || '')),   // they asked for eating reminders
    fast: fastFor(a, age),   // the daily fast they said they keep (adults only), or null
    fastDays: weeklyFastFor(a, age),   // set fast days each week (adults only), or null
    sunWeeks: age !== null && age < 18 ? [] : weekNumbers(a.fast_sun_weeks),   // meal weeks fasting sunrise to sunset
    foodFast: foodFastFor(a),   // foods given up on some days or weeks (any age), or null
    packed: /Yes|Some/.test(String(a.packed_lunch || '')),
    lunchProvided: providedDays(a),
    budget: num(a.budget),
    notes: [],
  };
  for (const x of list(a.allergies)) if (ALLERGY[x]) r.hard.add(ALLERGY[x]);
  if (r.conditions.has('Coeliac disease')) r.hard.add('gluten');
  // An adult's protein powder: how it's tied to their days ("daily", "active", "strength" or
  // "sometimes"), or null if they don't have any. No answer to "when" counts as "sometimes".
  r.shakeAnswered = !!SHAKE_WHEN[a.protein_powder_when];
  r.shake = r.supps.has('Protein powder') && !r.minor ? SHAKE_WHEN[a.protein_powder_when] || 'sometimes' : null;
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
  // Foods they won't eat. A child's sweeping dislikes ("most veggies", "fruit") aren't a ban:
  // they still get vegetables and fruit, in forms that are easier to eat (see gentleVeg below).
  // Named foods ("corn", "mushrooms") are always left out, whatever their age.
  const child = age !== null && age < 18;
  r.avoidWords.push(...words(a.dislikes).filter(w => !(child && BROAD_DISLIKE.test(w))));
  // Vegetables or fruit as a whole in their dislikes: serve them soft, cooked in or blended.
  r.gentleVeg = /\b(veg|veggies|vegies|vegetables?|greens)\b/i.test(String(a.dislikes || ''));
  r.gentleFruit = /\bfruits?\b/i.test(String(a.dislikes || ''));
  // New foods they tried and liked count as foods they like.
  for (const [food, result] of Object.entries(r.tried)) if (result === 'liked') r.likeWords.push(...words(food));
  // The serves of vegetables and fruit a day to aim for, from their age and sex, and how fast
  // they chose to get there: "full" (from week 1), "build" (by week 3) or "own" (no change).
  r.target = TARGETS.targetFor(a);
  r.pace = TARGETS.paceFor(a);
  r.weekTarget = n => TARGETS.weekTarget(a, n);
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
  // Their latest logged weight (Health sync, Apple Health or Lose It) if there is one, else About me's.
  const logged = p.measured && num(p.measured.weight);
  const w = logged || num(a.weight), h = num(a.height);
  if (!w || !h || w < 30 || w > 300 || h < 120 || h > 230) return sex === 'm' ? 1.1 : sex === 'f' ? 0.9 : 1;
  const bmr = 10 * w + 6.25 * h - 5 * age + (sex === 'm' ? 5 : sex === 'f' ? -161 : -78);
  let activity = { 'Mostly sitting (desk job)': 1.35, 'On my feet some of the day': 1.5, 'On my feet most of the day': 1.65, 'Physical work all day': 1.85 }[a.activity] || 1.45;
  // Logged steps can lift this: about 9,000 a day or more is at least "on my feet some of the day".
  const steps = p.measured && num(p.measured.steps);
  if (steps >= 12000) activity = Math.max(activity, 1.65);
  else if (steps >= 9000) activity = Math.max(activity, 1.5);
  let kcal = bmr * activity;
  const goals = new Set(list(a.goal));
  const pregnant = r.conditions.has('Pregnant or breastfeeding');
  if (goals.has('Lose weight') && !pregnant) kcal *= { 'Slow and steady': 0.9, 'A moderate pace': 0.85, 'As fast as is safe': 0.8 }[a.pace] || 0.85;
  else if (goals.has('Gain weight') || goals.has('Build muscle')) kcal *= 1.1;
  if (pregnant) kcal += 350;
  // Rounded to the nearest 0.05, then tidied to 2 decimal places (so 1.2 isn't 1.2000000000000002).
  return Math.round(Math.min(1.5, Math.max(0.7, round(kcal * 4.184 / 8700, 0.05))) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Food already in the kitchen
// ---------------------------------------------------------------------------

// Words in a kitchen list that describe the packaging, not the food.
const PACK_WORDS = /\b(tins?|cans?|packs?|packets?|bags?|boxe?s?|bottles?|jars?|cartons?|tubs?|loaf|loaves|bunch(es)?|heads?|pieces?|of|a|an|some|half|dozen|about|x)\b/g;

// Everyday names for library ingredients, as people write them on a kitchen list (plurals removed).
const KITCHEN_NAMES = { cheese: 'cheddar', spaghetti: 'pasta', penne: 'pasta', macaroni: 'pasta', noodle: 'egg noodles',
  yoghurt: 'greek yoghurt', yogurt: 'greek yoghurt', chicken: 'chicken breast', mince: 'beef mince', sausage: 'beef sausages',
  steak: 'beef steak', fish: 'white fish', lentil: 'red lentils', bean: 'baked beans', vegetable: 'frozen veg' };
// Words that make it a different food ("tomato sauce" isn't tomatoes), or name no food by themselves.
const DIFFERENT_FOOD = ['sauce', 'paste', 'soup', 'juice', 'powder', 'chip', 'flavour', 'flavoured', 'cake', 'biscuit'];
const TOO_VAGUE = ['fruit', 'frozen', 'canned', 'tinned', 'fresh', 'food', 'meat', 'milk powder'];

// The library ingredient a food on the kitchen list means, or null: "eggs" is "egg", "peas" is
// "frozen peas", "brown rice" is "rice", "diced tomatoes" is "canned tomatoes".
function ingredientFor(food) {
  // Words without plurals or hyphens: "Weet-Bix biscuits" -> ["weetbix", "biscuit"].
  const tidy = text => String(text).toLowerCase().replace(/-/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => w.replace(/(ies)$/, 'y').replace(/(oes)$/, 'o').replace(/s$/, ''));
  const want = tidy(food);
  if (!want.length || TOO_VAGUE.includes(want.join(' '))) return null;
  if (KITCHEN_NAMES[want.join(' ')]) return KITCHEN_NAMES[want.join(' ')];
  let best = null, bestScore = 0;
  for (const key of Object.keys(LIB.ingredients)) {
    const k = tidy(key);
    const name = tidy(LIB.ingredients[key].name.replace(/\d+(\.\d+)?\s*(kg|g|ml|l)\b/gi, ''));
    // It's a match when every word they wrote is in the ingredient's key or shop name ("diced
    // tomatoes"), or the whole key is in what they wrote ("brown rice" has "rice").
    const inKey = want.filter(w => k.includes(w)).length;
    const inName = want.filter(w => !k.includes(w) && name.includes(w)).length;
    if (!inKey && !inName) continue;
    if (inKey + inName < want.length && !k.every(w => want.includes(w))) continue;
    if (want.some(w => DIFFERENT_FOOD.includes(w) && !k.includes(w) && !name.includes(w))) continue;
    // Words in the key count most, then the shop name; a key with extra words loses a little.
    const score = inKey * 2 + inName * 1.5 - k.filter(w => !want.includes(w)).length * 0.1;
    if (score > bestScore) { best = key; bestScore = score; }
  }
  return best;
}

// Reads the family's kitchen list (lines like "rice 2 kg", "6 eggs", "frozen peas") into amounts
// of library ingredients. Returns {stock: {ingredient key: [{amount, until}]}, counted: [names],
// unknown: [what it couldn't match]}. "until" is the last meal week (0 to 3) the food keeps for.
// No amount means one pack; a number without a unit means that many (eggs) or that many packs.
//
// A line can also be {text, place}, where place is "pantry", "fridge", "freezer" or "other" (the
// Current food page). Where food is kept changes how long it counts for: anything in the freezer
// lasts the whole plan, even meat that would only keep a few days in the fridge.
function kitchenStock(lines) {
  const stock = {}, counted = [], unknown = [];
  const all = Array.isArray(lines) ? lines : lines ? [lines] : [];
  for (const line of all.slice(0, 400)) {
    const place = line && typeof line === 'object' ? line.place : '';
    for (const part of String(line && typeof line === 'object' ? line.text : line).split(/[,;\n]/)) {
      const text = part.trim().toLowerCase();
      if (!text) continue;
      const m = text.match(/(\d+(?:\.\d+)?)\s*(kg|g|grams?|ml|l|litres?|liters?)?\b/);
      const food = text.replace(/(\d+(?:\.\d+)?)\s*(kg|g|grams?|ml|l|litres?|liters?)?\b/g, ' ').replace(PACK_WORDS, ' ');
      const key = ingredientFor(food);
      if (!key) { unknown.push(part.trim().slice(0, 60)); continue; }
      const ing = ING[key];
      if (ing.aisle === 'assumed' || !ing.pack) continue;   // oil, salt, spices: never on the list anyway
      const number = m ? parseFloat(m[1]) : null;
      const unit = m && m[2] ? m[2][0] : '';
      let amount = ing.pack;                                   // no amount given: one pack
      if (number && unit && ing.unit !== 'each') amount = number * (m[2] === 'kg' || unit === 'l' ? 1000 : 1);
      else if (number) amount = ing.unit === 'each' ? number : number * ing.pack;
      const keeps = KEEPS_ITEM[key] || KEEPS[ing.aisle] || 5;
      // The last meal week (0 to 3) it still counts in.
      let until = ing.aisle === 'pantry' || ing.aisle === 'frozen' ? 3 : Math.min(3, Math.floor(keeps / 7));
      if (place === 'freezer') until = 3;                                  // frozen: the whole plan
      if (place === 'fridge' && ing.aisle === 'frozen') until = 0;         // thawed: use it this week
      (stock[key] = stock[key] || []).push({ amount, until });
      if (!counted.includes(ing.name)) counted.push(ing.name);
    }
  }
  return { stock, counted, unknown };
}

// Where a food from an older kitchen list most likely lives: "pantry", "fridge", "freezer", or
// "other" if it isn't in the meal library. Used once, to sort an older list into places.
function kitchenPlace(line) {
  const key = Object.keys(kitchenStock([line]).stock)[0];
  if (!key) return 'other';
  const aisle = ING[key].aisle;
  return aisle === 'frozen' ? 'freezer' : aisle === 'pantry' || aisle === 'bread' ? 'pantry' : 'fridge';
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
function allowed(d, r, fasting) {
  for (const t of d.tags || []) if (r.hard.has(t) || r.diet.has(t)) return false;
  // On the days they give up some foods (see foodFastFor), those are left out too.
  if (fasting && r.foodFast) for (const t of d.tags || []) if (r.foodFast.tags.includes(t)) return false;
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
    // Dishes like what they eat now score higher for people easing in or keeping to their own food.
    if (r.pace !== 'full') for (const w of r.usualWords) if (w && text.includes(w)) s += 2;
    if (r.cuisines.has(d.cuisine)) s += 2;
    // Dishes with more vegetables score a little higher (up to 3 serves), for everyone. Anything
    // still missing is added as sides afterwards (see topUp).
    const veg = (d.groups && d.groups.veg) || 0;
    s += Math.min(veg, 3) * 0.3;
    // Not keen on vegetables: prefer them cooked in (stews, soups, sauces) over raw or on their own.
    if (r.gentleVeg && veg >= 1 && (d.texture || []).some(x => x === 'soft' || x === 'mixed')) s += 1.5;
    if (r.sensory.has('Foods touching on the plate') && d.separate) s += 2;
    if (r.help.has('Meals with only a few steps') && d.steps.length > 3) s -= 2;
    if (r.help.has('One-pan or tray-bake meals') && d.onepan) s += 2;
    if (r.help.has('Cooking a batch on a good day') && d.batch) s += 1.5;
    if (r.sensory.has('Strong smells') && (d.tags || []).includes('fish')) s -= 2;
  }
  // What people thought of this dish last time, out of 10. Each person's own score counts most
  // (8 adds about 1.5 for them, 3 takes about 2.5 off); for anyone who hasn't scored it, the
  // family's average counts half as much. Dishes nobody has rated are left alone.
  const family = house.rated && house.rated[d.name.toLowerCase()];
  for (const r of eaters) {
    const own = r.rated[d.name.toLowerCase()];
    if (typeof own === 'number') s += (own - 6) * 0.8;
    else if (typeof family === 'number') s += (family - 6) * 0.4 / eaters.length;
  }
  // Food already in the kitchen: dishes that use it score higher, and it costs nothing to use,
  // so its price comes off what the dish costs.
  const owned = house.ownedNow ? d.per.filter(x => house.ownedNow.has(x[0])) : [];
  const ownedCost = owned.reduce((n, [k, amount]) => n + ING[k].price / ING[k].pack * amount, 0);
  s += Math.min(owned.length, 3) * 0.5 + ownedCost;
  if (house.cookLimit && d.minutes > house.cookLimit) s -= (d.minutes - house.cookLimit) / 5;
  if (house.budget) s -= (d.cost - ownedCost) * house.costWeight;
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
  if (!seated && (hasPool(equipment) && /swim/.test(likes))) cardio = equipment.has('Pool at home') ? 'Swim' : 'Swim at the pool';
  else if (!seated && (equipment.has('Exercise bike') || equipment.has('Bike')) && /bike|cycl|ride/.test(likes)) cardio = 'Ride';
  else if (!seated && /dance/.test(likes)) cardio = 'Dance or walk';
  const poolDays = list(a.pool_days).filter(d => DAYS.includes(d));
  // A foot, ankle, knee or hip injury: swim or ride instead of walking, where they can.
  const injuryText = (String(a.injuries || '') + ' ' + String(a.gp || '')).toLowerCase();
  const lowerBody = !seated && INJURY_FLAGS.some(([re, flags]) => flags.some(f => LOWER_BODY.includes(f)) && mentions(re, injuryText));
  const canRide = equipment.has('Exercise bike') || equipment.has('Bike');
  if (lowerBody && cardio === 'Walk') {
    if (hasPool(equipment)) cardio = equipment.has('Pool at home') ? 'Swim' : 'Swim at the pool';
    else if (canRide) cardio = 'Ride';
  }
  // What the other cardio days are when the pool is only some days.
  const otherCardio = lowerBody && canRide ? 'Ride' : 'Walk';

  const medical = [];
  const injuries = String(a.injuries || '').trim();
  const gp = String(a.gp || '').trim();
  const medicines = String(a.medicines || '').trim();
  const otherConditions = String(a.conditions_other || '').trim();
  // A health condition they wrote in their own words can't be read by rules, so the plan says so.
  if (otherConditions && !/^(no|none|nil|n\/a)\.?$/i.test(otherConditions)) medical.push('You mentioned another health condition: “' + otherConditions.slice(0, 300) + '”. This plan wasn’t changed for it, so it may be worth checking the meals and exercise with your GP.');
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
  medical.push(...supplementNotes(r).exercise);
  medical.push(...fastNotes(r, a).exercise);
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
    let cDays = cardioOrder.filter(d => !sDays.includes(d)).slice(0, c);
    // Public pool: swims only on the days they can get there; any other cardio days are walks.
    let swimDays = cDays;
    if (cardio === 'Swim at the pool' && poolDays.length) {
      swimDays = poolDays.filter(d => !sDays.includes(d)).slice(0, c);
      cDays = swimDays.concat(cardioOrder.filter(d => !sDays.includes(d) && !swimDays.includes(d)).slice(0, c - swimDays.length));
    }
    const cardioTarget = swimDays.length === cDays.length
      ? c + ' × ' + cardio.toLowerCase() + ' ' + mins + ' minutes'
      : [swimDays.length ? swimDays.length + ' × swim at the pool' : '', (cDays.length - swimDays.length) + ' × ' + otherCardio.toLowerCase()].filter(Boolean).join(', ') + ', ' + mins + ' minutes each';
    let ab = 0;
    weeks.push({
      focus: focus[w],
      targets: [s + ' strength session' + (s > 1 ? 's' : ''), cardioTarget, 'A few more steps each day than last week'],
      days: DAYS.map(day => {
        const o = { day };
        if (sDays.includes(day)) o.strength = 'Strength ' + (w < 2 ? '1' : '2') + (ab++ % 2 ? 'B' : 'A');
        if (cDays.includes(day)) o.cardio = (swimDays.includes(day) ? cardio : otherCardio) + ' ' + mins + ' minutes';
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
  [/\b(foot|feet|ankles?|heels?|achilles|plantar\w*|toes?)\b/g, ['feet'], 'feet or ankles'],
];
// Flags for injuries that make walking and standing work harder (feet, ankles, knees, hips).
const LOWER_BODY = ['feet', 'knees'];
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
  // Feet or ankles: no calf raises, lunges, one-leg balance or jumping.
  const feet = skip.has('feet') && (e => ['calf', 'lunge', 'balance'].includes(e.type) || e.flags.some(f => f === 'impact' || f === 'balance'));
  const usable = e => have.has(e.equipment) && !disliked.has(e.id)
    && !e.flags.some(f => skip.has(f)) && !(feet && feet(e)) && (!o.seated || e.flags.includes('seated'));
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
  // Food already in the kitchen (the list on Plan setup), as amounts of library ingredients.
  // The family's average rating of each dish they've scored: {"lower-case dish name": 0 to 10}.
  house.rated = (opts && opts.rated) || {};
  const kitchen = kitchenStock(opts && opts.pantry);
  house.stock = kitchen.stock;
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
  // Feedback: scores were used above. Notes can't be read by rules, so the admin gets them.
  const scored = people.filter(p => p.feedback && Object.keys(p.feedback.rated || {}).length).map(p => p.name);
  if (scored.length) forAdmin.push('Meal scores from ' + scored.join(', ') + ' were used: meals they scored well come back more often, and ones they scored poorly less often.');
  const said = people.flatMap(p => ((p.feedback && p.feedback.notes) || []).slice(0, 5).map(n => p.name + ' on ' + n.dish + ': “' + n.note + '”'));
  if (said.length) forAdmin.push('The plan builder can’t read written notes, so check these against the new plan: ' + said.slice(0, 10).join('; ') + '. (An AI-written plan reads them.)');
  // Written About me answers the rules can't read (their week, their goal in their own words and
  // so on): the admin gets them too. Ones with their own handling (injuries, what a doctor said,
  // medicines, likes and dislikes) aren't repeated here.
  const WRITTEN = { goal_detail: 'goal', schedule: 'week', exercise_now: 'exercise now', support_other: 'what would help', anything_else: 'anything else' };
  const wrote = people.flatMap(p => Object.keys(WRITTEN).filter(id => String((p.answers || {})[id] || '').trim())
    .map(id => p.name + ' (' + WRITTEN[id] + '): “' + String(p.answers[id]).trim().slice(0, 160) + '”'));
  if (wrote.length) forAdmin.push('The plan builder can’t read written answers either, so check these About me answers against the new plan: ' + wrote.slice(0, 12).join('; ') + '. (An AI-written plan reads them.)');
  const loggedBy = people.filter(p => p.measured && p.measured.weight).map(p => p.name);
  if (loggedBy.length) forAdmin.push('Serves for ' + loggedBy.join(', ') + ' use their latest logged weight in place of the one in About me.');
  if (kitchen.counted.length) forAdmin.push('From Current food, the plan counts: ' + kitchen.counted.join(', ') + '. Meals that use them were preferred, and what they cover is left off the shopping lists.');
  if (kitchen.unknown.length) forAdmin.push('Not matched to anything in the meal library, so not counted: ' + kitchen.unknown.join(', ') + '.');
  // Anyone still short of their vegetable or fruit serves (their answers ruled out the options).
  const shortNote = TARGETS.shortNote(plan, people);
  if (shortNote) forAdmin.push(shortNote);
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
  // How much of each kitchen food is left as the weeks are planned ({ingredient: amount}). Each
  // week's meals take their share off, so a food stops being preferred once it has been used up
  // (a dozen eggs at home shouldn't fill all four weeks with egg dishes).
  const left = {};
  for (const [k, shelf] of Object.entries(house.stock || {})) left[k] = shelf.reduce((n, x) => n + x.amount, 0);
  const householdServes = rules.reduce((n, r) => n + r.portion, 0);
  const useUp = dish => { for (const [k, amount] of (dish && dish.per) || []) if (k in left) left[k] -= amount * householdServes; };
  // The kitchen foods that still keep in meal week `w` (fresh food only counts for the first
  // weeks) and haven't been used up by the weeks before it.
  const ownedIn = w => new Set(Object.keys(house.stock || {}).filter(k => left[k] > 0 && house.stock[k].some(x => x.until >= w)));
  for (let w = 0; w < 4; w++) {
    house.ownedNow = ownedIn(w);
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
    // Take this week's meals off what's left in the kitchen (a leftover lunch was cooked as dinner).
    for (const day of days) { useUp(day.dinner); useUp(day.breakfast); useUp(day.lunch.leftover || day.lunch); }
  }

  // Per-person swaps: anyone a shared dish doesn't suit gets one that does.
  house.ownedNow = ownedIn(0);
  const own = {};       // person key -> {dinners: [dishes], breakfast, lunches}
  const ownFast = {};   // the same, for the days they give up some foods (people with a food fast)
  // One person's own meals. `fasting` is true for the days they give up some foods.
  const ownMeals = (r, fasting) => {
    const myDinners = dinners.filter(d => allowed(d, r, fasting));
    const myBreakfasts = breakfasts.filter(d => allowed(d, r, fasting));
    const myLunches = lunches.filter(d => allowed(d, r, fasting));
    if (!myDinners.length) forAdmin.push('No dinners in the library suit ' + r.name + '’s needs' + (fasting ? ' on the days they give up ' + r.foodFast.words : '') + '. Their meals will need adding by hand in Edit plan.');
    return {
      dinners: pick(myDinners, 7, [r], house, rnd, new Set()),
      breakfast: myBreakfasts.length ? pick(myBreakfasts, 1, [r], house, rnd, new Set())[0] : null,
      // Their own lunches (packable for children), best-suited first: likes, dislikes and so on.
      lunches: (l => pick(l, Math.min(7, l.length), [r], house, rnd, new Set()))(myLunches.filter(d => !r.kid || d.packable)),
    };
  };
  for (const r of rules) own[r.key] = ownMeals(r, false);
  for (const r of rules) if (r.foodFast) ownFast[r.key] = ownMeals(r, true);

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
      // How each person's fasting changes today: foods given up, and meals they go without.
      const today = {}, next = {};
      rules.forEach(r => {
        today[r.key] = fastingOn(r, w + 1, day.day);
        next[r.key] = days[i + 1] ? fastingOn(r, w + 1, days[i + 1].day) : { food: false, skip: new Set() };
      });
      const fits = (dish, r) => allowed(dish, r, today[r.key].food);
      const mine = r => (today[r.key].food ? ownFast[r.key] : own[r.key]);
      // Marks a meal someone goes without today. Returns true if they do.
      const skipped = (r, slot) => {
        if (!today[r.key].skip.has(slot)) return false;
        overrides[r.key] = Object.assign(overrides[r.key] || {}, { [slot]: FASTING });
        return true;
      };
      // Breakfast.
      let bServes = 0;
      rules.forEach(r => {
        if (skipped(r, 'breakfast')) return;
        const alt = mine(r).breakfast;
        if (fits(day.breakfast, r)) bServes += r.portion;
        else if (alt) {
          overrides[r.key] = Object.assign(overrides[r.key] || {}, { breakfast: alt.name });
          addNeed(alt, r.portion); addCooked(alt, r.portion); used.set(alt.name, alt);
        }
      });
      m.breakfast = day.breakfast.name;
      if (!day.breakfast.ownChoice) { addNeed(day.breakfast, bServes); addCooked(day.breakfast, bServes); used.set(day.breakfast.name, day.breakfast); }
      // Dinner (and extra for tomorrow's leftovers).
      let dServes = 0;
      rules.forEach(r => {
        if (skipped(r, 'dinner')) return;
        if (fits(day.dinner, r)) dServes += r.portion;
        else if (mine(r).dinners.length) {
          const alt = mine(r).dinners[i % mine(r).dinners.length];
          overrides[r.key] = Object.assign(overrides[r.key] || {}, { dinner: alt.name });
          addNeed(alt, r.portion); addCooked(alt, r.portion); used.set(alt.name, alt);
        }
      });
      m.dinner = day.dinner.name;
      used.set(day.dinner.name, day.dinner);
      const tomorrow = days[i + 1];
      // Leftovers are packed for the adults who can have them for lunch tomorrow (not for someone
      // who gives up that food tomorrow, or goes without lunch).
      const leftoverFor = tomorrow && tomorrow.lunch.leftover === day.dinner ? rules.filter(r => !r.kid && allowed(day.dinner, r, next[r.key].food) && !r.lunchProvided.has(tomorrow.day) && !next[r.key].skip.has('lunch')) : [];
      const extra = leftoverFor.reduce((n, r) => n + r.portion, 0);
      addNeed(day.dinner, dServes + extra); addCooked(day.dinner, dServes + extra);
      if (extra) m.note = 'Cook extra tonight: pack ' + (leftoverFor.length === 1 ? 'a serve' : leftoverFor.length + ' serves') + ' for tomorrow’s lunch.';
      if (day.dinner.kit.includes('slow cooker')) m.note = 'Start the slow cooker this morning.' + (m.note ? ' ' + m.note : '');
      if (tomorrow && tomorrow.breakfast.name === 'Overnight oats with berries') m.note = (m.note ? m.note + ' ' : '') + 'Make tomorrow’s overnight oats tonight.';
      // Lunch. Adults whose work provides lunch that day get that instead.
      const providedLunch = r => {
        if (r.kid || !r.lunchProvided.has(day.day)) return false;
        overrides[r.key] = Object.assign(overrides[r.key] || {}, { lunch: 'Work provides lunch' });
        return true;
      };
      if (day.lunch.leftover) {
        m.lunch = 'Leftovers: ' + day.lunch.leftover.name;
        used.set(m.lunch, Object.assign({}, day.lunch.leftover, { name: m.lunch, leftoverOf: day.lunch.leftover.name }));
        rules.forEach(r => {
          if (r.kid && ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(day.day)) return;   // school lunch, below
          if (skipped(r, 'lunch')) return;
          if (providedLunch(r)) return;
          if (!fits(day.lunch.leftover, r) || r.kid) {
            const alt = mine(r).lunches[i % Math.max(1, mine(r).lunches.length)];
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
          if (skipped(r, 'lunch')) return;
          if (providedLunch(r)) return;
          if (fits(day.lunch, r)) lServes += r.portion;
          else {
            const alt = mine(r).lunches[i % Math.max(1, mine(r).lunches.length)];
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
        // A child who gives up some foods on some days gets school lunches and snacks that fit
        // on every day, because the school week is the same each week.
        const packs = (r.foodFast ? ownFast : own)[r.key].lunches.filter(d => d.packable);
        const kidSnacks = snackOrder(LIB.snacks.filter(s => s.kids && s.kind !== 'side' && available(s) && allowed(s, r, true)), r, rnd);
        p.weekday = {};
        DAYS.slice(0, 5).forEach((d, i) => {
          const l = packs[i % Math.max(1, packs.length)];
          const s = kidSnacks[i % Math.max(1, kidSnacks.length)];
          p.weekday[d] = {};
          if (r.lunchProvided.has(d)) p.weekday[d].lunch = 'School provides lunch';
          else if (l) { p.weekday[d].lunch = l.name; used.set(l.name, l); }
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
    p.snacks = snacksFor(r, exercise[people[i].key], rnd).map(s => offFastDays(s, r));
    // Top up to their serves at the pace they chose. Building up: weeks 1 and 2 aim lower than
    // weeks 3 and 4, so anything added only for the later weeks is marked with those weeks.
    if (r.pace === 'full') topUp(r, people[i].key, planPeople, weeks, used, null);
    else if (r.pace === 'build') {
      [[1], [2], [3, 4]].forEach(stage => topUp(r, people[i].key, planPeople, weeks, used, stage));
      p.snacks = mergeWeeks(p.snacks);
    }
    for (let w = 0; w < 4; w++) {
      const exWeek = exercise[people[i].key][w];
      for (const s of p.snacks) {
        const lib = LIB.snacks.find(x => x.what === s.what);
        if (!lib) continue;
        const days = DAYS.filter(d => {
          if (s.days && !s.days.includes(d)) return false;
          if (s.weeks && !s.weeks.includes(w + 1)) return false;
          const exDay = exWeek.days.find(x => x.day === d) || {};
          if (s.exercise === 'strength') return !!exDay.strength;
          if (s.exercise === 'rest') return !exDay.strength;
          if (s.exercise === 'active') return !!(exDay.strength || exDay.cardio);
          if (s.exercise === 'inactive') return !(exDay.strength || exDay.cardio);
          return true;
        }).length;
        for (const [k, amount] of lib.per) if (LIB.ingredients[k].aisle !== 'assumed') needs[w][k] = (needs[w][k] || 0) + amount * days * (s.optional ? 0.5 : 1);
      }
    }
    // Suggested eating times: for anyone who asked for reminders, and for anyone who keeps a
    // daily fast (their meals are spread through their eating window, with a line for each
    // snack that follows exercise).
    if (r.fast) {
      p.times = timesFor(p.snacks, r.fast).concat(exerciseSnackTimes(p.snacks, r.fast));
      p.timesNote = 'These times fit the fast you said you aim for (about ' + r.fast.hours + ' hours without food). Shift them to suit your day.';
    } else if (r.remind) {
      p.times = timesFor(p.snacks);
      p.timesNote = 'You asked for eating reminders, so these are ordinary times to start from. Shift them to suit your day.';
    }
    // Weeks of fasting from sunrise to sunset: in place of the usual times when it's the whole
    // plan, or listed after them when it's only some weeks.
    if (r.sunWeeks.length) {
      p.times = (r.sunWeeks.length >= 4 ? [] : p.times || []).concat(sunTimes(r.sunWeeks));
      if (r.sunWeeks.length >= 4 || !p.timesNote) p.timesNote = 'Sunrise and sunset change with where you live and the time of year, so these have no clock times.';
    }
    Object.assign(p, guideFor(r, people[i]));
    const steps = smallSteps(r, people[i]);
    if (steps.length) p.steps = steps;
  }

  // Shopping: buy in whole packs, carrying over what keeps.
  const shopping = shoppingFor(needs, house.stock);
  const plan = { weeks: [] };
  for (let f = 0; f < 2; f++) {
    plan.weeks.push({ name: 'Stock-up ' + (f + 1), kind: 'stockup', shopping: shopping.stock[f] });
    for (let k = 0; k < 2; k++) {
      const w = weeks[f * 2 + k];
      w.shopping = shopping.weekly[f * 2 + k];
      // Fresh food likely to be left over at the end of this week, so it gets used, not binned.
      if (shopping.useUp[f * 2 + k].length) w.useUp = shopping.useUp[f * 2 + k];
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
  // A meal someone goes without counts as nothing, rather than as a dish with no numbers yet.
  if (rules.some(r => r.fastDays && r.fastDays.skip.size)) { macros[FASTING] = { p: 0, c: 0, f: 0, kj: 0 }; groups[FASTING] = {}; }
  for (const [name, d] of used) { macros[name] = d.macros; groups[name] = d.groups; }
  for (const p of Object.values(planPeople)) {
    for (const s of p.snacks || []) {
      const lib = LIB.snacks.find(x => x.what === s.what);
      if (lib) { macros[s.what] = lib.macros; groups[s.what] = lib.groups; }
      // Their own protein powder isn't in the library: it has macros, and no food-group serves.
      if (s.what === SHAKE) { macros[SHAKE] = SHAKE_MACROS; groups[SHAKE] = {}; }
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

// Puts snacks in a shuffled order (the same for the same seed), with ones matching foods they love first.
function snackOrder(list, r, rnd) {
  const loved = s => r.likeWords.some(w => w && s.what.toLowerCase().includes(w));
  return list.map(s => ({ s, k: rnd() + (loved(s) ? 1 : 0) })).sort((a, b) => b.k - a.k).map(x => x.s);
}

// Puts blended and soft forms first (mash, smoothies, steamed) when someone isn't keen on that
// kind of food; otherwise leaves the order alone.
function gentleFirst(list, gentle) {
  if (!gentle) return list;
  const rank = s => (s.blended ? 0 : (s.texture || []).includes('soft') ? 1 : 2);
  return list.slice().sort((a, b) => rank(a) - rank(b));
}

// The food groups of every dish used so far and every library snack, by name, for measuring a
// person's days against their targets.
function groupsSoFar(used) {
  const groups = {};
  for (const [name, d] of used) groups[name] = d.groups;
  for (const s of LIB.snacks) groups[s.what] = s.groups;
  return groups;
}

// Tidies snacks added week by week: the same snack at the same time in several weeks becomes one
// entry listing those weeks, and one that ends up in all four weeks loses its "weeks" list.
function mergeWeeks(snacks) {
  const out = [];
  for (const s of snacks) {
    const twin = s.weeks && out.find(x => x.weeks && x.when === s.when && x.what === s.what && String(x.days) === String(s.days));
    if (twin) twin.weeks = [...new Set(twin.weeks.concat(s.weeks))].sort();
    else out.push(Object.assign({}, s));
  }
  for (const s of out) if (s.weeks && s.weeks.length >= 4) delete s.weeks;
  return out;
}

// The builder stops topping up once someone's days are within a quarter of a serve of their target.
const NEAR_ENOUGH = 0.25;

// Health targets come before likes: adds vegetable sides and fruit to one person's days until
// their average reaches the guideline serves for their age and sex (within a quarter of a serve).
// Sides go with dinner first, then lunch; fruit goes with breakfast, then after dinner. Only
// foods their allergies, diet, textures and named dislikes allow are used, so someone whose
// answers rule out every option stays short, and build() tells the admin.
// `stage` is the meal weeks to top up, like [3, 4] (what's added is marked with those weeks), or
// null for all four weeks at once.
function topUp(r, key, planPeople, weeks, used, stage) {
  const p = planPeople[key];
  const target = stage ? r.weekTarget(stage[0]) : r.target;
  const measure = () => TARGETS.dailyAverage({ weeks, people: planPeople, groups: groupsSoFar(used) }, key, stage);
  // Something they don't already have in these weeks.
  const sameWeeks = x => !stage || !x.weeks || x.weeks.some(n => stage.includes(n));
  const fits = s => available(s) && allowed(s, r, true) && (!r.kid || s.kids) && !p.snacks.some(x => x.what === s.what && sameWeeks(x));
  // Adds a side or fruit to their days, marked with the stage's weeks when it isn't every week.
  const add = entry => { if (stage) entry.weeks = stage; p.snacks.push(offFastDays(entry, r)); };
  // What one of a snack or side costs, from its ingredients' pack prices.
  const costOf = s => s.per.reduce((n, [k, amount]) => n + (ING[k].pack ? ING[k].price / ING[k].pack * amount : 0), 0);
  // The option whose amount is closest to what's missing: gentle forms first when that matters,
  // and the cheaper one when two are as close.
  const closest = (options, group, gap, gentle) => gentleFirst(options, gentle)
    .map((s, i) => ({ s, off: Math.abs(((s.groups || {})[group] || 0) - gap) + (gentle ? i : 0) + costOf(s) * 0.2 }))
    .sort((a, b) => a.off - b.off).map(x => x.s)[0];

  // Vegetables: a side with dinner, then with lunch (weekends only for children, who are at
  // school; not on days work provides lunch), then a vegetable snack.
  const lunchDays = r.kid ? ['Sat', 'Sun'] : DAYS.filter(d => !r.lunchProvided.has(d));
  const vegSlots = [{ when: 'With dinner', kind: 'side' }, { when: 'With lunch', kind: 'side', days: lunchDays }, { when: 'Afternoon', kind: 'veg' }];
  for (const slot of vegSlots) {
    const gap = target.veg - measure().veg;
    if (gap <= NEAR_ENOUGH) break;
    if (slot.days && !slot.days.length) continue;   // no lunches at home to add a side to
    const s = closest(LIB.snacks.filter(x => x.kind === slot.kind && fits(x)), 'veg', gap, r.gentleVeg);
    if (!s) continue;
    const entry = { when: slot.when, what: s.what };
    if (slot.days && slot.days.length < 7) entry.days = slot.days;
    add(entry);
  }
  // Fruit: with breakfast, then after dinner.
  for (const when of ['With breakfast', 'After dinner']) {
    const gap = target.fruit - measure().fruit;
    if (gap <= NEAR_ENOUGH) break;
    const s = closest(LIB.snacks.filter(x => x.kind === 'fruit' && fits(x)), 'fruit', gap, r.gentleFruit);
    if (!s) break;
    add({ when, what: s.what });
  }
}

// Someone who goes without snacks on their weekly fast days: limits a snack or side to their
// other days. Everyone else's snacks are returned unchanged.
function offFastDays(snack, r) {
  if (!r.fastDays || !r.fastDays.snacks) return snack;
  const days = (snack.days || DAYS).filter(d => !r.fastDays.days.has(d));
  return Object.assign({}, snack, { days });
}

// Two snacks a day for each person, tied to exercise where it helps. Snacks are shuffled, so
// different people and different plans get a variety rather than always the first in the library.
function snacksFor(r, exWeeks, rnd) {
  // Snacks fit the foods they give up on every day, so one list of snacks works all week.
  const ok = snackOrder(LIB.snacks.filter(s => available(s) && allowed(s, r, true) && (!r.kid || s.kids)), r, rnd);
  const by = kind => ok.filter(s => s.kind === kind);
  const protein = by('protein'), fruit = gentleFirst(by('fruit'), r.gentleFruit), other = ok.filter(s => s.kind === 'other' || s.kind === 'veg');
  const out = [];
  const lifts = exWeeks.some(w => w.days.some(d => d.strength));
  if (r.kid) {
    if (fruit[0]) out.push({ when: 'After school', what: fruit[0].what, days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] });
    if (other[0] || fruit[1]) out.push({ when: 'Afternoon', what: (other[0] || fruit[1]).what, days: ['Sat', 'Sun'] });
    return out;
  }
  if (fruit[0]) out.push({ when: 'Mid-morning', what: fruit[0].what });
  // Their own protein powder takes the place of the protein snack, so it isn't planned twice.
  // "After strength training" with no strength sessions in the plan is treated as now and then.
  const shake = r.shake === 'strength' && !lifts ? 'sometimes' : r.shake;
  if (shake === 'daily') {
    out.push({ when: lifts ? 'After exercise, or in the afternoon' : 'Afternoon', what: SHAKE });
  } else if (shake === 'active') {
    out.push({ when: 'After exercise', what: SHAKE, exercise: 'active' });
    const rest = other[0] || fruit[1] || protein[0];
    if (rest) out.push({ when: 'Afternoon', what: rest.what, exercise: 'inactive' });
  } else if (lifts && (protein.length || shake === 'strength')) {
    out.push({ when: 'After strength', what: shake === 'strength' ? SHAKE : protein.find(s => /milk|yoghurt/.test(s.what))?.what || protein[0].what, exercise: 'strength' });
    const rest = other[0] || fruit[1] || protein[1];
    if (rest) out.push({ when: 'Afternoon', what: rest.what, exercise: 'rest' });
  } else {
    const s = protein[0] || other[0];
    if (s) out.push({ when: 'Afternoon', what: s.what });
  }
  // Now and then: listed as "if you have it", which the Macros totals leave out.
  if (shake === 'sometimes') out.push({ when: 'If you have it', what: SHAKE, optional: true });
  return out;
}

// Suggested eating times for someone who asked for eating reminders in About me, so the
// reminders have times to use. The builder can't read their week, so these are ordinary times
// for them to shift. Snacks tied to exercise are left out, because sessions move around.
//
// `fast` (optional) is their daily fast, from fastFor: the same meals are then spread through
// their eating window, with dinner starting an hour before it closes. A snack only gets a time
// when there are at least three hours between the meals either side of it.
function timesFor(snacks, fast) {
  const steady = s => !s.exercise && !s.optional && !s.weeks && !/^With /.test(s.when);
  const morning = snacks.find(s => steady(s) && /morning/i.test(s.when));
  const afternoon = snacks.find(s => steady(s) && /afternoon|after school/i.test(s.when));
  const days = s => (s.days && s.days.join() === 'Mon,Tue,Wed,Thu,Fri' ? ' (Mon to Fri)' : '');
  // Hours on a 24-hour clock: 7.5 is 7:30 am.
  const breakfast = fast ? fast.open : 7.5;
  const dinner = fast ? fast.close - 1 : 18.5;
  const lunch = fast ? (breakfast + dinner) / 2 : 12.5;
  const room = (from, to) => !fast || to - from >= 3;
  // A first meal at 11 am or later isn't really "breakfast", so the meals are named by their order.
  const late = !!fast && fast.open >= 11;
  const out = [{ when: clock(breakfast), what: late ? 'First meal: the plan’s breakfast.' : 'Breakfast.' }];
  if (morning && room(breakfast, lunch)) out.push({ when: clock(fast ? (breakfast + lunch) / 2 : 10) + days(morning), what: (late ? 'Snack: ' : 'Mid-morning snack: ') + morning.what + '.' });
  out.push({ when: clock(lunch), what: late ? 'Second meal: the plan’s lunch.' : 'Lunch.' });
  if (afternoon && room(lunch, dinner)) out.push({ when: clock(fast ? (lunch + dinner) / 2 : 15.5) + days(afternoon), what: (late ? 'Snack: ' : 'Afternoon snack: ') + afternoon.what + '.' });
  out.push({ when: clock(dinner), what: 'Dinner.' });
  return out;
}

// The considerations for someone's fasting (About me): {food: [...] for their tips, exercise:
// [...] for their exercise notes}. The plan fits around fasting they already do; it doesn't
// suggest any, and a daily or sunrise-to-sunset fast doesn't take food away.
function fastNotes(r, answers) {
  const a = answers || {};
  const food = [], exercise = [];
  // Giving up some foods is a change of diet, so it applies at any age.
  if (r.foodFast) {
    const f = r.foodFast;
    const when = (f.days.size ? 'on ' + andList(DAYS.filter(d => f.days.has(d))) : 'every day') + (f.weeks.size ? ' in ' + weeksText([...f.weeks].sort()) : '');
    food.push('You said you go without ' + f.words + ' ' + when + '. Your meals leave ' + (f.tags.length > 1 ? 'them' : 'it') + ' out then, and where the family’s meal doesn’t fit, you have your own. Your snacks fit on every day.');
  }
  // Going without food isn't applied to under-18s: one note, and regular meals.
  const hours = num(a.fast_hours);
  const asked = (hours !== null && hours >= 10) || list(a.fast_days).length || list(a.fast_sun_weeks).length;
  if (r.minor) {
    if (asked) food.push('About me says you fast. This plan doesn’t apply going without food to anyone under 18: it keeps regular meals and snacks through the day. It may be worth talking it over with your GP.');
    return { food, exercise };
  }
  if (r.fast) {
    const f = r.fast;
    const firm = { flexible: ' You said it’s flexible, so on days it doesn’t suit, eat as usual.', most: ' You said you keep to it most days, so on the other days, eat as usual.', daily: '' }[f.firm] || '';
    food.push('You said you aim to go about ' + f.hours + ' hours without food each day. Your suggested eating times run from about ' + clock(f.open) + ' to ' + clock(f.close) + '. The amount of food is the same as without the fast; only the timing changes.' + firm);
    if (f.hours >= 16) food.push('With an eating window of about ' + (24 - f.hours) + ' hours, three meals and snacks sit close together. If it feels like too much at once, an admin can move or merge meals in Edit plan, and a dietitian can suggest what suits.');
  }
  if (r.fastDays) {
    const d = r.fastDays;
    const days = andList(DAYS.filter(x => d.days.has(x)));
    const without = ['breakfast', 'lunch', 'dinner'].filter(x => d.skip.has(x)).concat(d.snacks ? ['snacks'] : []);
    if (without.length) food.push('You said you fast on ' + days + ' and go without ' + andList(without) + ' then. ' + (without.length > 1 ? 'Those are' : 'That is') + ' left out for you on those days and not shopped for. The plan doesn’t set how much to eat on a fast day, and it doesn’t add more on other days. What your GP or dietitian says comes first.');
    else food.push('You said you fast on ' + days + '. Your meals are unchanged on those days: to have some left out, say what you go without in About me and draft the plan again.');
    exercise.push('You said you fast on ' + days + '. Consider easier sessions on those days, and stopping if you feel faint or dizzy.');
  }
  if (r.sunWeeks.length) {
    const weeks = weeksText(r.sunWeeks);
    food.push('You said you’ll be fasting from sunrise to sunset in ' + weeks + '. The plan keeps the same food then and moves it: its breakfast is your meal before dawn, its dinner is your meal at sunset, and its lunch and your snacks are for later in the evening. If that is more than you want at night, an admin can change those weeks in Edit plan. Drinking water between sunset and dawn may help.');
    exercise.push('You said you’ll be fasting from sunrise to sunset in ' + weeks + '. Consider easier sessions then, after your meal at sunset, and drinking water through the evening.');
  }
  // Where fasting meets a condition or medicine they also listed.
  if (r.fast || r.fastDays || r.sunWeeks.length) {
    const lows = r.meds.has('Insulin, or diabetes tablets that can cause low blood sugar') || r.conditions.has('Type 1 diabetes');
    if (lows) food.push('You said you fast and that you have type 1 diabetes or take diabetes medicine that can cause low blood sugar. It may be worth checking your fasting with your diabetes team before you keep to it, and having fast-acting carbs handy.');
    else if (r.meds.size) food.push('Some medicines are taken with food or at set times. Your pharmacist can say whether fasting changes when to take yours.');
    if (r.conditions.has('Pregnant or breastfeeding')) food.push('You said you’re pregnant or breastfeeding and that you fast. It may be worth checking your fasting with your GP or midwife.');
  }
  return { food, exercise };
}

// Suggested eating times for the weeks someone fasts from sunrise to sunset. Sunrise and sunset
// depend on where they live and the time of year, so these are named moments, not clock times
// (the calendar reminders leave them out).
function sunTimes(weeks) {
  const lead = weeks.length >= 4 ? '' : 'In ' + weeksText(weeks) + ': ';
  return [
    { when: 'Before dawn', what: lead + 'the plan’s breakfast.' },
    { when: 'At sunset', what: lead + 'the plan’s dinner.' },
    { when: 'Later in the evening', what: lead + 'the plan’s lunch, and your snacks.' },
  ];
}

// Lines for someone's snacks that are tied to exercise, for a person with a daily eating window:
// sessions move around, so these say where the snack goes, not a clock time.
function exerciseSnackTimes(snacks, fast) {
  const label = { strength: 'After a strength session', active: 'After exercise' };
  return snacks.filter(s => s.exercise && !s.optional && label[s.exercise])
    .map(s => ({ when: label[s.exercise], what: s.what + ', inside your eating window. If the session is before ' + clock(fast.open) + ' or after ' + clock(fast.close) + ', have it with the nearest meal.' }));
}

// "Small steps": new foods to try, each a short step on from a food someone already likes (the
// idea feeding therapists call food chaining). `like` is matched against what they said they
// love, their safe foods and what they usually eat. Each step is [food, how to offer it, tags].
// Tags are the allergy and diet tags the step would break, so those people are never offered it.
const CHAINS = [
  { like: /chips|fries|wedges|potato/, from: 'chips', steps: [
    ['Oven-baked potato wedges', 'Next to the usual chips, a couple of wedges to start.', []],
    ['Sweet potato wedges', 'Baked the same way as the potato wedges, a few on the same plate.', []],
    ['Roast pumpkin wedges', 'Cut and baked like the wedges, one or two beside them.', []],
    ['Roast carrot sticks', 'Baked until soft, a few next to the wedges.', []]] },
  { like: /mac and cheese|macaroni|cheesy pasta|pasta/, from: 'mac and cheese', steps: [
    ['Mac and cheese with a spoon of mashed pumpkin stirred into the sauce', 'It turns the sauce a little more orange and tastes much the same.', ['milk', 'lactose', 'gluten', 'animal']],
    ['Mac and cheese with cauliflower blended into the sauce', 'Blend it smooth so the texture stays the same.', ['milk', 'lactose', 'gluten', 'animal']],
    ['Mac and cheese with a few peas on the side of the bowl', 'On the side, not mixed in, to try one or two.', ['milk', 'lactose', 'gluten', 'animal']],
    ['Mac and cheese with peas stirred through', 'A spoonful to start.', ['milk', 'lactose', 'gluten', 'animal']]] },
  { like: /noodle/, from: 'noodles', steps: [
    ['Noodles with a spoon of sweet corn or peas in the bowl', 'A teaspoon to start, whichever they mind less.', ['gluten']],
    ['Noodles with finely grated carrot cooked in', 'Grated fine, it softens and nearly disappears.', ['gluten']],
    ['Noodles with a few soft-cooked vegetables on the side', 'On the side of the bowl, to try a piece.', ['gluten']],
    ['Noodles with soft vegetables mixed in', 'A small handful, cooked soft.', ['gluten']]] },
  { like: /hot ?pot|stew|casserole|soup|gravy/, from: 'hotpot', steps: [
    ['Hotpot with potato and carrot cooked very soft', 'Cooked long enough to mash with a fork.', []],
    ['Hotpot with pumpkin cooked into the gravy', 'It melts into the gravy and thickens it.', []],
    ['Hotpot with a few peas added at the end', 'A spoonful in their bowl.', []],
    ['Hotpot with one new soft vegetable, like zucchini', 'Cut small and cooked soft.', []]] },
  { like: /nugget|schnitzel|crumbed|chicken/, from: 'chicken nuggets', steps: [
    ['Home-made crumbed chicken strips', 'Baked or air-fried, next to the usual ones.', ['gluten', 'meat', 'poultry', 'animal']],
    ['Crumbed chicken with mashed potato and pumpkin', 'Half potato, half pumpkin in the mash.', ['gluten', 'meat', 'poultry', 'animal']],
    ['Crumbed zucchini sticks', 'Crumbed and baked the same way, one or two beside the chicken.', ['gluten']],
    ['Crumbed chicken with steamed peas', 'A spoonful of peas on the side.', ['gluten', 'meat', 'poultry', 'animal']]] },
  { like: /yoghurt|yogurt|milk|custard|ice cream/, from: 'yoghurt', steps: [
    ['Yoghurt with a little mashed banana stirred in', 'Mashed smooth, a teaspoon to start.', ['milk', 'lactose', 'animal']],
    ['Yoghurt with blended berries', 'Blended smooth and swirled in.', ['milk', 'lactose', 'animal']],
    ['A banana and berry smoothie', 'A small glass, made with milk.', ['milk', 'lactose', 'animal']],
    ['Yoghurt with a few whole berries on top', 'To pick off and try.', ['milk', 'lactose', 'animal']]] },
  { like: /toast|bread|sandwich|croissant|cereal|weet/, from: 'toast', steps: [
    ['Toast with mashed banana', 'Spread thin, like a jam.', ['gluten']],
    ['Fruit bread, toasted', 'A slice in place of the usual toast.', ['gluten']],
    ['Toast with thin slices of strawberry or banana', 'A few slices on one half.', ['gluten']],
    ['Toast with mashed avocado', 'A thin scrape on one corner to start.', ['gluten']]] },
  { like: /pizza|cheese|meat|mince|sausage|burger|rice/, from: 'bolognese or mince', steps: [
    ['Mince or bolognese with finely grated carrot cooked in', 'Grated fine and cooked until it disappears.', ['meat', 'animal']],
    ['The same with grated zucchini as well', 'Peeled first if green bits put them off.', ['meat', 'animal']],
    ['The same with a tin of lentils in place of some of the mince', 'About a quarter lentils to start.', ['meat', 'animal']],
    ['The same with a few soft vegetables left in small pieces', 'Small pieces of the same vegetables they have been eating grated.', ['meat', 'animal']]] },
];

// One small new food a week for someone who isn't keen on vegetables or fruit (and hasn't chosen
// to keep to what they eat now): [{week, food, from, how}]. Steps follow on from a food they like.
// Foods they've already said they liked are skipped, so the next plan carries on from there.
function smallSteps(r, p) {
  if (!(r.gentleVeg || r.gentleFruit) || r.pace === 'own') return [];
  const a = p.answers || {};
  const likes = [a.likes, a.safe_foods, a.usual_day].map(x => String(x || '').toLowerCase()).join(' ');
  // Chains that start from something they like come first, then the rest, so there's always a next step.
  const chains = CHAINS.filter(c => c.like.test(likes)).concat(CHAINS.filter(c => !c.like.test(likes)));
  const ok = ([food, , tags]) => !tags.some(t => r.hard.has(t) || r.diet.has(t))
    && !r.avoidWords.some(w => w && food.toLowerCase().includes(w)) && r.tried[food] !== 'liked';
  // Take turns between the chains (one step from each in order), so the weeks vary.
  const queue = [];
  for (let depth = 0; depth < 4; depth++) {
    for (const c of chains) if (c.steps[depth] && ok(c.steps[depth])) queue.push({ food: c.steps[depth][0], from: c.from, how: c.steps[depth][1] });
  }
  // Mostly stay with the first two chains: early steps from those, before later chains' first steps.
  const mine = chains.slice(0, 2).map(c => c.from);
  queue.sort((x, y) => (mine.includes(y.from) ? 1 : 0) - (mine.includes(x.from) ? 1 : 0));
  return queue.slice(0, 4).map((step, i) => Object.assign({ week: i + 1 }, step));
}

// The person's guide paragraph and tips.
function guideFor(r, p) {
  const bits = [];
  if (r.kid) bits.push('Child-sized serves (about ' + Math.round(r.portion * 100) + '% of an adult serve). Children aren’t put on diets: regular meals and plenty of play is the goal.');
  else if (Math.abs(r.portion - 1) >= 0.05) bits.push('Serves are about ' + Math.round(Math.abs(r.portion - 1) * 100) + '% ' + (r.portion > 1 ? 'bigger' : 'smaller') + ' than average, worked out from your age, size, activity and goal.');
  else bits.push('Serves are about average for your age, size, activity and goal.');
  if (!r.kid && p.measured && p.measured.weight) bits.push('This uses your latest logged weight (' + p.measured.weight + ' kg on ' + p.measured.weightDate + ').');
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
  tips.push(...supplementNotes(r).food);
  tips.push(...fastNotes(r, p.answers).food);
  if (r.conditions.has('Coeliac disease')) tips.push('You said you have coeliac disease: check every label for gluten, including sauces and stock.');
  if (r.conditions.has('Reflux')) tips.push('You mentioned reflux: smaller dinners earlier in the evening may help.');
  if (r.conditions.has('Irritable bowel (IBS)')) tips.push('You mentioned IBS: if some foods (like onion, garlic or beans) bother you, add them to “Foods you won’t eat” in About me and rebuild the plan.');
  const serves = 'about ' + r.target.veg + ' serves of vegetables and ' + r.target.fruit + ' of fruit a day, the guideline amounts for your age';
  const aServe = ' A serve is about half a cup of cooked vegetables or a medium piece of fruit. What your GP or dietitian says comes first.';
  if (r.pace === 'full') tips.push('This plan aims for ' + serves + '.' + aServe);
  else if (r.pace === 'build') tips.push('You chose to build up over the 4 weeks, so weeks 1 and 2 start part of the way and weeks 3 and 4 aim for ' + serves + '.' + aServe);
  else tips.push('You chose to keep close to what you eat now, so nothing has been added to reach the guideline amounts (' + serves + '). The Macros tab shows how your week compares, and you can change this in About me and draft the plan again.');
  if (r.pace !== 'own' && (r.gentleVeg || r.gentleFruit)) {
    const what = r.gentleVeg && r.gentleFruit ? 'vegetables and fruit aren’t' : r.gentleVeg ? 'most vegetables aren’t' : 'fruit isn’t';
    tips.push('You said ' + what + ' a favourite, so where possible they come cooked into meals, soft or blended. Starting with small amounts and building up may be easier, and a GP or dietitian can suggest what suits.');
  }
  if (smallSteps(r, p).length) tips.push('Small steps: each week has one new food to try, a short step on from something you already like. A taste is enough, and there’s no need to finish it. Tick how it went and the next plan carries on from there. A GP, dietitian or feeding therapist can suggest more.');
  tips.push('Drink water through the day.');
  return { guide: bits.join(' '), tips };
}

// The shopping lists: what each meal week needs, in whole packs. Pantry and freezer things go on
// the stock-up list before each fortnight. Leftover pack amounts carry over while they keep.
// Also returns "useUp": for each meal week, the fresh food likely to be left at the end of it.
// `inKitchen` is the food the family already has ({key: [{amount, until}]}, from kitchenStock):
// it is used up before anything is bought.
function shoppingFor(needs, inKitchen) {
  const weekly = needs.map(() => ({}));
  const stock = [{}, {}];
  const onHand = {};   // key -> [{amount, until (week index)}]
  for (const [k, shelf] of Object.entries(inKitchen || {})) onHand[k] = shelf.map(x => ({ amount: x.amount, until: x.until }));
  const useUp = [];    // per meal week: fresh food likely to be left at the end of it
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
    // "Use it up": fresh food that won't keep into next week and still has a fair bit left
    // (a third of a pack or more), biggest share first.
    const left = [];
    for (const [k, shelf] of Object.entries(onHand)) {
      const ing = ING[k];
      if (ing.aisle === 'pantry' || ing.aisle === 'frozen') continue;
      const amount = shelf.filter(x => x.until === w).reduce((n, x) => n + x.amount, 0);
      const share = amount / ing.pack;
      if (share >= 0.33) left.push({ share, text: (share >= 0.7 ? 'most of the ' : share >= 0.45 ? 'about half of the ' : 'about a third of the ') + ing.name.replace(/ × \d+$/, '') });
    }
    useUp.push(left.sort((a, b) => b.share - a.share).slice(0, 6).map(x => x.text));
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
  return { weekly: bought.map(toList), stock: stockBought.map(toList), useUp };
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
  build, rulesFor, portionFor, allowed, exerciseFits, useData, kitchenStock, kitchenPlace,
  get EXERCISES() { return EXERCISES; },
  get LIB() { return LIB; },
};
if (typeof module === 'object' && module.exports) module.exports = PlanBuilder;
else window.PlanBuilder = PlanBuilder;
