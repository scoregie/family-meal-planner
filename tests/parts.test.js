// Checks smaller parts on their own: calendar times, reading exports from a zip, the shared meal
// library, the country lists and price lists agreeing, and the wording rules for health text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ROOT } = require('./helpers');

// Some files open the database when loaded, so give them an empty temporary data folder.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fhp-parts-'));
process.env.PLAN_FILE = path.join(ROOT, 'site', 'plan.json');
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const FIXTURES = path.join(__dirname, 'fixtures');

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

test('calendar: eating times are read the way people write them', () => {
  const { parseWhen } = require('../api/calendar');
  const at = (h, m = 0) => h * 60 + m;
  assert.deepEqual(parseWhen('7:30 am'), { start: at(7, 30), end: at(8) });
  assert.deepEqual(parseWhen('6:30 to 7:30 pm'), { start: at(18, 30), end: at(19, 30) });
  assert.deepEqual(parseWhen('11:30 to 12:30 pm'), { start: at(11, 30), end: at(12, 30) });
  assert.deepEqual(parseWhen('11 pm to 12 am'), { start: at(23), end: at(23, 59) }, 'runs to midnight');
  assert.equal(parseWhen('whenever you like'), null);
});

// ---------------------------------------------------------------------------
// Zip exports
// ---------------------------------------------------------------------------

test('zip: an Apple Health export is read, counting steps from the busiest device only', async () => {
  const { readAppleHealth } = require('../api/progress');
  const rows = await readAppleHealth(path.join(FIXTURES, 'apple-health-export.zip'));
  const find = (date, kind) => rows.find(r => r.date === date && r.kind === kind);
  assert.equal(find('2026-10-01', 'weight').value, 80.4);
  assert.equal(Math.round(find('2026-10-02', 'weight').value), 80, '176 lb is about 80 kg');
  assert.equal(find('2026-10-01', 'steps').value, 7000, 'the phone’s 7,000, not phone + watch');
  assert.equal(find('2026-10-01', 'workout_minutes').value, 30);
});

test('zip: an empty file inside a zip reads as empty, and a file that isn’t a zip is refused', async () => {
  const zip = require('../api/zip');
  const file = path.join(FIXTURES, 'apple-health-export.zip');
  const empty = zip.list(file).find(e => e.name.endsWith('empty.txt'));
  assert.equal(await zip.readText(file, empty), '');
  assert.throws(() => zip.list(path.join(FIXTURES, 'not-a-zip.zip')), /not a zip/);
});

// ---------------------------------------------------------------------------
// The shared meal library
// ---------------------------------------------------------------------------

test('library: every shared new meal and exercise passes the same checks the app uses', () => {
  const { checkSet, BASE } = require('../api/libraryupdates');
  const LIB = require('../api/library.json');
  const EXERCISES = require('../api/exercises.json');
  const community = require('../api/library-community.json');
  const taken = {
    dishes: LIB.dishes.slice(0, BASE.dishes).map(d => d.name.toLowerCase()),
    snacks: LIB.snacks.slice(0, BASE.snacks).map(s => s.what.toLowerCase()),
    exercises: (EXERCISES.exercises || EXERCISES).slice(0, BASE.exercises).map(e => e.name.toLowerCase()),
  };
  const result = checkSet(community, taken);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.dishes.length, (community.dishes || []).length);
});

test('library: every dish only uses ingredients the library knows', () => {
  const LIB = require('../api/library.json');
  for (const d of LIB.dishes) for (const [key] of d.per) assert.ok(LIB.ingredients[key], d.name + ' uses ' + key);
  for (const s of LIB.snacks) for (const [key] of s.per) assert.ok(LIB.ingredients[key], s.what + ' uses ' + key);
});

test('library: there are breakfasts and lunches for each common allergy', () => {
  const LIB = require('../api/library.json');
  for (const tag of ['gluten', 'milk', 'egg', 'soy', 'peanut', 'treenut', 'fish', 'sesame']) {
    for (const meal of ['breakfast', 'lunch', 'dinner']) {
      const fits = LIB.dishes.filter(d => d.meal === meal && !d.tags.includes(tag));
      assert.ok(fits.length >= 2, 'only ' + fits.length + ' ' + meal + 's without ' + tag);
    }
  }
});

// ---------------------------------------------------------------------------
// Countries, stores and prices
// ---------------------------------------------------------------------------

test('countries: each has a currency, stores that exist, and working store links', () => {
  const REGIONS = require('../site/regions.js');
  for (const [id, c] of Object.entries(REGIONS.countries)) {
    assert.match(c.currency, /^[A-Z]{3}$/, id);
    assert.match(c.locale, /^[a-z]{2}-[A-Z]{2}$/, id);
    assert.ok(['kJ', 'kcal'].includes(c.energy), id);
    assert.ok(c.stores.length >= 1, id + ' has stores');
    for (const s of c.stores) {
      const store = REGIONS.stores[s];
      assert.ok(store, id + ' lists unknown store ' + s);
      if (store.search) assert.ok(store.search.startsWith('https://') && store.search.includes('{q}'), s + ' search link');
    }
  }
});

test('countries: every country but Australia has a local price list in its own currency', () => {
  const REGIONS = require('../site/regions.js');
  const PRICES = require('../api/library-prices.json');
  const LIB = require('../api/library.json');
  for (const [id, c] of Object.entries(REGIONS.countries)) {
    if (id === 'au') continue;
    const p = PRICES.countries[id];
    assert.ok(p, id + ' has a price list');
    assert.equal(p.currency, c.currency, id);
    for (const key of Object.keys(LIB.ingredients)) {
      if (LIB.ingredients[key].aisle === 'assumed' || (p.missing || []).includes(key)) continue;
      assert.ok(p.items[key], id + ' has a price for ' + key + ' (run tools/build_prices.py)');
    }
  }
});

// ---------------------------------------------------------------------------
// Wording rules for health text (see CLAUDE.md)
// ---------------------------------------------------------------------------

// Words the health text avoids, with the few places they're fine (people describing themselves).
const ABSOLUTES = /\b(always|never|must)\b/i;
const ALLOWED = ['I always eat breakfast', 'things you can always eat'];

// The strings in a JavaScript file, leaving out comments.
function stringsIn(file) {
  const code = fs.readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  return [...code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)].map(m => m[1] || m[2] || '');
}

// Every piece of text in a JSON file.
function textsIn(file) {
  const out = [];
  (function walk(v) {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(JSON.parse(fs.readFileSync(file, 'utf8')));
  return out;
}

test('wording: health notes avoid "always", "never" and "must"', () => {
  const texts = [
    ...stringsIn(path.join(ROOT, 'api', 'planbuilder.js')),
    ...textsIn(path.join(ROOT, 'site', 'questions.json')),
  ];
  const bad = texts.filter(t => ABSOLUTES.test(t) && !ALLOWED.some(a => t.includes(a)));
  assert.deepEqual(bad, []);
});

test('wording: the app calls its own notes "considerations", never "advice"', () => {
  const texts = [
    ...stringsIn(path.join(ROOT, 'api', 'planbuilder.js')),
    ...textsIn(path.join(ROOT, 'site', 'questions.json')),
    ...textsIn(path.join(ROOT, 'api', 'exercises.json')),
  ];
  // "not medical advice" is the disclaimer, and the About me question asks about a doctor's advice.
  const bad = texts.filter(t => /\badvice\b/i.test(t.replace(/not medical advice|given you advice/gi, '')));
  assert.deepEqual(bad, []);
});
