// The kJ in a serve (site/energy.js): one rule for the Meals tab, Edit plan and Progress.
// Progress used to work it out from protein, carbs and fat only, so a meal from an older plan
// that gave just "kcal" counted as 0 kJ eaten there, while the Meals tab showed its energy.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fhp-energy-'));
process.env.PLAN_FILE = path.join(ROOT, 'site', 'plan.json');
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const Energy = require('../site/energy.js');

test("a plan's own kJ wins, then kcal, then protein, carbs and fat", () => {
  assert.equal(Energy.kj({ kj: 1500, p: 1, c: 1, f: 1 }), 1500);
  assert.equal(Energy.kj({ kcal: 500 }), 2092);
  assert.equal(Energy.kj({ p: 20, c: 45, f: 12 }), 17 * 20 + 17 * 45 + 37 * 12);
  assert.equal(Energy.kj({ p: '10', c: '', f: null }), 170);
  assert.equal(Energy.kj(null), 0);
  assert.equal(Energy.kj({}), 0);
});

test('no other page or server file keeps its own copy of the rule', () => {
  const files = ['api', 'site'].flatMap(dir => fs.readdirSync(path.join(ROOT, dir))
    .filter(f => /\.(js|html)$/.test(f) && f !== 'energy.js').map(f => path.join(dir, f)));
  for (const file of files) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /37 \* \(?\+?\w+\.f\b/, file);
  }
});

test('Progress counts a meal whose plan gave only kcal', () => {
  const db = require('../api/db');
  const progress = require('../api/progress');
  db.rememberDishes({ id: 'old', weeks: [{ meals: [{ day: 'Mon', dinner: 'Old soup' }] }], macros: { 'Old soup': { kcal: 500 } } });
  const now = Date.now();
  db.open().prepare(`INSERT INTO meal_log (person, plan_id, round, week, week_name, day, slot, dish, eaten, eaten_at, updated_at)
    VALUES ('sam', 'old', 0, 0, 'Week 1', 'Mon', 'Dinner', 'Old soup', 1, ?, ?)`).run(now, now);
  const out = progress.summary('sam', 1, 'UTC', { readPlan: () => ({}), toKey: s => s, people: () => [] });
  const week = out.weeks[out.weeks.length - 1];
  assert.equal(week.meals, 1);
  assert.equal(week.plan_kj, 2092);
});
