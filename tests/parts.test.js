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
// Vegetable and fruit targets
// ---------------------------------------------------------------------------

test('targets: the builder’s vegetable and fruit serves match the guidelines the Macros tab shows', () => {
  const ht = require('../api/healthtargets');
  const au = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'guidelines.json'), 'utf8')).countries.find(c => c.id === 'au');
  for (let age = 2; age <= 95; age++) {
    for (const sex of ['Male', 'Female']) {
      const row = au.targets.find(r => age >= r.age[0] && age <= r.age[1] && (r.sex === 'any' || r.sex === sex.toLowerCase()));
      assert.deepEqual(ht.targetFor({ age, sex }), { veg: row.veg, fruit: row.fruit }, sex + ' aged ' + age);
    }
  }
  // No age given: an adult's numbers.
  assert.deepEqual(ht.targetFor({}), { veg: 5, fruit: 2 });
});

test('targets: a plan is measured the way the Macros tab does it', () => {
  const ht = require('../api/healthtargets');
  const plan = {
    people: { kid: { name: 'Kid', portion: 0.5, snacks: [{ when: 'Afternoon', what: 'An apple' }, { when: 'Later', what: 'A pear', optional: true }], weekday: { Mon: { lunch: 'Soup' } } } },
    weeks: [{ name: 'Stock-up 1', kind: 'stockup' }, { name: 'Week 1', meals: [
      { day: 'Mon', breakfast: 'Toast', lunch: 'Salad', dinner: 'Stew' },
      { day: 'Tue', breakfast: 'Toast', lunch: 'Salad', dinner: 'Stew', people: { kid: { dinner: 'Soup' } } },
    ] }],
    groups: { Stew: { veg: 4 }, Salad: { veg: 2 }, soup: { veg: 1 }, 'An apple': { fruit: 1 }, 'A pear': { fruit: 1 } },
  };
  // Monday: soup for lunch (1) and stew (4), at half a portion = 2.5. Tuesday: salad (2) and soup (1) = 1.5.
  assert.deepEqual(ht.dailyAverage(plan, 'kid'), { veg: 2, fruit: 1 });
  // A snack with "weeks" only counts in those meal weeks (stock-up weeks aren't counted as weeks).
  plan.people.kid.snacks[0].weeks = [2];
  assert.equal(ht.dailyAverage(plan, 'kid').fruit, 0);
  plan.people.kid.snacks[0].weeks = [1];
  assert.equal(ht.dailyAverage(plan, 'kid').fruit, 1);
  delete plan.people.kid.snacks[0].weeks;
  const review = ht.review(plan, [{ key: 'kid', name: 'Kid', answers: { age: 10 } }]);
  assert.deepEqual(review[0].short, ['veg', 'fruit']);
  assert.match(ht.shortNote(plan, [{ key: 'kid', name: 'Kid', answers: { age: 10 } }]), /Kid’s days average about 2 of 5 serves of vegetables/);
});

// ---------------------------------------------------------------------------
// Blood test results for the plan writer
// ---------------------------------------------------------------------------

test('results: shared files are sent to Claude as documents and images, newest three only', () => {
  const extras = require('../api/planextras');
  const dir = path.join(process.env.DATA_DIR, 'uploads', 'sam', 'blood-tests');
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['2026-01-01 Old.pdf', '2026-05-01 A.pdf', '2026-06-01 B.png', '2026-07-01 C.txt']) fs.writeFileSync(path.join(dir, name), 'abc');
  const yes = { share_results: 'Yes, use my blood test results' };
  assert.deepEqual(extras.sharedResults([{ person: 'sam', answers: {} }]).sam.files, [], 'nothing without a yes');
  const got = extras.sharedResults([{ person: 'sam', answers: yes }]).sam;
  assert.deepEqual(got.files.map(f => f.name), ['2026-07-01 C.txt', '2026-06-01 B.png', '2026-05-01 A.pdf']);
  assert.equal(got.skipped[0].name, '2026-01-01 Old.pdf');
  const blocks = extras.resultBlocks('Sam', got.files);
  assert.deepEqual(blocks.map(b => b.type), ['document', 'text', 'image', 'document']);
  assert.deepEqual(blocks[0].source, { type: 'text', media_type: 'text/plain', data: 'abc' });
  assert.deepEqual(blocks[2].source, { type: 'base64', media_type: 'image/png', data: 'YWJj' });
  assert.equal(blocks[3].source.media_type, 'application/pdf');
  assert.match(extras.skippedNote([{ name: 'Sam', results: got }]), /Old\.pdf” wasn’t read because only the newest 3/);
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
    ...stringsIn(path.join(ROOT, 'api', 'healthtargets.js')),
    ...stringsIn(path.join(ROOT, 'api', 'planextras.js')),
    ...textsIn(path.join(ROOT, 'site', 'questions.json')),
  ];
  const bad = texts.filter(t => ABSOLUTES.test(t) && !ALLOWED.some(a => t.includes(a)));
  assert.deepEqual(bad, []);
});

test('wording: the app calls its own notes "considerations", never "advice"', () => {
  const texts = [
    ...stringsIn(path.join(ROOT, 'api', 'planbuilder.js')),
    ...stringsIn(path.join(ROOT, 'api', 'healthtargets.js')),
    ...textsIn(path.join(ROOT, 'site', 'questions.json')),
    ...textsIn(path.join(ROOT, 'api', 'exercises.json')),
  ];
  // "not medical advice" is the disclaimer, and the About me question asks about a doctor's advice.
  const bad = texts.filter(t => /\badvice\b/i.test(t.replace(/not medical advice|given you advice/gi, '')));
  assert.deepEqual(bad, []);
});
