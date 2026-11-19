// "Didn't have it?" on the Meals tab: why someone didn't have a planned meal. Checks the reasons
// list (site/skipreasons.js), that the server keeps only known reasons with the ticks, that the
// meal log and each person's feedback carry them, and that the next plan uses them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SkipReasons = require('../site/skipreasons.js');
const pb = require('../api/planbuilder');
const { startServer, ROOT } = require('./helpers');

test('the reasons list loads in a page and in Node, and knows its own keys', () => {
  const page = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'site', 'skipreasons.js'), 'utf8'), page);
  assert.equal(page.window.SkipReasons.REASONS.map(r => r[0]).join(), SkipReasons.REASONS.map(r => r[0]).join());
  assert.equal(SkipReasons.label('time'), 'No time');
  assert.equal(SkipReasons.valid('refused'), true);
  assert.equal(SkipReasons.valid('bogus'), false);
  assert.equal(SkipReasons.valid(undefined), false);
});

test('a skipped meal is saved with the ticks, and an unknown reason is dropped', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const owner = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery', country: 'au' };
  const made = await server.request('POST', '/auth/register', { ...owner, setupCode: server.setupCode() });
  assert.equal(made.status, 200, made.text);

  const body = {
    ex: {}, eaten: { 0: ['Tue|Dinner'] },
    ratings: { 0: {
      'Mon|Dinner': { x: 'time', n: 'late home', t: 'Fish tacos' },
      'Mon|Lunch': { x: 'bogus' },                 // not a reason, nothing else: dropped
      'Tue|Dinner': { s: 8, x: 'out' },            // ticked as eaten: the reason isn't logged
    } },
  };
  const saved = await server.request('PUT', '/api/user/alex-smith', body);
  assert.equal(saved.status, 200, saved.text);

  const back = await server.request('GET', '/api/state');
  const week = back.json.users['alex-smith'].ratings['0'];
  assert.deepEqual(week['Mon|Dinner'], { x: 'time', n: 'late home', t: 'Fish tacos' });
  assert.equal(week['Mon|Lunch'], undefined);
});

test('the meal log and feedback carry the reasons, and a ticked meal has none', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'fhp-skips-'));
  process.env.DATA_DIR = dir;
  process.env.PLAN_FILE = path.join(ROOT, 'site', 'plan.json');
  try {
    const db = require('../api/db');
    const planextras = require('../api/planextras');
    const plan = { id: 'p1', weeks: [{ name: 'Week 1', meals: [
      { day: 'Mon', dinner: 'Fish tacos' }, { day: 'Tue', dinner: 'Beef stew' }] }] };
    db.syncMeals('sam', plan, 0, { 0: ['Tue|Dinner'] }, { 0: {
      'Mon|Dinner': { x: 'refused' },
      'Tue|Dinner': { x: 'time', s: 7 },
    } });
    const rows = db.open().prepare('SELECT day, skip_reason FROM meal_log WHERE person = ? ORDER BY day').all('sam');
    assert.deepEqual(rows.map(r => [r.day, r.skip_reason]), [['Mon', 'refused'], ['Tue', null]]);
    const fb = planextras.feedbackFor('sam');
    assert.deepEqual(fb.skipped, [{ dish: 'Fish tacos', reasons: ['refused'] }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the builder: "Didn’t want to eat it" counts against the dish, "No time" three times means quicker meals', () => {
  const person = feedback => ({ key: 'a', name: 'A', answers: { age: '40', sex: 'Male', cook_time: 'Up to an hour' }, feedback });
  const dinners = plan => plan.weeks.flatMap(w => (w.meals || []).map(d => d.dinner)).filter(Boolean);
  const before = dinners(pb.build([person()], { seed: 7 }).plan);
  const often = Object.entries(before.reduce((n, d) => (n[d] = (n[d] || 0) + 1, n), {})).sort((a, b) => b[1] - a[1])[0][0];
  const after = dinners(pb.build([person({ rated: {}, notes: [], skipped: [{ dish: often, reasons: ['refused'] }] })], { seed: 7 }).plan);
  assert.ok(after.filter(d => d === often).length < before.filter(d => d === often).length, often + ' comes up less');

  const rushed = { rated: {}, notes: [], skipped: [1, 2, 3].map(i => ({ dish: 'Dish ' + i, reasons: ['time'] })) };
  const quick = pb.build([person(rushed)], { seed: 7 }).plan;
  const minutes = plan => {
    const lib = JSON.parse(fs.readFileSync(path.join(ROOT, 'api', 'library.json'), 'utf8'));
    const byName = new Map((lib.dishes || []).map(d => [d.name, d.minutes || 0]));
    const list = dinners(plan).map(d => byName.get(d)).filter(m => m != null);
    return list.reduce((n, m) => n + m, 0) / list.length;
  };
  assert.ok(minutes(quick) <= minutes(pb.build([person()], { seed: 7 }).plan), 'dinners take no longer on average');
});

test('the Meals tab and the server use the same list (no copies of the reasons)', () => {
  const meals = fs.readFileSync(path.join(ROOT, 'site', 'app-meals.js'), 'utf8');
  assert.match(meals, /SkipReasons\.REASONS/);
  assert.match(fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8'), /<script src="skipreasons\.js"><\/script>/);
  assert.match(fs.readFileSync(path.join(ROOT, 'site', 'sw.js'), 'utf8'), /"skipreasons\.js"/);
});
