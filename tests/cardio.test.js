// Checks cardio levels (api/cardio.js): the About me answer sets where cardio starts, "Too easy"
// twice steps it up and "Too hard" steps it back, some people are kept steady, and the plan
// builder and the server use the level.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cardio = require('../api/cardio');
const pb = require('../api/planbuilder');
const { startServer, ROOT } = require('./helpers');

// The first week's cardio for one adult with these About me answers (and saved feelings).
function firstWeek(answers, saved) {
  const plan = pb.build([{ key: 'a', name: 'A', answers: { age: '40', sex: 'Male', ...answers }, cardio: saved }], { seed: 42 }).plan;
  const week = plan.weeks.find(w => w.exercise).exercise.a;
  return { target: week.targets[1], days: week.days.filter(d => d.cardio).map(d => d.cardio), notes: plan.exercise.a.notes };
}

test('the About me choices match the levels, plus "Not sure"', () => {
  const questions = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'questions.json'), 'utf8'));
  const q = questions.sections.flatMap(s => s.questions).find(x => x.id === 'cardio_level');
  assert.deepEqual(q.options, cardio.START.concat('Not sure'));
});

test('two "Too easy" in a row step up, one "Too hard" steps back, "About right" breaks the run', () => {
  const answer = cardio.START[1];
  let saved = null;
  const say = (id, feel) => { const r = cardio.feelAfter(answer, saved, id, feel); saved = r.saved; return r; };
  assert.equal(say('1|Tue-cardio', 'easy').moved, 0);
  assert.equal(say('1|Thu-cardio', 'right').moved, 0);
  assert.equal(say('1|Sat-cardio', 'easy').moved, 0, 'the "About right" in between breaks the run');
  const up = say('2|Tue-cardio', 'easy');
  assert.equal(up.moved, 1);
  assert.equal(up.level, 2);
  assert.equal(say('2|Thu-cardio', 'easy').moved, 0, 'each step needs two more');
  const down = say('2|Sat-cardio', 'hard');
  assert.equal(down.moved, -1);
  assert.equal(cardio.levelNow(answer, saved), 1);
  // A changed About me answer starts again from the new answer.
  assert.equal(cardio.levelNow(cardio.START[4], saved), 4);
});

test('a heart condition keeps cardio steady: "Too easy" doesn’t go past level 2', () => {
  const answers = { cardio_level: cardio.START[2], conditions: ['Heart condition'] };
  const now = pb.cardioNow(answers, null);
  assert.equal(now.limit, 2);
  let saved = null;
  for (const id of ['1|Tue-cardio', '1|Thu-cardio', '1|Sat-cardio']) saved = cardio.feelAfter(answers.cardio_level, saved, id, 'easy', now.limit).saved;
  assert.equal(pb.cardioNow(answers, saved).level, 2);
  assert.match(firstWeek({ cardio_level: cardio.START[5], conditions: ['Heart condition'] }).notes.join(' '), /heart condition.*GP or cardiologist/);
});

test('the builder writes cardio at the person’s level, and plain walks when they didn’t say', () => {
  assert.deepEqual(firstWeek({}).days, ['Walk 20 minutes', 'Walk 20 minutes', 'Walk 20 minutes']);
  assert.match(firstWeek({ cardio_level: cardio.START[3] }).days[0], /^Walk-jog 20 minutes: jog 1 minute/);
  assert.match(firstWeek({ cardio_level: cardio.START[0] }).target, /^3 × easy walk 20 minutes/);
  // Steps from how sessions felt count too.
  assert.match(firstWeek({ cardio_level: cardio.START[0] }, { base: cardio.START[0], offset: 2 }).days[0], /^Brisk walk 20 minutes: add hills/);
  // A sore knee: walks stay walks, however fit they are.
  const knee = firstWeek({ cardio_level: cardio.START[5], injuries: 'sore left knee' });
  assert.ok(knee.days.every(d => /^Brisk walk/.test(d)), knee.days.join('; '));
  assert.match(knee.notes.join(' '), /walks stay walks/);
});

test('the server saves how a session felt and moves the level', async (t) => {
  const server = await startServer();
  t.after(() => server.stop());
  const owner = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery', country: 'au' };
  const made = await server.request('POST', '/auth/register', { ...owner, setupCode: server.setupCode ? server.setupCode() : undefined });
  assert.equal(made.status, 200, made.text);
  const saved = await server.request('PUT', '/api/profile?person=alex-smith', { answers: { age: '40', cardio_level: cardio.START[1] } });
  assert.equal(saved.status, 200, saved.text);

  const start = await server.request('GET', '/api/exercises/cardio?person=alex-smith');
  assert.equal(start.json.level, 1);
  assert.equal(start.json.walk, 'Brisk walk');
  const url = '/api/exercises/cardio?person=alex-smith';
  assert.equal((await server.request('POST', url, { id: '1|Tue-cardio', feel: 'easy' })).json.moved, 0);
  const up = await server.request('POST', url, { id: '1|Thu-cardio', feel: 'easy' });
  assert.equal(up.json.moved, 1);
  assert.equal(up.json.level, 2);
  assert.equal(up.json.felt['1|Thu-cardio'], 'easy', 'the page can show what was said');
  assert.equal((await server.request('POST', url, { id: '1|Sat-cardio', feel: 'bored' })).status, 400);
  assert.equal((await server.request('POST', url, { id: '../x', feel: 'easy' })).status, 400);
});

test('the Exercise tab knows which sessions are cardio and what to say after "Too easy"', () => {
  const vm = require('node:vm');
  const page = { document: { querySelectorAll: () => [] } };
  vm.createContext(page);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', 'app-exercise.js'), 'utf8'), page);
  assert.equal(page.isCardio('cardio', 'Swim at the pool 30 minutes'), true);
  assert.equal(page.isCardio('morning', 'Walk 20 minutes'), true);
  assert.equal(page.isCardio('strength', 'Strength 1A'), false);
  assert.equal(page.isCardio('session', 'Strength 2B'), false);
  const d = { name: 'Comfortable', walk: 'Brisk walk', walkDetail: 'add hills or stairs', level: 2, limit: 5, top: 5 };
  assert.match(page.feelMessage({ ...d, moved: 1 }, 'easy'), /Stepping up.*Comfortable.*hills/);
  assert.match(page.feelMessage({ ...d, moved: 0, toGo: 1 }, 'easy'), /One more/);
  assert.match(page.feelMessage({ ...d, moved: 0, toGo: 2 }, 'easy'), /Two more “Too easy” in a row/);
  assert.match(page.feelMessage({ ...d, moved: 1, level: 3, steady: 2 }, 'easy'), /checking with your GP/);
  assert.match(page.feelMessage({ ...d, moved: 0, limit: 2, why: 'kept steady' }, 'easy'), /kept steady/);
  // What a plan from before cardio levels shows: its walk, plus the person's level under it.
  assert.equal(page.cardioWhat(d, 'Walk 20 minutes'), 'Brisk walk: add hills or stairs');
  assert.equal(page.cardioWhat({ ...d, other: 'steady pace' }, 'Ride 30 minutes'), 'Steady pace');
});

test('the week’s cardio target matches the cardio days, even with 3 strength days', () => {
  const plan = pb.build([{ key: 'a', name: 'A', answers: { age: '40', sex: 'Male' } }], { seed: 42 }).plan;
  for (const w of plan.weeks.filter(x => x.exercise)) {
    const week = w.exercise.a;
    const days = week.days.filter(d => d.cardio).length;
    assert.match(week.targets[1], new RegExp('^' + days + ' × '), w.name + ': ' + week.targets[1] + ' but ' + days + ' days');
  }
  const last = plan.weeks.filter(x => x.exercise).pop().exercise.a;
  assert.equal(last.days.filter(d => d.cardio).length, 5, 'week 4 promises 5 sessions and has 5');
});

test('low energy or chronic pain starts steady, then three "Too easy" in a row step up one level at a time', () => {
  const answers = { cardio_level: cardio.START[4], support_needs: ['Low energy or chronic fatigue'] };
  const start = pb.cardioNow(answers, null);
  assert.equal(start.level, 2, 'starts no higher than steady, whatever they picked');
  assert.match(start.why, /three “Too easy” in a row.*GP/);
  let saved = null, last;
  const say = (id, feel) => { const now = pb.cardioNow(answers, saved); last = cardio.feelAfter(answers.cardio_level, saved, id, feel, now.limit, now.guess, now.steady); saved = last.saved; return last; };
  assert.equal(say('1|Mon-morning', 'easy').moved, 0);
  assert.equal(say('1|Wed-morning', 'easy').moved, 0, 'two isn’t enough past the steady level');
  assert.equal(pb.cardioNow(answers, saved).toGo, 1);
  assert.equal(say('1|Fri-morning', 'easy').moved, 1);
  assert.equal(pb.cardioNow(answers, saved).level, 3);
  assert.equal(pb.cardioNow(answers, saved).toGo, 3, 'the next step needs three more');
  // A heart condition is still held at steady.
  const heart = pb.cardioNow({ cardio_level: cardio.START[4], conditions: ['Heart condition'] }, null);
  assert.equal(heart.limit, 2);
  assert.equal(heart.toGo, 0);
});

test('three "Too easy" saved before this change step up on the next tap', () => {
  // What was saved on a real server: three "easy" with no step (the old hard limit).
  const answers = { cardio_level: cardio.START[2], support_needs: ['Chronic pain'] };
  const saved = { base: cardio.START[2], offset: 0, feels: ['2|Mon-morning', '2|Wed-morning', '2|Fri-morning'].map(id => ({ id, feel: 'easy' })) };
  const now = pb.cardioNow(answers, saved);
  assert.equal(now.toGo, 1);
  const r = cardio.feelAfter(answers.cardio_level, saved, '3|Mon-morning', 'easy', now.limit, now.guess, now.steady);
  assert.equal(r.moved, 1);
  assert.equal(r.level, 3);
});
