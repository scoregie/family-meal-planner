// New meals, snacks and exercises for the built-in plan builder, every 2 weeks.
//
// Two ways in, both checked strictly before anything reaches the library:
//   1. The project's shared additions (library-community.json), downloaded from GitHub. No AI is
//      needed, so families on "No AI" get new meals and exercises too. It is data only: never code.
//   2. If the family uses an AI, it can write new ones aimed at the family (what they rate well,
//      the cuisines they like, what they can't eat). These wait for an admin to approve them.
//
// New dishes may only use ingredients already in library.json. Their nutrition, food groups,
// allergen tags and cost are worked out here from those ingredients (USDA FoodData Central values),
// the same way tools/build_library.py does it, so nothing about nutrition or allergens is taken on trust.
//
//   GET  /api/library/updates           admins: settings, last runs, what's waiting, counts
//   PUT  /api/library/updates           admins: {auto, ai} turn the two kinds on or off
//   POST /api/library/updates/check     admins: download the shared additions now
//   POST /api/library/updates/write     admins: have the family's AI write some now (in the background)
//   POST /api/library/updates/approve   admins: {ids} or {all: true}: add waiting ones to the library
//   POST /api/library/updates/discard   admins: {ids} or {all: true}: throw waiting ones away
const fs = require('fs');
const path = require('path');
const db = require('./db');
const ai = require('./ai');
const assistant = require('./assistant');
const planbuilder = require('./planbuilder');
const { send, readBody } = require('./requests');   // reading what a page sent, and sending JSON back

const LIB = planbuilder.LIB;
const EXERCISES = planbuilder.EXERCISES;
const DATA_DIR = process.env.DATA_DIR || '/data';
const BUNDLED = path.join(__dirname, 'library-community.json');      // shipped with this version
const DOWNLOADED = path.join(DATA_DIR, 'library-community.json');   // a newer copy from GitHub
const OWN = path.join(DATA_DIR, 'library-additions.json');          // this family's approved AI-written ones
const UPDATE_URL = process.env.LIBRARY_UPDATES_URL
  || 'https://raw.githubusercontent.com/scoregie/family-meal-planner/main/api/library-community.json';
const EVERY = 14 * 24 * 3600 * 1000;   // every 2 weeks
const MAX_DOWNLOAD = 2e6;

// What the library holds before any additions, so additions can be re-applied cleanly.
const BASE = { dishes: LIB.dishes.length, snacks: LIB.snacks.length, exercises: EXERCISES.length };

// ---------------------------------------------------------------------------
// Nutrition, groups, tags and cost (a copy of tools/build_library.py's sums)
// ---------------------------------------------------------------------------

const GRAIN_SERVE = { bread: 40, wraps: 40, rolls: 40, pita: 40, 'fruit bread': 40, crackers: 35, 'rice crackers': 35, oats: 30, 'weet-bix': 30, muesli: 30 };
const DAIRY_SERVE = { milk: 250, 'greek yoghurt': 200, 'cottage cheese': 120, ricotta: 120 };

// Grams of an ingredient: amounts of things counted one by one ("each", like eggs) are turned
// into grams using the weight of one.
function grams(ing, amount) {
  return ing.unit === 'each' ? amount * ing.each : amount;
}

// Works out a dish's nutrition from its ingredients: macros (protein, carbs, fat, kJ), food groups
// (serves of veg, fruit and so on) and tags (like "gluten" or "dairy", used for allergies).
function nutrition(per) {
  const m = { p: 0, c: 0, f: 0, kj: 0 };
  const g = { veg: 0, fruit: 0, grain: 0, protein: 0, dairy: 0, fv: 0, leg: 0, red: 0, fish: 0, oily: 0, side: 0, gc: 0, mp: 0, ca: 0 };
  const tags = new Set();
  for (const [key, amount] of per) {
    const ing = LIB.ingredients[key];
    const w = grams(ing, amount);
    const n = ing.per100;
    for (const k of Object.keys(m)) m[k] += n[k] * w / 100;
    (ing.tags || []).forEach(t => tags.add(t));
    const kind = ing.kind;
    if (kind === 'veg') { g.veg += w / 75; g.fv += w; g.side += w; }
    else if (kind === 'potato') { g.veg += w / 75; g.side += w; }
    else if (kind === 'fruit') { g.fruit += w / 150; g.fv += w; }
    else if (kind === 'grain') { g.grain += w / (GRAIN_SERVE[key] || 30); g.gc += n.c * w / 100; }
    else if (kind === 'red' || kind === 'processed') {
      if (kind === 'red') g.protein += w / 90;
      g.red += w * (kind === 'red' ? 0.7 : 0.85); g.mp += n.p * w / 100;
    }
    else if (kind === 'poultry') { g.protein += w / 100; g.mp += n.p * w / 100; }
    else if (kind === 'fish' || kind === 'oily') {
      g.protein += w / 115; g.fish += w; g.mp += n.p * w / 100;
      if (kind === 'oily') g.oily += w;
    }
    else if (kind === 'egg') { g.protein += w / 100; g.mp += n.p * w / 100; }
    else if (kind === 'legume') { g.protein += w / 150; g.leg += w; g.mp += n.p * w / 100; }
    else if (kind === 'tofu') { g.protein += w / 170; g.mp += n.p * w / 100; }
    else if (kind === 'nut') g.protein += w / 30;
    else if (kind === 'dairy') { g.dairy += w / (DAIRY_SERVE[key] || 40); g.ca += n.ca * w / 100; }
  }
  // Python's round() rounds halves to even; this matches it so results agree with library.json.
  const pyRound = (v, places = 0) => {
    const f = 10 ** places;
    const x = v * f;
    const r = Math.round(x);
    return (Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) / f;
  };
  const macros = { p: pyRound(m.p), c: pyRound(m.c), f: pyRound(m.f), kj: pyRound(m.kj / 10) * 10 };
  const groups = {};
  for (const [k, v] of Object.entries(g)) {
    if (v) groups[k] = ['veg', 'fruit', 'grain', 'protein', 'dairy'].includes(k) ? pyRound(v, 1) : pyRound(v);
  }
  return { macros, groups, tags: [...tags].sort() };
}

// What one serve costs, from each ingredient's pack price (in Australian dollars).
function cost(per) {
  let sum = 0;
  for (const [key, amount] of per) {
    const ing = LIB.ingredients[key];
    if (ing.pack) sum += ing.price / ing.pack * amount;
  }
  return Math.round(sum * 100) / 100;
}

// ---------------------------------------------------------------------------
// Checking new entries
// ---------------------------------------------------------------------------

const MEALS = ['breakfast', 'lunch', 'dinner'];
const KITS = ['blender', 'microwave', 'oven', 'slow cooker', 'stovetop'];
const TEXTURES = ['mixed', 'soft', 'crunchy'];
const SNACK_KINDS = ['protein', 'fruit', 'veg', 'other'];
const EX_TYPES = ['warmup', 'squat', 'lunge', 'hinge', 'push', 'pull', 'core', 'calf', 'balance', 'arms', 'mobility'];
const EX_EQUIP = ['none', 'bands', 'dumbbells', 'gym'];
const EX_FLAGS = ['floor', 'supine', 'prone', 'knees', 'back', 'shoulders', 'wrists', 'hips', 'balance', 'impact', 'seated', 'chair'];
// Energy for one average serve, by meal: outside this, something is probably wrong with the amounts.
const KJ_RANGE = { breakfast: [800, 3500], lunch: [1000, 4000], dinner: [1500, 5000], snack: [200, 1500] };

// Plain text: control characters and angle brackets removed, spaces tidied, cut to `max`.
function text(v, min, max) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length >= min && t.length <= max ? t : null;
}

const idOf = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The ingredient list [[key, amount], ...] if every key is in the library and every amount is sensible.
function checkPer(per, min) {
  if (!Array.isArray(per) || per.length < min || per.length > 12) return { error: 'needs ' + min + ' to 12 ingredients' };
  const out = [];
  const seen = new Set();
  for (const row of per) {
    if (!Array.isArray(row) || row.length !== 2) return { error: 'an ingredient isn’t [name, amount]' };
    const [key, amount] = row;
    const ing = typeof key === 'string' && Object.prototype.hasOwnProperty.call(LIB.ingredients, key) ? LIB.ingredients[key] : null;
    if (!ing) return { error: 'uses “' + String(key).slice(0, 40) + '”, which isn’t in the ingredient list' };
    if (seen.has(key)) return { error: 'lists ' + key + ' twice' };
    seen.add(key);
    const n = Number(amount);
    const ok = ing.unit === 'each' ? n >= 0.05 && n <= 6 : n >= 1 && n <= 600;
    if (!Number.isFinite(n) || !ok) return { error: 'has an odd amount of ' + key + ' (' + amount + ')' };
    out.push([key, Math.round(n * 100) / 100]);
  }
  return { per: out };
}

// A dish in the library's shape (with macros, groups, tags and cost worked out), or {error}.
function checkDish(raw, taken) {
  if (!raw || typeof raw !== 'object') return { error: 'not a dish' };
  const name = text(raw.name, 4, 70);
  if (!name) return { error: 'needs a name of 4 to 70 characters' };
  const why = e => ({ error: name + ': ' + e });
  if (taken.has(name.toLowerCase())) return why('a dish with this name is already in the library');
  if (!MEALS.includes(raw.meal)) return why('meal must be breakfast, lunch or dinner');
  const cuisine = text(raw.cuisine, 3, 30);
  if (!cuisine) return why('needs a cuisine');
  const minutes = Math.round(Number(raw.minutes));
  if (!(minutes >= 5 && minutes <= 180)) return why('minutes must be 5 to 180');
  const kit = Array.isArray(raw.kit) ? [...new Set(raw.kit)] : [];
  if (!kit.every(k => KITS.includes(k))) return why('kit can only be ' + KITS.join(', '));
  const p = checkPer(raw.per, 2);
  if (p.error) return why(p.error);
  if (!Array.isArray(raw.steps) || raw.steps.length < 2 || raw.steps.length > 8) return why('needs 2 to 8 steps');
  const steps = raw.steps.map(s => text(s, 8, 300));
  if (steps.some(s => !s)) return why('each step must be 8 to 300 characters');
  const dish = { name, meal: raw.meal, cuisine, minutes, kit, per: p.per, steps };
  for (const flag of ['leftovers', 'separate', 'packable', 'onepan', 'batch']) if (raw[flag] === true) dish[flag] = true;
  if (Array.isArray(raw.texture)) {
    const t = [...new Set(raw.texture)].filter(x => TEXTURES.includes(x));
    if (t.length) dish.texture = t;
  }
  if (raw.kid !== undefined && raw.kid !== null && raw.kid !== '') {
    const kid = text(raw.kid, 8, 200);
    if (!kid) return why('the kid tip must be 8 to 200 characters');
    dish.kid = kid;
  }
  const n = nutrition(dish.per);
  const [lo, hi] = KJ_RANGE[dish.meal];
  if (n.macros.kj < lo || n.macros.kj > hi) return why('about ' + n.macros.kj + ' kJ a serve, outside ' + lo + ' to ' + hi + ' kJ for a ' + dish.meal);
  dish.macros = n.macros;
  dish.groups = n.groups;
  dish.tags = raw.spicy === true ? [...new Set(n.tags.concat('spicy'))].sort() : n.tags;
  dish.cost = cost(dish.per);
  return { item: dish };
}

// Checks a new snack the same way as checkDish: {snack} if it's fine, or {error} saying why not.
function checkSnack(raw, taken) {
  if (!raw || typeof raw !== 'object') return { error: 'not a snack' };
  const what = text(raw.what, 4, 60);
  if (!what) return { error: 'a snack needs a description of 4 to 60 characters' };
  const why = e => ({ error: what + ': ' + e });
  if (taken.has(what.toLowerCase())) return why('already in the library');
  if (!SNACK_KINDS.includes(raw.kind)) return why('kind must be ' + SNACK_KINDS.join(', '));
  const p = checkPer(raw.per, 1);
  if (p.error) return why(p.error);
  const n = nutrition(p.per);
  if (n.macros.kj < KJ_RANGE.snack[0] || n.macros.kj > KJ_RANGE.snack[1]) return why('about ' + n.macros.kj + ' kJ, outside 200 to 1500 kJ for a snack');
  return { item: { what, per: p.per, kind: raw.kind, kids: raw.kids !== false, macros: n.macros, groups: n.groups, tags: n.tags } };
}

// Checks a new exercise (name, type, level, equipment, steps): {exercise} if it's fine, or {error}.
function checkExercise(raw, taken) {
  if (!raw || typeof raw !== 'object') return { error: 'not an exercise' };
  const name = text(raw.name, 3, 50);
  if (!name) return { error: 'an exercise needs a name of 3 to 50 characters' };
  const why = e => ({ error: name + ': ' + e });
  const id = idOf(name);
  if (!id || taken.has(id)) return why('already in the library');
  if (!EX_TYPES.includes(raw.type)) return why('type must be ' + EX_TYPES.join(', '));
  if (!EX_EQUIP.includes(raw.equipment)) return why('equipment must be ' + EX_EQUIP.join(', '));
  const level = Number(raw.level);
  if (![1, 2, 3].includes(level)) return why('level must be 1, 2 or 3');
  const dose = text(raw.dose, 3, 40);
  const how = text(raw.how, 20, 300);
  if (!dose || !how) return why('needs a dose (like 3 × 10) and how-to steps of 20 to 300 characters');
  const flags = Array.isArray(raw.flags) ? [...new Set(raw.flags)] : [];
  if (!flags.every(f => EX_FLAGS.includes(f))) return why('flags can only be ' + EX_FLAGS.join(', '));
  if (flags.includes('chair') && !flags.includes('seated')) flags.push('seated');
  return { item: { id, name, type: raw.type, equipment: raw.equipment, level, dose, how, flags } };
}

// What's already in use, so additions can't repeat a name.
function takenNames() {
  return {
    dishes: new Set(LIB.dishes.map(d => d.name.toLowerCase())),
    snacks: new Set(LIB.snacks.map(s => s.what.toLowerCase())),
    exercises: new Set(EXERCISES.map(e => e.id)),
  };
}

// Checks a set {dishes, snacks, exercises} against what's taken (and against itself).
// Returns {dishes, snacks, exercises, rejected: [reasons]}.
function checkSet(set, taken) {
  const out = { dishes: [], snacks: [], exercises: [], rejected: [] };
  const take = { dishes: new Set(taken.dishes), snacks: new Set(taken.snacks), exercises: new Set(taken.exercises) };
  // Checks each entry of one kind (dishes, snacks or exercises): good ones are kept, the rest are listed with why.
  const run = (list, check, into, keyOf) => {
    for (const raw of Array.isArray(list) ? list.slice(0, 60) : []) {
      const r = check(raw, take[into]);
      if (r.error) { out.rejected.push(r.error); continue; }
      take[into].add(keyOf(r.item));
      out[into].push(r.item);
    }
  };
  run(set && set.dishes, checkDish, 'dishes', d => d.name.toLowerCase());
  run(set && set.snacks, checkSnack, 'snacks', s => s.what.toLowerCase());
  run(set && set.exercises, checkExercise, 'exercises', e => e.id);
  return out;
}

// ---------------------------------------------------------------------------
// Files and settings
// ---------------------------------------------------------------------------

// Reads a JSON file, or gives null if it is missing or broken.
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// Saves an object as a JSON file. It writes a temporary copy first, then swaps it in, so a crash
// half-way through never leaves a broken file.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1) + '\n');
  fs.renameSync(tmp, file);
}

// Reads one of this file's settings (all start with "library:"), or the fallback if it isn't set.
function setting(key, fallback) {
  try {
    const v = db.getSetting('library:' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch (e) {
    return fallback;
  }
}
// Saves one of this file's settings.
function setSetting(key, value) {
  db.setSetting('library:' + key, JSON.stringify(value));
}

// The newer of the shipped and downloaded shared additions.
function community() {
  const a = readJson(BUNDLED) || { version: 0 };
  const b = readJson(DOWNLOADED) || { version: 0 };
  return (Number(b.version) || 0) > (Number(a.version) || 0) ? b : a;
}

const counts = set => ({ dishes: set.dishes.length, snacks: set.snacks.length, exercises: set.exercises.length });

let applied = { community: { dishes: 0, snacks: 0, exercises: 0 }, own: { dishes: 0, snacks: 0, exercises: 0 }, version: 0 };

// Puts the library back to how it shipped, then adds the shared additions and the family's own.
// Each is checked again here, so a hand-edited or damaged file can't add anything unchecked.
function apply() {
  LIB.dishes.splice(BASE.dishes);
  LIB.snacks.splice(BASE.snacks);
  EXERCISES.splice(BASE.exercises);
  // Adds one checked set of new dishes, snacks and exercises to the library in memory.
  const add = set => {
    const ok = checkSet(set || {}, takenNames());
    LIB.dishes.push(...ok.dishes);
    LIB.snacks.push(...ok.snacks);
    EXERCISES.push(...ok.exercises);
    return counts(ok);
  };
  const shared = community();
  applied = { community: add(shared), own: add(readJson(OWN)), version: Number(shared.version) || 0 };
}

// ---------------------------------------------------------------------------
// 1. Downloading the shared additions (no AI)
// ---------------------------------------------------------------------------

// Downloads the shared additions from GitHub and keeps the ones that pass the checks.
async function checkCommunity() {
  const at = Date.now();
  // lastCheck is only saved when the download works, so a failed one is tried again at the next
  // 6-hourly tick instead of in 2 weeks.
  try {
    const res = await fetch(UPDATE_URL, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'family-health-planner' } });
    if (!res.ok) throw new Error('GitHub said ' + res.status);
    const body = await res.text();
    if (body.length > MAX_DOWNLOAD) throw new Error('the file is too big');
    const got = JSON.parse(body);
    const version = Number(got.version) || 0;
    const before = applied.community;
    if (version <= applied.version) {
      const result = { at, ok: true, text: 'Up to date (version ' + applied.version + ').' };
      setSetting('lastResult', result);
      setSetting('lastCheck', at);
      return result;
    }
    // Check it in full before keeping it.
    const base = { dishes: new Set(), snacks: new Set(), exercises: new Set() };
    LIB.dishes.slice(0, BASE.dishes).forEach(d => base.dishes.add(d.name.toLowerCase()));
    LIB.snacks.slice(0, BASE.snacks).forEach(s => base.snacks.add(s.what.toLowerCase()));
    EXERCISES.slice(0, BASE.exercises).forEach(e => base.exercises.add(e.id));
    const ok = checkSet(got, base);
    writeJson(DOWNLOADED, { version, about: String(got.about || '').slice(0, 500), dishes: ok.dishes, snacks: ok.snacks, exercises: ok.exercises });
    apply();
    const now = applied.community;
    const added = { dishes: now.dishes - before.dishes, snacks: now.snacks - before.snacks, exercises: now.exercises - before.exercises };
    const parts = [];
    if (added.dishes > 0) parts.push(added.dishes + ' meal' + (added.dishes === 1 ? '' : 's'));
    if (added.snacks > 0) parts.push(added.snacks + ' snack' + (added.snacks === 1 ? '' : 's'));
    if (added.exercises > 0) parts.push(added.exercises + ' exercise' + (added.exercises === 1 ? '' : 's'));
    const result = {
      at, ok: true, added,
      text: (parts.length ? 'Added ' + parts.join(', ') : 'Nothing new') + ' (version ' + version + ').' +
        (ok.rejected.length ? ' ' + ok.rejected.length + ' left out because ' + (ok.rejected.length === 1 ? 'it' : 'they') + ' didn’t pass the checks.' : ''),
    };
    setSetting('lastResult', result);
    setSetting('lastCheck', at);
    return result;
  } catch (e) {
    const result = { at, ok: false, text: 'Couldn’t get new meals and exercises: ' + String(e.message || e).slice(0, 200) };
    setSetting('lastResult', result);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 2. The family's AI writes some (waiting for an admin)
// ---------------------------------------------------------------------------

let job = null;   // {state: "running"} while writing, or {state: "failed", error}

// The family's chosen AI, ready to use, or null if they plan without AI.
function familyAi() {
  const ready = assistant.setup({});   // the family's AI, not anyone's own key
  return ready && ready.enabled ? ready : null;
}

// The AI that writes new meals: the family's (a key on the server) if there is one, otherwise
// the own key (from Settings) of the admin who is asking, or who turned this on. `me` is that
// admin when a page is asking; the 2-weekly run has no one asking, so it uses the saved admin.
function writerAi(me) {
  const family = familyAi();
  if (family) return family;
  // The admin asking first, then the admin who turned the switch on.
  for (const accountId of [me && me.accountId, setting('aiBy', null)]) {
    if (!accountId) continue;
    const ready = assistant.setup({ accountId });
    if (ready && ready.enabled && ready.own) return ready;
  }
  return null;
}

// What the AI is told about the family: only food likes and limits and ratings, no health details.
function familyHints(ctx) {
  const lines = [];
  const people = require('./plandraft').household(ctx);
  const cuisines = new Set();
  const avoid = new Set();
  for (const p of people) {
    const a = p.answers || {};
    for (const c of [].concat(a.cuisines || [])) cuisines.add(c);
    for (const k of ['allergies', 'diet']) for (const v of [].concat(a[k] || [])) if (v && !/^none/i.test(v)) avoid.add(v);
    if (typeof a.dislikes === 'string' && a.dislikes.trim()) avoid.add('dislikes: ' + a.dislikes.trim().slice(0, 200));
    if (typeof a.allergies_other === 'string' && a.allergies_other.trim()) avoid.add('other allergies: ' + a.allergies_other.trim().slice(0, 200));
  }
  if (cuisines.size) lines.push('Cuisines the family likes: ' + [...cuisines].join(', ') + '.');
  if (avoid.size) lines.push('Allergies, diets and dislikes in the family (every dish must suit at least most of them; avoid the allergens entirely): ' + [...avoid].join('; ') + '.');
  try {
    const rated = db.dishes ? db.dishes() : [];
    const scored = (Array.isArray(rated) ? rated : []).filter(d => d && d.name && d.avg_score != null);
    const liked = scored.filter(d => d.avg_score >= 7.5).map(d => d.name).slice(0, 12);
    const disliked = scored.filter(d => d.avg_score <= 4.5).map(d => d.name).slice(0, 12);
    if (liked.length) lines.push('Dishes they rated highly (more like these): ' + liked.join(', ') + '.');
    if (disliked.length) lines.push('Dishes they rated poorly (avoid similar ones): ' + disliked.join(', ') + '.');
  } catch (e) { /* ratings are a nice-to-have */ }
  return lines;
}

// Which kinds of exercise have the fewest options, so new ones fill gaps.
function exerciseGaps() {
  const n = {};
  for (const e of EXERCISES) {
    const k = e.type + ' / ' + e.equipment;
    n[k] = (n[k] || 0) + 1;
  }
  const all = [];
  for (const t of EX_TYPES.filter(t => !['warmup', 'mobility'].includes(t))) for (const q of EX_EQUIP) all.push([t + ' / ' + q, n[t + ' / ' + q] || 0]);
  return all.sort((a, b) => a[1] - b[1]).slice(0, 8).map(x => x[0]);
}

// The instructions for the AI that writes new library entries: the rules, the ingredient list it
// must use, and an example dish.
function systemText() {
  const country = require('./appearance').region().where;
  const ingredients = Object.entries(LIB.ingredients).map(([key, i]) =>
    '- "' + key + '": ' + i.name + ' (' + (i.unit === 'each' ? 'amount is a count; one is about ' + i.each + ' g' : 'amount in ' + i.unit) + (i.tags && i.tags.length ? '; ' + i.tags.join(', ') : '') + ')').join('\n');
  const example = LIB.dishes.find(d => d.meal === 'dinner' && d.leftovers);
  const ex = { name: example.name, meal: example.meal, cuisine: example.cuisine, minutes: example.minutes, kit: example.kit, per: example.per, steps: example.steps, leftovers: true, separate: example.separate || false, kid: example.kid };
  return `You add new recipes, snacks and exercises to a family meal planner's built-in library (used when the family plans without AI). The family is in ${country}. Reply with one JSON object and nothing else.

Recipes:
- Write every recipe in your own words. Don't copy recipes from websites or books.
- Use ONLY ingredient keys from this list, with amounts for ONE average adult serve. The app works out nutrition, allergens and cost from these, so the amounts must be realistic. Oil, salt, pepper and dried spices are assumed on hand.
${ingredients}
- 5 ingredients or fewer is ideal (not counting oil and seasonings); at most 10.
- "meal": breakfast, lunch or dinner. "kit" from: ${KITS.join(', ')}. "minutes": total time.
- Optional true/false flags: "leftovers" (makes lunch for tomorrow), "separate" (parts can be served separately for fussy eaters), "packable" (fine cold in a lunchbox), "onepan", "batch" (freezes well), "spicy". Optional "texture": any of ${TEXTURES.join(', ')} when it fits. Optional "kid": one short tip for serving it to children.
- Plain English as written in ${country}, metric units, 2 to 6 short steps. Dishes people in ${country} would know and enjoy.
- Example: ${JSON.stringify(ex)}

Snacks: {"what": "short description with amounts", "per": [[key, amount]], "kind": one of ${SNACK_KINDS.join(', ')}, "kids": true or false}.

Exercises: {"name", "type" (one of ${EX_TYPES.join(', ')}), "equipment" (one of ${EX_EQUIP.join(', ')}; none means bodyweight with a chair, wall or step at most), "level" (1 easier to 3 harder), "dose" (like "3 × 10" or "3 × 30 seconds"), "how" (one or two plain sentences on how to do it), "flags": any of floor (gets down on the floor), supine (lies on the back), prone (lies face down), knees, back, shoulders, wrists, balance (what it loads most), seated (can be done sitting), chair (only done sitting)}. Describe how to do it; don't give medical advice.

Reply as {"dishes": [...], "snacks": [...], "exercises": [...]}.`;
}

// The request itself: what to write, what is already in the library, and the family's tastes.
function userText(ctx) {
  const lines = [
    'New ones are needed. Write 3 dinners, 1 breakfast and 1 lunch, 1 snack, and 3 exercises.',
    'Don\'t repeat or lightly reword anything already in the library. Dishes already there: ' + LIB.dishes.map(d => d.name).join('; ') + '.',
    'Snacks already there: ' + LIB.snacks.map(s => s.what).join('; ') + '.',
    'Exercises already there: ' + EXERCISES.map(e => e.name).join('; ') + '.',
    'Kinds of exercise with the fewest options (type / equipment), so these are most useful: ' + exerciseGaps().join(', ') + '.',
  ];
  return lines.concat(familyHints(ctx)).join('\n');
}

// Sends the instructions and request to the family's AI and returns its reply as text. Claude
// uses Anthropic's own library; the other AIs share one OpenAI-style way of asking.
async function askAi(ready, system, user) {
  if (ready.provider === 'anthropic') {
    const msg = await ready.client.messages.create({
      model: ready.model, max_tokens: 16000, system, messages: [{ role: 'user', content: user }],
    }, { timeout: 300000 });
    return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const msg = await ai.chat(ready, { system, messages: [{ role: 'user', content: user }], maxTokens: Math.min(16000, ai.maxOutput(ready.provider)), json: true });
  return msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// Asks the AI for new entries, checks each one, and keeps those that pass as "waiting for an
// admin" (Plan setup shows them to add or discard).
async function writeWithAi(ctx, me) {
  const ready = writerAi(me);
  if (!ready) throw new Error('There is no AI to write them. Add an API key in Settings first.');
  const reply = await askAi(ready, systemText(), userText(ctx));
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(ready.name + ' didn’t send any.');
  const pending = setting('pending', []);
  const taken = takenNames();
  for (const p of pending) {
    if (p.kind === 'dish') taken.dishes.add(p.item.name.toLowerCase());
    if (p.kind === 'snack') taken.snacks.add(p.item.what.toLowerCase());
    if (p.kind === 'exercise') taken.exercises.add(p.item.id);
  }
  const ok = checkSet(JSON.parse(reply.slice(start, end + 1)), taken);
  const at = Date.now();
  let n = 0;
  const add = (kind, item) => pending.push({ id: at.toString(36) + '-' + (n++), kind, item, by: ready.name, at });
  ok.dishes.forEach(d => add('dish', d));
  ok.snacks.forEach(s => add('snack', s));
  ok.exercises.forEach(e => add('exercise', e));
  setSetting('pending', pending.slice(-60));
  setSetting('lastAi', { at, ok: true, text: ready.name + ' wrote ' + n + ' new one' + (n === 1 ? '' : 's') + ' to approve' + (ok.rejected.length ? '; ' + ok.rejected.length + (ok.rejected.length === 1 ? ' didn’t pass the checks and was' : ' didn’t pass the checks and were') + ' left out' : '') + '.', rejected: ok.rejected.slice(0, 10) });
  return n;
}

// Starts writing new entries in the background (it takes a minute or two). False if already running.
function startWriting(ctx, me) {
  if (job && job.state === 'running') return false;
  job = { state: 'running', started: Date.now() };
  writeWithAi(ctx, me).then(() => { job = null; }).catch(e => {
    const text = 'Couldn’t write new ones: ' + String(e.message || e).slice(0, 200);
    setSetting('lastAi', { at: Date.now(), ok: false, text });
    job = null;
  });
  return true;
}

// Moves waiting ones into the family's own additions (or throws them away).
function decide(ids, all, keep) {
  const pending = setting('pending', []);
  const chosen = pending.filter(p => all || (Array.isArray(ids) && ids.includes(p.id)));
  setSetting('pending', pending.filter(p => !chosen.includes(p)));
  if (!keep || !chosen.length) return 0;
  const own = readJson(OWN) || { dishes: [], snacks: [], exercises: [] };
  for (const p of chosen) own[{ dish: 'dishes', snack: 'snacks', exercise: 'exercises' }[p.kind]].push(p.item);
  writeJson(OWN, own);
  apply();
  return chosen.length;
}

// ---------------------------------------------------------------------------
// Every 2 weeks
// ---------------------------------------------------------------------------

// Starts the timer that looks for library additions every 6 hours (and does the 2-weekly jobs when due).
function start(ctx) {
  try { apply(); } catch (e) { console.error('library additions:', e.message); }
  const tick = () => {
    const now = Date.now();
    if (setting('auto', true) && now - setting('lastCheck', 0) > EVERY) checkCommunity().catch(() => {});
    const last = setting('lastAi', null);
    if (setting('ai', false) && writerAi(null) && now - (last ? last.at : 0) > EVERY) startWriting(ctx);
  };
  setTimeout(tick, 2 * 60 * 1000);                 // a couple of minutes after starting
  setInterval(tick, 6 * 3600 * 1000).unref();      // then look every 6 hours
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// Everything the Plan setup card shows: the switches, the last results and what's waiting.
function status(me) {
  const ready = writerAi(me);
  return {
    auto: setting('auto', true),
    ai: setting('ai', false),
    aiName: ready ? ready.name : null,
    aiOwn: !!(ready && ready.own),   // true when it runs on an admin's own key from Settings
    lastCheck: setting('lastCheck', 0),
    lastResult: setting('lastResult', null),
    lastAi: setting('lastAi', null),
    writing: !!(job && job.state === 'running'),
    pending: setting('pending', []),
    added: applied,
    every: EVERY,
  };
}

// Answers the requests this file looks after. server.js offers every /api/ request to each
// file in turn: this returns true if it answered, or false to let the next file try.
async function handle(req, res, urlPath, url, me, ctx) {
  if (!urlPath.startsWith('/api/library/updates')) return false;
  if (!me.admin) { send(res, 403, { error: 'Only an admin can change the meal library.' }); return true; }
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') { send(res, 403, { error: 'bad request' }); return true; }

  if (urlPath === '/api/library/updates' && req.method === 'GET') { send(res, 200, status(me)); return true; }

  let body;
  try { body = await readBody(req); } catch (e) { send(res, 400, { error: 'bad request' }); return true; }

  if (urlPath === '/api/library/updates' && req.method === 'PUT') {
    if (typeof body.auto === 'boolean') setSetting('auto', body.auto);
    if (typeof body.ai === 'boolean') {
      setSetting('ai', body.ai);
      // Remember who turned it on: without a family key, the 2-weekly run uses their own key.
      if (body.ai && me.accountId) setSetting('aiBy', me.accountId);
    }
    send(res, 200, status(me));
    return true;
  }
  if (urlPath === '/api/library/updates/check' && req.method === 'POST') {
    await checkCommunity();
    send(res, 200, status(me));
    return true;
  }
  if (urlPath === '/api/library/updates/write' && req.method === 'POST') {
    if (!writerAi(me)) { send(res, 400, { error: 'There is no AI to write them. Add an API key in Settings first.' }); return true; }
    startWriting(ctx, me);
    send(res, 202, status(me));
    return true;
  }
  if ((urlPath === '/api/library/updates/approve' || urlPath === '/api/library/updates/discard') && req.method === 'POST') {
    decide(body.ids, body.all === true, urlPath.endsWith('approve'));
    send(res, 200, status(me));
    return true;
  }
  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle, start, apply, checkSet, nutrition, cost, takenNames, BASE };
