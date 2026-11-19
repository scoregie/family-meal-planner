// Checks Apple Watch cardio fitness (VO2 max) and resting heart rate: Health sync saves them,
// Progress averages them, a watch reading sets the cardio level when About me doesn't, and a
// resting heart rate well above usual is pointed out on the Exercise tab.

const test = require('node:test');
const assert = require('node:assert/strict');
const cardio = require('../api/cardio');
const pb = require('../api/planbuilder');
const shortcutfile = require('../api/shortcutfile');
const { startServer } = require('./helpers');

test('a cardio fitness reading gives a starting level, lower for the same number when younger', () => {
  assert.equal(cardio.levelFromVo2(45, 30, 'Male'), 3);
  assert.equal(cardio.levelFromVo2(45, 60, 'Male'), 5);
  assert.equal(cardio.levelFromVo2(25, 30, 'Female'), 0);
  assert.equal(cardio.levelFromVo2(NaN, 30, 'Male'), null);
});

test('the watch sets the level only when About me has no answer', () => {
  const watch = pb.cardioNow({ age: '40', sex: 'Male' }, null, { vo2max: 44, vo2maxDate: '2026-11-18' });
  assert.equal(watch.from, 'watch');
  assert.equal(watch.known, true);
  assert.equal(watch.level, cardio.levelFromVo2(44, 40, 'Male'));
  const said = pb.cardioNow({ age: '40', sex: 'Male', cardio_level: cardio.START[0] }, null, { vo2max: 44 });
  assert.equal(said.from, 'about-me');
  assert.equal(said.level, 0);
});

test('the shortcut asks Apple Health for cardio fitness and resting heart rate', () => {
  const file = shortcutfile.build('http://192.168.1.2/auth/health-sync');
  assert.match(file, /<string>Cardio Fitness<\/string>/);
  assert.match(file, /<string>Resting Heart Rate<\/string>/);
  assert.match(file, /<string>vo2max<\/string>/);
  assert.match(file, /<string>resting_hr<\/string>/);
});

test('Health sync saves the watch numbers, and a resting heart rate well above usual is pointed out', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const owner = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery', country: 'au' };
  const made = await server.request('POST', '/auth/register', { ...owner, setupCode: server.setupCode ? server.setupCode() : undefined });
  assert.equal(made.status, 200, made.text);
  const key = (await server.request('POST', '/api/health/key?person=alex-smith', {})).json.key;
  assert.ok(key, 'a sync key was made');

  const day = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  // Six ordinary days, then today 10 beats a minute higher.
  for (let n = 6; n >= 0; n--) {
    const sent = await server.request('POST', '/auth/health-sync',
      { date: day(n), steps: '8000', resting_hr: n ? '56 count/min' : '66 count/min', vo2max: n === 3 ? '41.5 mL/(kg·min)' : '' },
      { Authorization: 'Bearer ' + key });
    assert.equal(sent.status, 200, sent.text);
    if (n === 3) assert.deepEqual(sent.json.saved.sort(), ['resting_hr', 'steps', 'vo2max']);
  }

  const progress = (await server.request('GET', '/api/progress?person=alex-smith&weeks=4')).json;
  assert.ok(progress.weeks.some(w => w.vo2max === 41.5), 'the cardio fitness reading is in its week');
  assert.ok(progress.weeks.some(w => w.resting_hr != null), 'resting heart rate is averaged by week');

  const now = (await server.request('GET', '/api/exercises/cardio?person=alex-smith')).json;
  assert.deepEqual(now.resting, { today: 66, usual: 56 });
  assert.equal(now.from, 'watch', 'no About me answer, so the watch reading sets the level');
  assert.equal(now.vo2.value, 41.5);
});
