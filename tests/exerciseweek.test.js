// Checks "Your exercise week" and "What should your plan be built around?" (About me): the server
// keeps only sessions that fit the question, the built-in builder keeps every session someone
// set, in the part of the day they chose, with a workout for each part of the body, and a plan
// built around exercise fits snacks and serves to the sessions. The plan checks send back a
// draft that leaves sessions out.

const test = require('node:test');
const assert = require('node:assert/strict');
const pb = require('../api/planbuilder');
const plancheck = require('../api/plancheck');
const { startServer } = require('./helpers');

// The example week: 30 minutes of cardio on Mon, Wed and Fri mornings with chest, arms and core
// in the afternoons, an hour of cardio on Tue and Thu mornings, and an hour's swim on Saturday.
const WEEK = {
  Mon: { morning: { kind: 'Cardio', minutes: 30 }, afternoon: { kind: 'Strength', minutes: 45, area: 'Chest' } },
  Tue: { morning: { kind: 'Cardio', minutes: 60 } },
  Wed: { morning: { kind: 'Cardio', minutes: 30 }, afternoon: { kind: 'Strength', minutes: 45, area: 'Arms' } },
  Thu: { morning: { kind: 'Cardio', minutes: 60 } },
  Fri: { morning: { kind: 'Cardio', minutes: 30 }, afternoon: { kind: 'Strength', minutes: 45, area: 'Core' } },
  Sat: { morning: { kind: 'Swimming', minutes: 60 } },
};
const ADULT = {
  age: 35, sex: 'Male', height: 180, weight: 100, activity: 'Mostly sitting (desk job)',
  goal: ['Lose weight'], pace: 'Slow and steady', cardio_level: 'I can walk briskly for 30 minutes or more',
  equipment: ['Dumbbells', 'Resistance bands', 'Exercise bike', 'Public pool or swim centre'],
  exercise_week: WEEK,
};
const EXERCISE_FIRST = 'My exercise: fit my meals around it';

// Builds a plan for one person with these answers.
function build(answers) {
  return pb.build([{ key: 'p0', name: 'Person 0', answers }], { seed: 42 }).plan;
}

// The meal weeks of a plan.
const mealWeeks = plan => plan.weeks.filter(w => Array.isArray(w.meals));

test('every session in the week is kept, in its part of the day, in all 4 weeks', () => {
  const plan = build(ADULT);
  for (const week of mealWeeks(plan)) {
    const days = Object.fromEntries(week.exercise.p0.days.map(d => [d.day, d]));
    assert.match(days.Mon.morning, /30 minutes/);
    assert.match(days.Mon.afternoon, /^Strength: Chest [12], 45 minutes$/);
    assert.match(days.Wed.afternoon, /^Strength: Arms [12]/);
    assert.match(days.Fri.afternoon, /^Strength: Core [12]/);
    assert.match(days.Tue.morning, /60 minutes/);
    assert.equal(days.Tue.afternoon, undefined);
    assert.match(days.Sat.morning, /^Swim at the pool 60 minutes/);
    assert.match(days.Sun.mobility, /^Rest/);
  }
  assert.deepEqual(plancheck.problems(plan, [{ key: 'p0', name: 'Person 0', answers: ADULT }]).filter(p => /exercise week/.test(p)), []);
});

test('each part of the body gets its own workouts, harder in weeks 3 and 4', () => {
  const plan = build(ADULT);
  const names = plan.exercise.p0.workouts.map(w => w.name.split(':')[0]);
  assert.deepEqual(names, ['Chest 1', 'Chest 2', 'Arms 1', 'Arms 2', 'Core 1', 'Core 2']);
  const arms = plan.exercise.p0.workouts.find(w => w.name.startsWith('Arms 1'));
  assert.ok(arms.items.some(i => /curl/i.test(i)) && arms.items.some(i => /triceps|dip/i.test(i)), 'arms has biceps and triceps work');
  const week3 = mealWeeks(plan)[2].exercise.p0.days.find(d => d.day === 'Mon');
  assert.match(week3.afternoon, /Chest 2/);
});

test('a sore foot leaves out lunges and calf raises on a legs day, and cardio isn’t walking', () => {
  const week = { Mon: { morning: { kind: 'Cardio', minutes: 30 }, afternoon: { kind: 'Strength', minutes: 60, area: 'Legs' } } };
  const plan = build({ ...ADULT, injuries: 'Sore right foot', exercise_week: week });
  const legs = plan.exercise.p0.workouts.find(w => w.name.startsWith('Legs 1'));
  assert.ok(!legs.items.some(i => /lunge|calf raise/i.test(i)), legs.items.join('\n'));
  const mon = mealWeeks(plan)[0].exercise.p0.days.find(d => d.day === 'Mon');
  assert.doesNotMatch(mon.morning, /walk/i);
});

test('built around exercise: snacks for long sessions and strength, on the right days', () => {
  const snacks = build({ ...ADULT, plan_priority: EXERCISE_FIRST }).people.p0.snacks;
  const before = snacks.find(s => s.when === 'Before your morning session');
  const after = snacks.find(s => s.when === 'After your long session');
  assert.deepEqual(before.days, ['Tue', 'Thu', 'Sat']);
  assert.deepEqual(after.days, ['Tue', 'Thu', 'Sat']);
  const strength = snacks.find(s => s.exercise === 'strength');
  assert.equal(strength.when, 'After your afternoon strength session');
  assert.deepEqual(strength.days, ['Mon', 'Wed', 'Fri']);
  // Losing weight: the afternoon snack is left off the rest day (Sunday).
  const afternoon = snacks.find(s => /^Afternoon/.test(s.when));
  assert.ok(afternoon.days && !afternoon.days.includes('Sun'));
});

test('built around exercise: serves count the sessions, and meals first doesn’t', () => {
  const first = build({ ...ADULT, plan_priority: EXERCISE_FIRST }).people.p0;
  const meals = build(ADULT).people.p0;
  assert.ok(first.portion > meals.portion, first.portion + ' vs ' + meals.portion);
  assert.match(first.guide, /built around your exercise week/);
  assert.match(first.guide, /rest days a little less/);
  assert.ok(!meals.snacks.some(s => /^Before your/.test(s.when)));
  assert.ok(first.times.some(t => /^Before your morning session \(Tue, Thu, Sat\)/.test(t.when)));
});

test('the plan checks send back a draft that leaves a session out', () => {
  const plan = build(ADULT);
  const week1 = mealWeeks(plan)[0].exercise.p0.days.find(d => d.day === 'Wed');
  delete week1.afternoon;
  const found = plancheck.problems(plan, [{ key: 'p0', name: 'Person 0', answers: ADULT }]);
  assert.ok(found.some(p => /exercise week/.test(p) && /Wed afternoon \(Strength, Arms, 45 minutes\)/.test(p)), found.join('\n'));
});

test('plan writers get the week as plain lines', () => {
  assert.deepEqual(pb.weekText(WEEK).slice(0, 2), ['Mon morning: Cardio, 30 minutes', 'Mon afternoon: Strength (Chest), 45 minutes']);
  assert.deepEqual(pb.weekText(undefined), []);
});

test('the server keeps only sessions that fit the question', async () => {
  const server = await startServer();
  try {
    const owner = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery', setupCode: server.setupCode() };
    assert.equal((await server.request('POST', '/auth/register', owner)).status, 200);
    const sent = {
      Mon: { morning: { kind: 'Cardio', minutes: 30, area: 'Chest' }, afternoon: { kind: 'Strength', minutes: 45, area: 'Chest' }, evening: { kind: 'Cardio' } },
      Tue: { morning: { kind: 'Juggling', minutes: 30 } },
      Wed: { morning: { kind: 'Swimming', minutes: 33 } },
      Someday: { morning: { kind: 'Cardio' } },
    };
    const saved = await server.request('PUT', '/api/profile?person=alex-smith', { answers: { exercise_week: sent, plan_priority: EXERCISE_FIRST } });
    assert.equal(saved.status, 200, saved.text);
    const read = (await server.request('GET', '/api/profile?person=alex-smith')).json.answers;
    assert.deepEqual(read.exercise_week, {
      Mon: { morning: { kind: 'Cardio', minutes: 30 }, afternoon: { kind: 'Strength', minutes: 45, area: 'Chest' } },
      Wed: { morning: { kind: 'Swimming' } },
    });
    assert.equal(read.plan_priority, EXERCISE_FIRST);
    // A week with nothing that fits isn't saved at all.
    await server.request('PUT', '/api/profile?person=alex-smith', { answers: { exercise_week: { Tue: { morning: { kind: 'Juggling' } } } } });
    assert.equal((await server.request('GET', '/api/profile?person=alex-smith')).json.answers.exercise_week, undefined);
    // A whole plan built around the example week passes the server's own checks.
    await server.request('PUT', '/api/profile?person=alex-smith', { answers: { ...ADULT, plan_priority: EXERCISE_FIRST } });
    const draft = await server.request('POST', '/api/plan/draft', { how: 'builtin' });
    assert.equal(draft.status, 200, draft.text);
  } finally {
    await server.stop();
  }
});
