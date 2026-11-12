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

test('drafting: Claude is left room to write after thinking, and running out is explained', () => {
  const draft = require('../api/plandraft');
  // "high" effort once used a 100,000-token allowance on thinking alone and wrote no plan.
  assert.notEqual(draft.CLAUDE_DRAFT.effort, 'high');
  assert.ok(draft.CLAUDE_DRAFT.maxTokens >= 128000);
  // The draft runs on the model chosen for the key, with settings that model accepts.
  assert.deepEqual(draft.claudeRequest('claude-sonnet-5-5'), { model: 'claude-sonnet-5-5', max_tokens: 128000, thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'medium' } });
  assert.equal(draft.claudeRequest('claude-haiku-5-5').model, 'claude-haiku-5-5');
  assert.deepEqual(draft.claudeRequest('claude-haiku-4-5'), { model: 'claude-haiku-4-5', max_tokens: 64000 });
  assert.match(draft.cutOffMessage(0), /thinking the plan through/);
  assert.match(draft.cutOffMessage(50000), /too long and got cut off/);
});

// A tiny plan for the checks below: one meal week, where Sam's dinner has green beans in it and
// the day gives Sam 2 serves of vegetables and no fruit.
function smallPlan() {
  return {
    weeks: [
      { name: 'Stock-up 1', kind: 'stockup', shopping: { Pantry: [['Rice 1 kg', 3]] } },
      {
        name: 'Week 1',
        meals: [{ day: 'Mon', breakfast: 'Porridge', lunch: 'Sandwich', dinner: 'Salmon and veg' }],
        recipes: [{ name: 'Salmon and veg', ingredients: ['250 g green beans or broccoli'], items: [{ q: 250, l: 'g green beans or broccoli', i: 0 }], steps: ['Steam the green beans.'] }],
        shopping: { 'Fruit and veg': [['Green beans 250 g', 3], ['Carrots 1 kg', 2]] },
        cost: 5,
      },
    ],
    people: { sam: { name: 'Sam', portion: 1, snacks: [], tips: ['You must eat breakfast.'], guide: 'Average serves.' } },
    exercise: { sam: { medical: [] } },
    groups: { 'Salmon and veg': { veg: 2 }, Porridge: {}, Sandwich: {} },
    macros: {},
  };
}
const SAM = [{ key: 'sam', name: 'Sam', answers: { age: '40', sex: 'Female', dislikes: 'Long green beans, most veggies', conditions: ['Type 2 diabetes or pre-diabetes'] } }];

test('plan check: food on Current food that no meal uses is reported', () => {
  const check = require('../api/plancheck');
  const food = [
    { text: '2 tins diced tomatoes', place: 'pantry' }, { text: 'broccoli', place: 'fridge' },
    { text: 'salmon fillets 400 g', place: 'freezer' }, { text: '6 eggs', place: 'fridge' },
  ];
  // The small plan has salmon and "green beans or broccoli"; nothing uses tomatoes or eggs.
  assert.deepEqual(check.unusedFood(smallPlan(), food), ['2 tins diced tomatoes', '6 eggs']);
  const found = check.problems(smallPlan(), [], food);
  assert.equal(found.length, 1);
  assert.match(found[0], /already has these at home \(Current food\).*2 tins diced tomatoes; 6 eggs/);
  assert.match(check.fixRequest(smallPlan(), [], food), /2 tins diced tomatoes; 6 eggs/);
  // A singular in the plan matches a plural on the list, and no list means nothing to report.
  const plan = smallPlan();
  plan.weeks[1].meals[0].breakfast = 'Egg and tomato on toast';
  assert.deepEqual(check.unusedFood(plan, food), []);
  assert.deepEqual(check.problems(smallPlan(), []), []);
});

test('plan check: finds a plan short of vegetables, a food someone won’t eat, and "must"', () => {
  const check = require('../api/plancheck');
  const found = check.problems(smallPlan(), SAM).join('\n');
  assert.match(found, /week 1: the plan gives about 2\.0 serves of vegetables a day and the aim that week is 5\.0/);
  assert.match(found, /serves of fruit/);
  assert.match(found, /won’t eat "green beans", and it seems to be in Salmon and veg \(Week 1\)/);
  assert.match(found, /tips use the word "must"/);
  // A sweeping dislike isn't a named food, and "no corn" isn't corn.
  assert.deepEqual(check.namedDislikes({ dislikes: 'Most veggies, corn' }), ['corn']);
  assert.equal(check.mentions('frozen mixed vegetables (no corn)', 'corn'), false);
  assert.equal(check.mentions('2 tbsp cornflour', 'corn'), false);
  assert.equal(check.mentions('1 cob of corn', 'corn'), true);
  // The follow-up for the AI lists what was found and what the person said.
  const ask = check.fixRequest(smallPlan(), SAM);
  assert.match(ask, /Type 2 diabetes or pre-diabetes/);
  assert.match(ask, /Reply with one JSON object of corrections/);
});

test('plan check: an adult’s protein powder is a counted snack, and an under-18 has none', () => {
  const check = require('../api/plancheck');
  const shake = 'Protein shake (1 scoop of your own powder)';
  const who = answers => [{ key: 'sam', name: 'Sam', answers: { eating_change: 'Keep it close to what I eat now', ...answers } }];
  const withSnacks = (snacks, macros) => { const plan = smallPlan(); plan.people.sam.snacks = snacks; plan.people.sam.tips = []; plan.macros = macros || {}; return plan; };
  const adult = who({ age: '40', supplements: ['Protein powder'], protein_powder_when: 'Every day' });
  assert.match(check.problems(withSnacks([]), adult).join('\n'), /isn’t a counted snack/);
  assert.match(check.problems(withSnacks([{ when: 'Afternoon', what: shake, optional: true }]), adult).join('\n'), /isn’t a counted snack/);
  assert.match(check.problems(withSnacks([{ when: 'Afternoon', what: shake }]), adult).join('\n'), /has no "macros" entry/);
  assert.deepEqual(check.problems(withSnacks([{ when: 'Afternoon', what: shake }], { [shake]: { p: 24, c: 2, f: 2 } }), adult), []);
  // Now and then needs nothing, and a teenager's is taken out.
  assert.deepEqual(check.problems(withSnacks([]), who({ age: '40', supplements: ['Protein powder'], protein_powder_when: 'Now and then' })), []);
  const teen = who({ age: '15', supplements: ['Protein powder'], protein_powder_when: 'Every day' });
  assert.match(check.problems(withSnacks([{ when: 'Afternoon', what: shake }]), teen).join('\n'), /under 18/);
  assert.deepEqual(check.problems(withSnacks([]), teen), []);
  // The follow-up for the AI lists the supplements with everything else they said.
  assert.match(check.fixRequest(withSnacks([]), adult), /supplements they already take: Protein powder \(protein powder: Every day\)/);
});

test('plan check: the AI’s corrections are applied, and a bad reply keeps the first draft', async () => {
  const check = require('../api/plancheck');
  const fixes = {
    people: { sam: { snacks: [{ when: 'With dinner', what: 'Steamed vegetables' }, { when: 'Morning', what: '2 pieces of fruit' }], tips: ['Consider eating breakfast.'] }, stranger: { tips: ['x'] } },
    medical: { sam: ['You said you have type 2 diabetes. It may be worth checking this plan with your GP.'] },
    groups: { 'Steamed vegetables': { veg: 3 }, '2 pieces of fruit': { fruit: 2 } },
    replace: [{ find: 'green beans or broccoli', with: 'broccoli' }, { find: 'green beans', with: 'broccoli' }],
    remove: ['Green beans'],
    shopping: [{ week: 'Week 1', section: 'Fruit and veg', item: 'Broccoli', price: 2.5 }, { week: 'Week 9', item: 'Nothing', price: 1 }],
    recipes: ['Steamed vegetables: microwave for 3 minutes.'],
    notesForAdmin: 'Corrected.',
  };
  const plan = smallPlan();
  const good = await check.improve(plan, SAM, 'First.', async () => JSON.stringify(fixes), () => '');
  assert.deepEqual(check.problems(good.plan, SAM), []);
  assert.equal(good.notes, 'Corrected.');
  assert.match(good.note, /went back over this plan/);
  assert.deepEqual(good.plan.weeks[1].shopping['Fruit and veg'], [['Carrots 1 kg', 2], ['Broccoli', 2.5]]);
  assert.equal(good.plan.weeks[1].recipes.length, 2);
  assert.equal(good.plan.people.stranger, undefined);
  assert.equal(plan.people.sam.snacks.length, 0, 'the first draft itself is left untouched');

  // Unreadable corrections, no reply, or corrections that break the plan: the first draft stays.
  for (const [reply, broken] of [['sorry, I can’t', ''], ['', ''], [JSON.stringify(fixes), 'weeks are the wrong shape']]) {
    const kept = await check.improve(plan, SAM, 'First.', async () => reply, () => broken);
    assert.equal(kept.plan, plan);
    assert.equal(kept.notes, 'First.');
    assert.match(kept.note, /first draft as written/);
  }
  // Nothing to change: no note at all.
  assert.equal((await check.improve(plan, SAM, 'First.', async () => '{}', () => '')).note, '');
});

test('drafting: the instructions tell the AI to check serves, named foods and blood test dates itself', () => {
  const text = require('../api/plandraft').systemText();
  assert.match(text, /Check before you reply/);
  assert.match(text, /belonging only to the date it is printed under/);
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
