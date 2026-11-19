// "How the week went" (api/weekreview.js and site/week.html): one person's week next to the week
// before. Checks what counts in which week, the reasons for skipped meals, veg days, sessions, the
// dated log of cardio steps and foods tried, the "one thing to consider" wording, and the route.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, ROOT } = require('./helpers');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fhp-week-'));
process.env.PLAN_FILE = path.join(ROOT, 'site', 'plan.json');
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));

const db = require('../api/db');
const weekreview = require('../api/weekreview');
const progress = require('../api/progress');

const DAY = 24 * 60 * 60 * 1000;
const TZ = 'UTC';
// Noon UTC on a day of last week (0 = Monday) or the week before (-7 = the Monday before).
function lastWeek(dayOffset) {
  const today = progress.localDate(Date.now(), TZ);
  const monday = progress.addDays(progress.mondayOf(today), -7 + dayOffset);
  return new Date(monday + 'T12:00:00Z').getTime();
}

const PLAN = {
  id: 'wk', weeks: [{ name: 'Week 1',
    meals: ['Mon', 'Tue', 'Wed'].map(day => ({ day, breakfast: 'Oats', lunch: 'Salad', dinner: 'Stew' })),
    exercise: { sam: { days: [{ day: 'Mon', cardio: 'Brisk walk 20 min' }, { day: 'Wed', strength: 'Workout A' }, { day: 'Fri', cardio: 'Optional: easy walk' }, { day: 'Sun', note: 'Rest day' }] } },
  }],
  people: { sam: { name: 'Sam', portion: 1 } },
  groups: { Oats: { veg: 0, fruit: 1 }, Salad: { veg: 2, fruit: 0 }, Stew: { veg: 3, fruit: 0 } },
};
const ctx = { readPlan: () => PLAN, people: () => ['sam'] };

// Puts one meal slot straight into the meal log.
function logMeal(day, slot, dish, at, extra = {}) {
  db.open().prepare(`INSERT INTO meal_log (person, plan_id, round, week, week_name, day, slot, dish, eaten, eaten_at, score, note, skip_reason, updated_at)
    VALUES ('sam', 'wk', 0, 0, 'Week 1', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(day, slot, dish, extra.skip ? 0 : 1, extra.skip ? null : at, extra.score || null, extra.skip || null, at);
}

test('a week: meals, best and low scores, skips with reasons, sessions, veg days and the dated log', () => {
  // Last week: Monday all three meals (5 veg), Tuesday two (2 veg + 1 fruit: short on veg for an adult).
  logMeal('Mon', 'Breakfast', 'Oats', lastWeek(0));
  logMeal('Mon', 'Lunch', 'Salad', lastWeek(0), { score: 9 });
  logMeal('Mon', 'Dinner', 'Stew', lastWeek(0));
  logMeal('Tue', 'Breakfast', 'Oats', lastWeek(1));
  logMeal('Tue', 'Lunch', 'Salad', lastWeek(1), { score: 3 });
  logMeal('Tue', 'Dinner', 'Stew', lastWeek(1), { skip: 'time' });
  logMeal('Wed', 'Dinner', 'Stew', lastWeek(2), { skip: 'time' });
  // The week before: one meal.
  db.open().prepare(`INSERT INTO meal_log (person, plan_id, round, week, week_name, day, slot, dish, eaten, eaten_at, updated_at)
    VALUES ('sam', 'wk', 1, 0, 'Week 1', 'Mon', 'Dinner', 'Stew', 1, ?, ?)`).run(lastWeek(-7), lastWeek(-7));
  db.open().prepare(`INSERT INTO exercise_log (person, plan_id, round, week, day, slot, session, done_at) VALUES ('sam', 'wk', 0, 0, 'Mon', 'cardio', 'Brisk walk', ?)`).run(lastWeek(0));
  // The dated log: one in last week, one far too old to count.
  db.setSetting('week-log:sam', JSON.stringify([
    { at: lastWeek(-30), kind: 'tried', food: 'Old food', result: 'liked' },
    { at: lastWeek(3), kind: 'cardio', moved: 1, level: 2 },
    { at: lastWeek(3), kind: 'tried', food: 'Sweet potato wedges', result: 'tried' },
    { at: lastWeek(4), kind: 'tried', food: 'Sweet potato wedges', result: 'liked' },   // the same food again: shown once
  ]));

  const r = weekreview.review('sam', 'last', TZ, ctx);
  const w = r.week;
  assert.equal(w.meals, 5);
  assert.equal(r.before.meals, 1);
  assert.deepEqual(w.best, [{ dish: 'Salad', score: 9 }]);
  assert.deepEqual(w.low, [{ dish: 'Salad', score: 3 }]);
  assert.equal(w.skipped, 2);
  assert.deepEqual(w.reasons, [{ key: 'time', label: 'No time', n: 2 }]);
  assert.equal(w.sessions, 1);
  assert.equal(w.planned, 2, 'optional sessions and rest days are not planned sessions');
  assert.equal(w.daysCounted, 2);
  assert.equal(w.shortVeg, 1, 'Tuesday came in under the vegetable serves');
  assert.deepEqual(w.cardio, [{ moved: 1, level: 2 }]);
  assert.deepEqual(w.tried, [{ food: 'Sweet potato wedges', result: 'liked' }]);
  assert.match(r.consider, /You said “No time” or “Too much effort” for 2 meals/);
});

test('"One thing to consider" follows the wording rules for health text', () => {
  const base = { meals: 3, sessions: 1, planned: 1, skipped: 0, reasons: [], shortVeg: 0, shortFruit: 0 };
  const cases = [
    Object.assign({}, base, { skipped: 2, reasons: [{ key: 'missing', n: 2 }] }),
    Object.assign({}, base, { skipped: 2, reasons: [{ key: 'refused', n: 2 }] }),
    Object.assign({}, base, { planned: 4, sessions: 1 }),
    Object.assign({}, base, { shortVeg: 4 }),
    Object.assign({}, base, { shortFruit: 3 }),
    Object.assign({}, base, { meals: 0, sessions: 0 }),
    base,
  ];
  const seen = new Set();
  for (const w of cases) {
    const text = weekreview.considerNext(w, '');
    seen.add(text);
    assert.doesNotMatch(text, /\badvice\b|\balways\b|\bnever\b|\bmust\b/i, text);
  }
  assert.equal(seen.size, cases.length, 'each situation gets its own consideration');
  assert.match(weekreview.considerNext(cases[2], ''), /physio or GP/);
  assert.match(weekreview.considerNext(cases[3], ''), /dietitian or GP/);
});

test('the route: your own week, a cardio step and a food tried show up, unknown people are refused', async t => {
  const server = await startServer();
  t.after(() => server.stop());
  const owner = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery', country: 'au' };
  assert.equal((await server.request('POST', '/auth/register', { ...owner, setupCode: server.setupCode() })).status, 200);
  const mine = await server.request('GET', '/api/week-review?week=this&tz=UTC');
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.person, 'alex-smith');
  assert.equal(mine.json.which, 'this');
  assert.equal(mine.json.week.meals, 0);
  assert.equal(typeof mine.json.consider, 'string');
  assert.equal((await server.request('GET', '/api/week-review?person=nobody')).status, 404);

  // Two "Too easy" answers step cardio up; "Liked it" on a small step; both land in this week.
  const cardio = require('../api/cardio');
  await server.request('PUT', '/api/profile?person=alex-smith', { answers: { age: '40', cardio_level: cardio.START[1] } });
  await server.request('POST', '/api/exercises/cardio?person=alex-smith', { id: '1|Tue-cardio', feel: 'easy' });
  await server.request('POST', '/api/exercises/cardio?person=alex-smith', { id: '1|Thu-cardio', feel: 'easy' });
  assert.equal((await server.request('PUT', '/api/steps?person=alex-smith', { food: 'Corn cob', result: 'liked' })).status, 200);
  const after = await server.request('GET', '/api/week-review?week=this&tz=UTC');
  assert.deepEqual(after.json.week.cardio, [{ moved: 1, level: 2 }]);
  assert.deepEqual(after.json.week.tried, [{ food: 'Corn cob', result: 'liked' }]);

  const page = fs.readFileSync(path.join(ROOT, 'site', 'week.html'), 'utf8');
  assert.match(page, /\/api\/week-review/);
  assert.match(fs.readFileSync(path.join(ROOT, 'site', 'app-today.js'), 'utf8'), /week\.html\?from=today/);
  assert.match(fs.readFileSync(path.join(ROOT, 'site', 'progress.html'), 'utf8'), /id="weekLink" href="week\.html"/);
});

test('forgetting someone removes their dated log too', () => {
  db.setSetting('week-log:gone', '[]');
  db.forgetPerson('gone');
  assert.equal(db.getSetting('week-log:gone'), null);
});

test('saving again only re-stamps meals that changed, so a skip stays in the week it was made', () => {
  const plan = { id: 'stamp', weeks: [{ name: 'Week 1', meals: [{ day: 'Mon', lunch: 'Soup', dinner: 'Stew' }] }] };
  db.syncMeals('pat', plan, 0, { 0: [] }, { 0: { 'Mon|Dinner': { x: 'time' } } });
  const stamp = () => db.open().prepare("SELECT slot, updated_at FROM meal_log WHERE person = 'pat' ORDER BY slot").all();
  const old = Date.now() - 9 * DAY;   // pretend the skip was made last week
  db.open().prepare("UPDATE meal_log SET updated_at = ? WHERE person = 'pat'").run(old);
  // A week later, the page saves again with a new tick (Mon lunch); the skip is unchanged.
  db.syncMeals('pat', plan, 0, { 0: ['Mon|Lunch'] }, { 0: { 'Mon|Dinner': { x: 'time' } } });
  const rows = stamp();
  assert.equal(rows.find(r => r.slot === 'Dinner').updated_at, old, 'the unchanged skip keeps its time');
  assert.ok(rows.find(r => r.slot === 'Lunch').updated_at > old, 'the new tick gets a new time');
  // Changing the reason is a change.
  db.syncMeals('pat', plan, 0, { 0: ['Mon|Lunch'] }, { 0: { 'Mon|Dinner': { x: 'out' } } });
  assert.ok(stamp().find(r => r.slot === 'Dinner').updated_at > old);
});

test('veg days go by the plan’s day, not the moment the meals were ticked', () => {
  const plan = Object.assign({}, PLAN, { id: 'catchup' });
  const ctx2 = { readPlan: () => plan, people: () => ['cat'] };
  const at = lastWeek(3);   // everything ticked at once on Thursday
  const ins = db.open().prepare(`INSERT INTO meal_log (person, plan_id, round, week, week_name, day, slot, dish, eaten, eaten_at, updated_at)
    VALUES ('cat', 'catchup', 0, 0, 'Week 1', ?, ?, ?, 1, ?, ?)`);
  for (const day of ['Mon', 'Tue']) for (const [slot, dish] of [['Breakfast', 'Oats'], ['Lunch', 'Salad'], ['Dinner', 'Stew']]) ins.run(day, slot, dish, at, at);
  const w = weekreview.review('cat', 'last', TZ, ctx2).week;
  assert.equal(w.daysCounted, 2, 'Monday and Tuesday, not one big Thursday');
  assert.equal(w.shortVeg, 0);
});
