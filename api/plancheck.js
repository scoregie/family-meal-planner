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

// Everything the app itself can find wrong with a plan, as a list of sentences for the plan
// writer (empty when it finds nothing). `people` is a list of {key, name, answers}.
function problems(plan, people) {
  const out = [];
  for (const p of people) {
    if (!plan.people || !plan.people[p.key]) continue;
    out.push(...shortWeeks(plan, p), ...dislikedFoods(plan, p), ...absoluteWords(plan, p));
  }
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
    if (list(a.allergies).length || a.allergies_other) bits.push('allergies: ' + [...list(a.allergies), a.allergies_other].filter(Boolean).join('; '));
    if (a.dislikes) bits.push('won’t eat: ' + a.dislikes);
    if (list(a.sensory).length) bits.push('hard textures: ' + list(a.sensory).join('; '));
    if (bits.length) lines.push('- ' + p.name + ' (key "' + p.key + '"): ' + bits.join(' | '));
  }
  return lines;
}

// The message that sends the AI back over its own plan: what the app measured, a checklist, and
// the shape of the corrections to reply with.
function fixRequest(plan, people) {
  const found = problems(plan, people);
  return [
    'The app has checked the plan you just wrote. Go back over it once more before the family sees it.',
    '',
    found.length ? 'What the app measured (fix every one of these):' : 'The app’s own measurements found nothing wrong.',
    ...found.map(f => '- ' + f),
    '',
    'Then check these yourself, person by person, against what they said:',
    ...saidLines(people),
    '1. No dish, snack or recipe a person is given contains a food they are allergic to or named as one they won’t eat.',
    '2. Every condition and medicine above has a hedged consideration in that person’s tips (food) or exercise medical list (exercise), with a pointer to their GP or other health professional.',
    '3. Snacks and sides avoid the textures that person finds hard.',
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
async function improve(plan, people, notes, ask, checkPlan) {
  const before = problems(plan, people);
  const reply = await ask(fixRequest(plan, people));
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
  const after = broken ? before : problems(fixed.plan, people);
  if (broken || after.length > before.length) return asWritten('The corrections from the second check didn’t fit the plan, so this is the first draft as written.');
  const count = before.length ? ' (the app’s own checks found ' + before.length + ' thing' + (before.length === 1 ? '' : 's') + ' to fix)' : '';
  return { plan: fixed.plan, notes: newNotes, changed: true, note: 'The AI went back over this plan and made corrections' + count + '.' };
}

module.exports = { problems, fixRequest, parseFixes, applyFixes, improve, namedDislikes, mentions };
