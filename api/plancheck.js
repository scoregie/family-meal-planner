// Checks a plan an AI has just written, and gets the AI to correct it before it is saved.
//
// An AI can write a plan that reads well but is short of vegetables, includes a food someone said
// they won't eat, or skips a health condition. So after the first draft:
//   1. the app measures the plan itself (problems, below) and writes a list of what it found;
//   2. the AI is sent that list with a checklist (fixRequest) and replies with a small set of
//      corrections, not a whole new plan;
//   3. the corrections are applied (applyFixes) and kept only if the plan still passes the app's
//      checks and measures no worse than before (improve).
// Nothing here approves anything: the corrected draft still waits for an admin.
const healthtargets = require('./healthtargets');
const { HOW_MUCH } = require('./planbuilder');   // tells "2 jars, opened" from the name of a food

const WORDS = { veg: 'vegetables', fruit: 'fruit' };
const ABSOLUTES = /\b(always|never|must)\b/i;
const PERSON_PARTS = ['snacks', 'tips', 'guide', 'steps'];   // the parts of a person a correction may replace
const MAX_FIXES = 200;                                       // most items in any one list of corrections

// The meal weeks of a plan (stock-up weeks have no meals), in order: week 1 is first.
function mealWeeks(plan) {
  return (plan.weeks || []).filter(w => Array.isArray(w.meals));
}

// Every piece of text inside a value (a string, a list, or an object), joined in lower case.
function textOf(value) {
  if (typeof value === 'string') return value.toLowerCase();
  if (Array.isArray(value)) return value.map(textOf).join(' \n ');
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join(' \n ');
  return '';
}

// Weeks where someone's vegetables or fruit are more than half a serve under what their pace
// asks for that week, as sentences for the plan writer.
function shortWeeks(plan, p) {
  const out = [];
  for (let n = 1; n <= mealWeeks(plan).length; n++) {
    const aim = healthtargets.weekTarget(p.answers, n);
    if (!aim) return [];   // they chose to keep close to what they eat now
    const got = healthtargets.dailyAverage(plan, p.key, [n]);
    for (const g of ['veg', 'fruit']) {
      const gap = aim[g] - got[g];
      if (gap <= healthtargets.CLOSE) continue;
      out.push(p.name + ' (key "' + p.key + '"), week ' + n + ': the plan gives about ' + got[g].toFixed(1) + ' serves of ' + WORDS[g] +
        ' a day and the aim that week is ' + aim[g].toFixed(1) + '. Add about ' + gap.toFixed(1) + ' serves a day, as snacks or sides written for them' +
        ' (with "weeks" if it is only for some weeks), each with a "groups" entry.');
    }
  }
  return out;
}

// The foods someone named in "Foods you won't eat", as lower-case phrases to look for. Sweeping
// answers ("most veggies") are left out: those change the form food comes in, not what is in it.
function namedDislikes(answers) {
  const out = new Set();
  for (const raw of String((answers || {}).dislikes || '').toLowerCase().split(/[,;.\n()]|\band\b|\bor\b/)) {
    const term = raw.replace(/[^a-z' -]/g, ' ').replace(/\s+/g, ' ').trim();
    const words = term.split(' ');
    if (term.length < 4 || words.length > 4 || /\b(most|all|any|anything|every|much|many|lots?|too|no|not)\b/.test(term)) continue;
    out.add(term);
    // "long green beans" also means "green beans".
    if (words.length > 2) out.add(words.slice(-2).join(' '));
  }
  return [...out];
}

// True if a text names a food as a whole word ("corn", not "cornflour"), in the singular or the
// plural, and not straight after "no", "not" or "without" ("frozen vegetables (no corn)").
function mentions(text, term) {
  const base = term.replace(/s$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<!\\b(?:no|not|without)\\s)\\b' + base + '(?:s|es)?\\b').test(text);
}

// Named foods someone won't eat that turn up in dishes they are given, as sentences.
function dislikedFoods(plan, p) {
  const terms = namedDislikes(p.answers);
  const person = (plan.people || {})[p.key];
  if (!terms.length || !person) return [];
  const found = new Map();   // phrase -> the first place it was seen
  mealWeeks(plan).forEach((week, i) => {
    for (const meal of week.meals) {
      for (const row of healthtargets.eatenOn(week, meal, person, p.key, i + 1)) {
        const key = healthtargets.nameKey(row.name);
        const recipe = (week.recipes || []).find(r => r && typeof r === 'object' && healthtargets.nameKey(r.name) === key);
        const text = key + ' \n ' + textOf(recipe ? [recipe.ingredients, recipe.items, recipe.steps] : '');
        for (const term of terms) {
          if (!found.has(term) && mentions(text, term)) found.set(term, row.name + ' (' + week.name + ')');
        }
      }
    }
  });
  return [...found].map(([term, where]) => p.name + ' said they won’t eat "' + term + '", and it seems to be in ' + where +
    '. If it is, swap it for something that fits (a "replace"), and take it off the shopping lists (a "remove") unless someone else eats it.');
}

// Health text that uses "always", "never" or "must", as sentences.
function absoluteWords(plan, p) {
  const person = (plan.people || {})[p.key] || {};
  const exercise = (plan.exercise || {})[p.key] || {};
  const parts = { tips: person.tips, guide: person.guide, steps: person.steps, 'exercise medical': exercise.medical, 'exercise notes': exercise.notes };
  const out = [];
  for (const [part, value] of Object.entries(parts)) {
    const hit = textOf(value).match(ABSOLUTES);
    if (hit) out.push(p.name + '’s ' + part + ' use the word "' + hit[1].toLowerCase() + '". Reword it without absolutes ("consider", "may", "most of the time").');
  }
  return out;
}

// Protein powder that isn't where the person's answers say it should be, as sentences. An adult
// who has it on set days gets it as a counted snack; anyone under 18 gets none.
function proteinPowder(plan, p) {
  const a = p.answers || {};
  const person = (plan.people || {})[p.key] || {};
  const shakes = (person.snacks || []).filter(s => s && /protein (shake|powder)/i.test(String(s.what || '')));
  const takes = Array.isArray(a.supplements) && a.supplements.includes('Protein powder');
  const age = a.age === undefined || a.age === null || a.age === '' ? null : Number(a.age);
  if (age !== null && age < 18) {
    return shakes.length ? [p.name + ' is under 18 and has a protein shake in their snacks. Take it out: supplements aren’t counted or planned for under-18s.'] : [];
  }
  const setDays = ['Every day', 'On days I exercise', 'After strength training'].includes(a.protein_powder_when);
  if (!takes || !setDays) return [];
  const counted = shakes.filter(s => !s.optional);
  if (!counted.length) return [p.name + ' said they have protein powder (' + a.protein_powder_when.toLowerCase() + '), and it isn’t a counted snack in their plan. Add "Protein shake (1 scoop of your own powder)" to their snacks in place of another protein snack, with a "macros" entry.'];
  const macros = Object.keys(plan.macros || {}).map(healthtargets.nameKey);
  const missing = counted.find(s => !macros.includes(healthtargets.nameKey(s.what)));
  return missing ? [p.name + '’s snack "' + missing.what + '" has no "macros" entry, so it isn’t counted. Add one (about 24 g protein, 2 g carbs, 2 g fat, 510 kJ for a scoop mixed with water).'] : [];
}

// The food in a Current food line, without the amount, the pack, the brand in brackets or the
// part after a comma that says how much is left: "2 tins diced tomatoes" is "diced tomatoes",
// "Wholemeal bread, 1 loaf (Wonder)" is "wholemeal bread".
function foodName(text) {
  const bits = String(text || '').toLowerCase().replace(/\([^)]*\)/g, ' ').split(',');
  // Keep the parts that still name food ("carrot, cauliflower and broccoli"); stop at how much.
  let named = 1;
  while (named < bits.length && !HOW_MUCH.test(bits[named])) named++;
  return bits.slice(0, named).join(' ')
    .replace(/(\d+(?:\.\d+)?)\s*(kg|g|grams?|ml|l|litres?|liters?)?\b/g, ' ')
    .replace(/\b(tins?|cans?|packs?|packets?|bags?|boxe?s?|bottles?|jars?|cartons?|tubs?|loaf|loaves|bunch(es)?|heads?|pieces?|of|a|an|some|half|dozen|about|x)\b/g, ' ')
    .replace(/[^a-zÀ-ɏ' -]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Words in a food's name that don't say which food it is ("frozen peas" is about the peas).
const PLAIN_WORDS = new Set(['frozen', 'fresh', 'dried', 'canned', 'tinned', 'diced', 'sliced', 'chopped', 'whole', 'raw', 'cooked',
  'fillet', 'fillets', 'fruit', 'vegetable', 'vegetables', 'veg', 'mixed', 'free', 'range', 'lean', 'large', 'small', 'big', 'and', 'the', 'with',
  'style', 'cut', 'full', 'cream', 'recipe', 'base', 'pieces', 'chunks', 'portions', 'red', 'green', 'white', 'brown', 'ground', 'crushed',
  'springwater', 'brine', 'net', 'pre-cut', 'loose', 'bag', 'block']);

// Last words that many different foods share ("teriyaki sauce" and "soy sauce" are both a sauce),
// so a food ending in one only counts as used when the rest of its name is there too.
const SHARED_WORDS = new Set(['sauce', 'paste', 'powder', 'seasoning', 'oil', 'juice', 'dressing', 'soup', 'stock', 'mix', 'kit', 'meal',
  'blend', 'sugar', 'flour', 'cheese', 'cheeses', 'beans', 'bars', 'chips', 'drink', 'essence', 'vinegar', 'mustard', 'pepper', 'salt',
  'crackers', 'cereal', 'pies', 'seeds', 'sticks', 'leaves', 'flakes', 'pulp', 'salad', 'spread', 'syrup', 'wine', 'pickles', 'cup']);

// Things kept with the food that aren't cooked into meals (drinks, baking and decorating). A plan
// isn't asked to use these.
const NOT_FOR_MEALS = /\b(tea|teas|tea bags?|coffee|decaf|cordial|soft drinks?|drink powder|fruit drink|poppers?|bitters|sugar|icing|flour|bicarb|baking (soda|powder)|yeast|food colouring|colouring|sprinkles|decorating|vanilla essence|cooking spray|gum|lollies|chocolate drink)\b/;

// Whether a plan's text uses a food: its whole name is there, or most of the words that tell it
// apart are ("jasmine rice" is used by a recipe with "rice"; "teriyaki sauce" isn't used by one
// with "soy sauce"). It reads words, not amounts, so it is a guide, not a count.
function usesFood(text, name) {
  const named = term => mentions(text, term) || (/oes$/.test(term) && mentions(text, term.slice(0, -2)))
    || (/ies$/.test(term) && mentions(text, term.slice(0, -3) + 'y'));
  if (named(name)) return true;
  const words = telling(name);
  if (!words.length) return false;
  const found = words.filter(named).length;
  if (found / words.length >= 0.66) return true;
  const last = words[words.length - 1];
  // "Jasmine rice": the food itself (the last word, or the first) and half its words are enough.
  return !SHARED_WORDS.has(last) && (named(last) || named(words[0])) && found / words.length >= 0.5;
}

// The things on Current food that no meal, recipe or snack in the plan uses, as they were typed.
// `food` is a list of {text, place}. Drinks and baking things are left out: they aren't for meals.
function unusedFood(plan, food) {
  const weeks = mealWeeks(plan);
  const text = textOf([weeks.map(w => [w.meals, w.recipes]), Object.values(plan.people || {}).map(p => p && p.snacks)]);
  const out = [];
  for (const item of Array.isArray(food) ? food : []) {
    const name = foodName(item && item.text);
    if (!name || NOT_FOR_MEALS.test(name)) continue;
    if (!usesFood(text, name)) out.push(String(item.text));
  }
  return out;
}

// The words in a food's name that tell it apart from other foods.
const telling = name => name.split(' ').filter(w => w.length > 2 && !PLAIN_WORDS.has(w));
// A word without its plural ending: "tomatoes" and "tomato", "berries" and "berry".
const singular = w => w.replace(/ies$/, 'y').replace(/oes$/, 'o').replace(/s$/, '');

// Food on the first shopping lists (Stock-up 1 and Week 1) that Current food says is already at
// home, like ["Turkey mince 500 g (at home: Turkey mince (Steggles))"]. Buying a top-up is fine
// when the recipes need more than is there, so this is something to check, not a mistake.
function boughtAgain(plan, food) {
  const lists = (plan.weeks || []).filter(w => w && (w.name === 'Stock-up 1' || w.name === 'Week 1'));
  const home = (Array.isArray(food) ? food : []).filter(item => item && item.place !== 'spices')
    .map(item => ({ text: String(item.text), name: foodName(item.text) })).filter(x => x.name && !NOT_FOR_MEALS.test(x.name));
  const out = [];
  for (const week of lists) {
    for (const items of Object.values(week.shopping || {})) {
      for (const it of Array.isArray(items) ? items : []) {
        const bought = foodName(Array.isArray(it) ? it[0] : '');
        if (!bought) continue;
        // The same food: it ends in the same word ("wholemeal wraps" and "wraps", but not "egg
        // noodles" and "egg"), and one name holds every telling word of the other ("rice" and
        // "jasmine rice", but not "turkey mince" and "beef mince").
        const boughtLast = telling(bought).pop();
        const same = home.filter(h => {
          const words = telling(h.name);
          const last = words[words.length - 1];
          if (!last || !boughtLast || (SHARED_WORDS.has(last) && words.length < 2)) return false;
          if (singular(last) !== singular(boughtLast)) return false;
          return words.every(w => mentions(bought, w)) || telling(bought).every(w => mentions(h.name, w));
        });
        // The closest one: the same name if there is one, else the one with the most words.
        const match = same.find(h => h.name === bought) || same.sort((a, b) => telling(b.name).length - telling(a.name).length)[0];
        if (match) out.push(it[0] + ' (at home: ' + match.text + ')');
      }
    }
  }
  return out;
}

// What the plan writer is told about Current food: what the plan doesn't use, and what the first
// shopping lists buy that is already at home (none: an empty list).
function foodProblems(plan, food) {
  const out = [];
  const unused = unusedFood(plan, food);
  if (unused.length) out.push('The family already has these at home (Current food) and no meal, recipe or snack uses them: ' + unused.slice(0, 30).join('; ') + '. Where it suits everyone’s answers, use them in a meal or as a side, and take what they cover off the shopping lists.');
  const again = boughtAgain(plan, food);
  if (again.length) out.push('These are on the Stock-up 1 or Week 1 shopping lists, and Current food says they are already at home: ' + again.slice(0, 20).join('; ') + '. Check each against what weeks 1 and 2 use: take it off if what is at home covers it, or buy only the extra the recipes need.');
  return out;
}

// Everything the app itself can find wrong with a plan, as a list of sentences for the plan
// writer (empty when it finds nothing). `people` is a list of {key, name, answers}. `food`
// (optional) is the Current food list, as [{text, place}].
function problems(plan, people, food) {
  const out = [];
  for (const p of people) {
    if (!plan.people || !plan.people[p.key]) continue;
    out.push(...shortWeeks(plan, p), ...dislikedFoods(plan, p), ...absoluteWords(plan, p), ...proteinPowder(plan, p));
  }
  out.push(...foodProblems(plan, food));
  return out;
}

// What each person said that the plan's health notes should cover, one line per person.
function saidLines(people) {
  const lines = [];
  for (const p of people) {
    const a = p.answers || {};
    const list = v => (Array.isArray(v) ? v : []).filter(x => x && x !== 'None' && x !== 'None of these');
    const bits = [];
    if (list(a.conditions).length || a.conditions_other) bits.push('conditions: ' + [...list(a.conditions), a.conditions_other].filter(Boolean).join('; '));
    if (list(a.medicine_types).length || a.medicines) bits.push('medicines: ' + [...list(a.medicine_types), a.medicines].filter(Boolean).join('; '));
    if (list(a.supplements).length) bits.push('supplements they already take: ' + list(a.supplements).join('; ') + (a.protein_powder_when ? ' (protein powder: ' + a.protein_powder_when + ')' : ''));
    if (a.fast_hours) bits.push('fasts about ' + a.fast_hours + ' hours a day' + (a.fast_first_meal ? ', first meal ' + String(a.fast_first_meal).toLowerCase() : '') + (a.fast_firm ? ' (' + a.fast_firm + ')' : ''));
    if (list(a.fast_days).length) bits.push('fast days each week: ' + list(a.fast_days).join(', ') + (list(a.fast_day_skip).length ? ', going without ' + list(a.fast_day_skip).join(', ').toLowerCase() : ''));
    if (list(a.fast_sun_weeks).length) bits.push('fasting from sunrise to sunset in ' + list(a.fast_sun_weeks).join(', '));
    if (a.fast_food) bits.push('gives up food: ' + a.fast_food + (list(a.fast_food_days).length ? ' on ' + list(a.fast_food_days).join(', ') : ' every day') + (list(a.fast_food_weeks).length ? ' in ' + list(a.fast_food_weeks).join(', ') : ''));
    if (list(a.allergies).length || a.allergies_other) bits.push('allergies: ' + [...list(a.allergies), a.allergies_other].filter(Boolean).join('; '));
    if (a.dislikes) bits.push('won’t eat: ' + a.dislikes);
    if (list(a.sensory).length) bits.push('hard textures: ' + list(a.sensory).join('; '));
    if (bits.length) lines.push('- ' + p.name + ' (key "' + p.key + '"): ' + bits.join(' | '));
  }
  return lines;
}

// The message that sends the AI back over its own plan: what the app measured, a checklist, and
// the shape of the corrections to reply with.
function fixRequest(plan, people, food) {
  const found = problems(plan, people, food);
  return [
    'The app has checked the plan you just wrote. Go back over it once more before the family sees it.',
    '',
    found.length ? 'What the app measured (fix every one of these):' : 'The app’s own measurements found nothing wrong.',
    ...found.map(f => '- ' + f),
    '',
    'Then check these yourself, person by person, against what they said:',
    ...saidLines(people),
    '1. No dish, snack or recipe a person is given contains a food they are allergic to or named as one they won’t eat.',
    '2. Every condition, medicine and supplement above has a hedged consideration in that person’s tips (food) or exercise medical list (exercise), with a pointer to their GP or other health professional. Nothing suggests starting, stopping or changing a supplement, and under-18s’ supplements are noted, not counted.',
    '3. Snacks and sides avoid the textures that person finds hard.',
    '3b. Fasting is fitted around as each person described it, with a tip that says what was done: a daily fast or sunrise-to-sunset weeks keep the same amount of food with the timing changed; fast days leave out only the meals they said they go without; foods they give up are out of their meals and snacks on those days. Nothing suggests or praises fasting, and going without food isn’t applied to under-18s.',
    '4. Anything said about blood test results matches the newest date on the report: a flag belongs only to the date it is printed under, so don’t carry over flags from earlier dates.',
    '5. Health text reports what the person said, calls itself considerations (not advice), and has no "always", "never" or "must".',
    '6. Every snack and dish name used has an entry in "groups" and "macros", and anything you add is on a shopping list.',
    '',
    'Reply with one JSON object of corrections and nothing else (no prose, no code fences). Leave out any part you are not changing; reply {} if nothing needs to change. Don’t send the whole plan again.',
    '{',
    '  "people": {"<person key>": {"snacks": [...], "tips": [...], "guide": "...", "steps": [...]}},   each part you give replaces that whole part, so include the entries you are keeping',
    '  "medical": {"<person key>": ["..."]},   replaces that person’s exercise medical list',
    '  "groups": {"<dish or snack name>": {...}}, "macros": {"<name>": {...}},   entries to add or replace',
    '  "replace": [{"find": "green beans or broccoli", "with": "broccoli"}],   exact text swapped wherever it appears in the weeks (dish names, recipes, shopping)',
    '  "remove": ["Green beans 250 g"],   shopping items to take off every list (the start of the item’s name)',
    '  "shopping": [{"week": "Week 1", "section": "Fruit and veg", "item": "Pumpkin 1 kg", "price": 4.5}],   items to add, by week name',
    '  "recipes": ["Smooth pumpkin soup: simmer ... Makes about 5 cups."],   short one-line recipes for new sides, added to every meal week',
    '  "notesForAdmin": "..."   the note for the admin, rewritten if your corrections change what it says',
    '}',
  ].join('\n');
}

// The corrections from the AI's reply: the JSON from the first "{" to the last "}". Throws if it
// isn't JSON.
function parseFixes(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no corrections in the reply');
  const fixes = JSON.parse(text.slice(start, end + 1));
  if (!fixes || typeof fixes !== 'object' || Array.isArray(fixes)) throw new Error('the corrections were the wrong shape');
  return fixes;
}

// A list from the corrections, or an empty list if that part is missing or the wrong shape.
function listOf(value) {
  return Array.isArray(value) ? value.slice(0, MAX_FIXES) : [];
}

// Swaps `find` for `put` in every piece of text inside a value, and returns the new value.
function swapText(value, find, put) {
  if (typeof value === 'string') return value.split(find).join(put);
  if (Array.isArray(value)) return value.map(v => swapText(v, find, put));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = swapText(v, find, put);
    return out;
  }
  return value;
}

// A copy of the plan with the AI's corrections applied. `known` is the set of person keys in the
// household; corrections for anyone else are ignored. The plan passed in is left untouched.
// Returns {plan, changed} where `changed` counts the corrections that were used.
function applyFixes(plan, fixes, known) {
  const next = JSON.parse(JSON.stringify(plan));
  let changed = 0;

  for (const [key, parts] of Object.entries(fixes.people || {})) {
    if (!known.has(key) || !next.people[key] || !parts || typeof parts !== 'object') continue;
    for (const part of PERSON_PARTS) {
      const value = parts[part];
      if (part === 'guide' ? typeof value !== 'string' : !Array.isArray(value)) continue;
      next.people[key][part] = value;
      changed++;
    }
  }
  for (const [key, list] of Object.entries(fixes.medical || {})) {
    if (!known.has(key) || !Array.isArray(list) || !list.every(x => typeof x === 'string')) continue;
    next.exercise = next.exercise || {};
    next.exercise[key] = next.exercise[key] || {};
    next.exercise[key].medical = list;
    changed++;
  }
  for (const block of ['groups', 'macros']) {
    for (const [name, value] of Object.entries(fixes[block] || {}).slice(0, MAX_FIXES)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      next[block] = next[block] || {};
      next[block][name] = value;
      changed++;
    }
  }
  for (const swap of listOf(fixes.replace)) {
    const find = swap && typeof swap.find === 'string' ? swap.find : '';
    if (find.length < 3 || typeof swap.with !== 'string') continue;
    next.weeks = swapText(next.weeks, find, swap.with);
    // A renamed dish keeps its food groups and macros under the new name.
    for (const block of ['groups', 'macros']) {
      for (const name of Object.keys(next[block] || {})) {
        if (!name.includes(find)) continue;
        const renamed = name.split(find).join(swap.with);
        if (!(renamed in next[block])) next[block][renamed] = next[block][name];
      }
    }
    changed++;
  }
  const remove = listOf(fixes.remove).filter(x => typeof x === 'string' && x.trim().length >= 3).map(x => x.trim().toLowerCase());
  for (const week of next.weeks || []) {
    for (const [section, items] of Object.entries(week.shopping || {})) {
      const kept = items.filter(it => !remove.some(r => String(it[0]).toLowerCase().startsWith(r)));
      if (kept.length !== items.length) { week.shopping[section] = kept; changed++; }
    }
  }
  for (const add of listOf(fixes.shopping)) {
    const week = add && (next.weeks || []).find(w => w.name === add.week);
    const price = Number(add && add.price);
    if (!week || typeof add.item !== 'string' || !add.item.trim() || !Number.isFinite(price) || price < 0) continue;
    week.shopping = week.shopping || {};
    const section = typeof add.section === 'string' && add.section.trim() ? add.section.trim() : Object.keys(week.shopping)[0] || 'Extras';
    (week.shopping[section] = week.shopping[section] || []).push([add.item.trim(), price]);
    changed++;
  }
  const recipes = listOf(fixes.recipes).filter(x => typeof x === 'string' && x.trim());
  if (recipes.length) {
    for (const week of mealWeeks(next)) week.recipes = [...(week.recipes || []), ...recipes];
    changed++;
  }
  return { plan: next, changed };
}

// Sends the AI back over its plan and returns the better of the two versions:
//   {plan, notes, note}
// `ask(message)` sends the follow-up and resolves to the AI's reply ('' if it couldn't finish).
// `checkPlan(plan)` is the app's shape check (it returns a problem, or nothing). `notes` is the
// AI's note for the admin (rewritten by the corrections, if it sent one). `note` is a sentence
// from the app about how the check went. The first draft is kept whenever the corrections can't
// be read, break the plan's shape, or measure worse.
async function improve(plan, people, notes, ask, checkPlan, food) {
  const before = problems(plan, people, food);
  const reply = await ask(fixRequest(plan, people, food));
  const asWritten = note => ({ plan, notes, note });
  if (!reply) return asWritten('The second check of this plan couldn’t be finished, so this is the first draft as written.');
  let fixed;
  let newNotes = notes;
  try {
    const fixes = parseFixes(reply);
    fixed = applyFixes(plan, fixes, new Set(people.map(p => p.key)));
    if (typeof fixes.notesForAdmin === 'string' && fixes.notesForAdmin.trim()) newNotes = fixes.notesForAdmin.slice(0, 2000);
  } catch (e) {
    return asWritten('The corrections from the second check couldn’t be read, so this is the first draft as written.');
  }
  if (!fixed.changed) return { plan, notes: newNotes, note: '' };
  let broken;
  try { broken = checkPlan(fixed.plan); } catch (e) { broken = String(e.message || e); }
  const after = broken ? before : problems(fixed.plan, people, food);
  if (broken || after.length > before.length) return asWritten('The corrections from the second check didn’t fit the plan, so this is the first draft as written.');
  const count = before.length ? ' (the app’s own checks found ' + before.length + ' thing' + (before.length === 1 ? '' : 's') + ' to fix)' : '';
  return { plan: fixed.plan, notes: newNotes, changed: true, note: 'The AI went back over this plan and made corrections' + count + '.' };
}

module.exports = { problems, fixRequest, parseFixes, applyFixes, improve, namedDislikes, mentions, unusedFood, boughtAgain, foodName };
