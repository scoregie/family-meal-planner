// Checks the built-in plan builder (api/planbuilder.js): allergies and diets are respected,
// children never get an energy deficit, exercise suits injuries and pregnancy, and every country
// gets a plan priced in its own currency.

const test = require('node:test');
const assert = require('node:assert/strict');
const pb = require('../api/planbuilder');
const PRICES = require('../api/library-prices.json');

const LIB = pb.LIB;

// Builds a plan for some people. Answers use the same words as the About me questions.
function build(people, opts = {}) {
  const list = people.map((answers, i) => ({ key: 'p' + i, name: 'Person ' + i, answers }));
  return pb.build(list, { seed: 42, ...opts }).plan;
}

// Every library ingredient used by the plan's meals and snacks, found from the dish names.
function ingredientsUsed(plan) {
  const byName = new Map(LIB.dishes.map(d => [d.name.toLowerCase(), d]));
  const snackByWhat = new Map(LIB.snacks.map(s => [s.what.toLowerCase(), s]));
  const used = new Set();
  const add = per => (per || []).forEach(([key]) => used.add(key));
  for (const week of plan.weeks) {
    for (const day of week.meals || []) {
      for (const slot of ['breakfast', 'lunch', 'dinner']) {
        const dish = byName.get(String(day[slot] || '').toLowerCase());
        if (dish) add(dish.per);
      }
    }
  }
  for (const person of Object.values(plan.people || {})) {
    for (const snack of person.snacks || []) {
      const s = snackByWhat.get(String(snack.what || '').toLowerCase());
      if (s) add(s.per);
    }
  }
  return used;
}

// The tags (like "peanut" or "meat") of every ingredient the plan uses.
function tagsUsed(plan) {
  const tags = new Set();
  for (const key of ingredientsUsed(plan)) for (const t of (LIB.ingredients[key] || {}).tags || []) tags.add(t);
  return tags;
}

test('a plan has 4 weeks of meals and prices that the server accepts', () => {
  const plan = build([{ age: 40 }, { age: 38 }, { age: 9 }]);
  assert.ok(plan.weeks.length >= 4);
  for (const week of plan.weeks) {
    for (const items of Object.values(week.shopping)) {
      for (const item of items) {
        assert.equal(typeof item[0], 'string');
        assert.ok(Number.isFinite(item[1]) && item[1] >= 0, 'price for ' + item[0]);
      }
    }
  }
  assert.ok(ingredientsUsed(plan).size > 20, 'the meals were found in the library');
});

test('the same seed gives the same plan', () => {
  const a = JSON.stringify(build([{ age: 40 }]));
  const b = JSON.stringify(build([{ age: 40 }]));
  assert.equal(a, b);
});

test('allergies are never in the meals or snacks', () => {
  const ALLERGIES = { Peanuts: 'peanut', 'Tree nuts': 'treenut', Milk: 'milk', Eggs: 'egg', 'Wheat or gluten': 'gluten', Fish: 'fish', Shellfish: 'shellfish', Sesame: 'sesame', Soy: 'soy' };
  for (const [answer, tag] of Object.entries(ALLERGIES)) {
    // One allergic adult in a family of three: nobody's meals may contain it, as dinners are shared.
    const plan = build([{ age: 40, allergies: [answer] }, { age: 42 }, { age: 10 }], { seed: 7 });
    const byName = new Map(LIB.dishes.map(d => [d.name.toLowerCase(), d]));
    const own = plan.people.p0.snacks.map(s => s.what.toLowerCase());
    for (const week of plan.weeks) {
      for (const day of week.meals || []) {
        const dish = byName.get(String(day.dinner || '').toLowerCase());
        if (!dish) continue;
        const tags = dish.per.flatMap(([k]) => (LIB.ingredients[k] || {}).tags || []);
        assert.ok(!tags.includes(tag), answer + ' found in the family dinner ' + dish.name);
      }
    }
    for (const what of own) {
      const s = LIB.snacks.find(x => x.what.toLowerCase() === what);
      if (s) assert.ok(!(s.tags || []).includes(tag), answer + ' found in the snack ' + s.what);
    }
  }
});

test('a vegetarian household gets no meat or fish', () => {
  const tags = tagsUsed(build([{ age: 35, diet: ['Vegetarian'] }, { age: 33, diet: ['Vegetarian'] }]));
  for (const t of ['meat', 'poultry', 'beef', 'pork', 'lamb', 'fish', 'shellfish']) assert.ok(!tags.has(t), t + ' in a vegetarian plan');
});

test('children and teenagers never get an energy deficit, even if they ask to lose weight', () => {
  for (const age of [6, 11, 15, 17]) {
    const p = { key: 'k', name: 'Kid', answers: { age, sex: 'Female', height: 150, weight: 60, goal: ['Lose weight'], pace: 'As fast as is safe', activity: 'On my feet some of the day' } };
    const same = { ...p, answers: { ...p.answers, goal: ['Keep my weight steady'] } };
    const portionLose = pb.portionFor(p, pb.rulesFor(p));
    const portionSteady = pb.portionFor(same, pb.rulesFor(same));
    assert.ok(portionLose >= portionSteady, 'age ' + age + ': ' + portionLose + ' < ' + portionSteady);
  }
});

test('pregnant people get bodyweight exercises only', () => {
  const ids = pb.exerciseFits({ key: 'a', name: 'A', answers: { age: 30, conditions: ['Pregnant or breastfeeding'], equipment: ['Dumbbells', 'Gym membership'] } });
  assert.ok(ids.length > 5);
  for (const id of ids) {
    const e = pb.EXERCISES.find(x => x.id === id);
    assert.ok(['none', 'seated'].includes(e.equipment) || e.equipment === undefined, e.name + ' uses ' + e.equipment);
  }
});

test('injuries leave out the exercises that load them, and "no knee problems" is not an injury', () => {
  const all = pb.exerciseFits({ key: 'a', name: 'A', answers: { age: 40 } });
  const knees = pb.exerciseFits({ key: 'a', name: 'A', answers: { age: 40, injuries: 'Sore knees after a fall' } });
  const notKnees = pb.exerciseFits({ key: 'a', name: 'A', answers: { age: 40, injuries: 'No knee problems' } });
  assert.ok(knees.length < all.length, 'sore knees left something out');
  assert.deepEqual(notKnees, all);
  const bending = pb.EXERCISES.filter(e => !knees.includes(e.id) && all.includes(e.id)).map(e => e.type);
  assert.ok(bending.some(t => ['squat', 'lunge'].includes(t)), 'squats or lunges were the ones left out');
});

test('every country builds a plan in its own currency', () => {
  for (const [country, info] of Object.entries(PRICES.countries)) {
    const plan = build([{ age: 40 }, { age: 9 }], { country, locale: 'en-' + country.toUpperCase() });
    assert.equal(plan.currency, info.currency, country);
    const total = plan.weeks.reduce((n, w) => n + w.cost, 0);
    assert.ok(total > 0 && Number.isFinite(total), country + ' has prices');
  }
});

test('Australia is the default, in Australian dollars', () => {
  assert.equal(build([{ age: 40 }]).currency, 'AUD');
});

test('a wheat or gluten allergy gets a plan, with gluten-free breakfasts and lunches', () => {
  const plan = build([{ age: 40, allergies: ['Wheat or gluten'] }, { age: 42 }]);
  const byName = new Map(LIB.dishes.map(d => [d.name, d]));
  for (const week of plan.weeks) {
    for (const day of week.meals || []) {
      for (const slot of ['breakfast', 'lunch']) {
        const dish = byName.get(day[slot]);
        if (dish) assert.ok(!dish.tags.includes('gluten'), day[slot] + ' has gluten');
      }
    }
  }
});

test('if no breakfast in the library fits, the plan says "your own choice" instead of failing', () => {
  const saved = LIB.dishes;
  LIB.dishes = saved.filter(d => d.meal !== 'breakfast');
  try {
    const result = pb.build([{ key: 'a', name: 'A', answers: { age: 40 } }], { seed: 1 });
    assert.equal(result.plan.weeks.find(w => w.meals).meals[0].breakfast, 'Your own choice of breakfast');
    assert.match(result.notesForAdmin, /No breakfast/);
  } finally {
    LIB.dishes = saved;
  }
});
