// Checks the built-in plan builder (api/planbuilder.js): allergies and diets are respected,
// children never get an energy deficit, exercise suits injuries and pregnancy, and every country
// gets a plan priced in its own currency.

const test = require('node:test');
const assert = require('node:assert/strict');
const pb = require('../api/planbuilder');
const ht = require('../api/healthtargets');
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

test('the builder also works without require(), as in the phone app', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'api', f), 'utf8'));
  const page = { window: {} };
  vm.createContext(page);
  // The targets file is loaded first, on the same page, as the phone app does.
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'api', 'healthtargets.js'), 'utf8'), page);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'api', 'planbuilder.js'), 'utf8'), page);
  const app = page.window.PlanBuilder;
  app.useData({ library: read('library.json'), exercises: read('exercises.json'), prices: read('library-prices.json') });
  const plan = app.build([{ key: 'a', name: 'A', answers: { age: 40 } }], { seed: 42, country: 'uk', locale: 'en-GB' }).plan;
  assert.equal(plan.currency, 'GBP');
  assert.ok(plan.weeks.length >= 4);
});

test('every cuisine choice in About me matches dishes in the library (French has none yet)', () => {
  // Looks through every section of the About me questions for the one called "cuisines".
  const find = node => Array.isArray(node) ? node.map(find).find(Boolean)
    : node && typeof node === 'object' ? (node.id === 'cuisines' ? node : find(Object.values(node))) : null;
  const options = find(require('../site/questions.json')).options;
  const inLibrary = new Set(LIB.dishes.map(d => d.cuisine));
  const noDishesYet = ['French'];
  for (const option of options) {
    if (noDishesYet.includes(option)) continue;
    const [cuisine] = pb.rulesFor({ key: 'p', name: 'P', answers: { cuisines: [option] } }).cuisines;
    assert.ok(inLibrary.has(cuisine), `"${option}" matches no dishes in the library`);
  }
});

test('snacks vary between plans instead of always being the first ones in the library', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const plan = build([{ age: 40 }, { age: 8 }], { seed });
    for (const person of Object.values(plan.people)) for (const s of person.snacks || []) seen.add(s.what);
  }
  assert.ok(seen.size >= 8, 'only ' + seen.size + ' different snacks across 12 plans');
});

test('a snack matching a food someone loves is picked for them', () => {
  for (let seed = 1; seed <= 5; seed++) {
    const plan = build([{ age: 40, likes: 'hummus' }], { seed });
    const snacks = Object.values(plan.people)[0].snacks.map(s => s.what.toLowerCase());
    assert.ok(snacks.some(s => s.includes('hummus')), 'no hummus snack with seed ' + seed + ': ' + snacks.join(', '));
  }
});

test('on days school or work provides lunch, the plan packs none', () => {
  const plan = build([{ age: 40, lunch_provided: ['Mon'] }, { age: 10, packed_lunch: 'Some days', lunch_provided: ['Fri'] }]);
  const [adult, child] = Object.keys(plan.people);
  assert.equal(plan.people[child].weekday.Fri.lunch, 'School provides lunch');
  assert.notEqual(plan.people[child].weekday.Thu.lunch, 'School provides lunch');
  for (const week of plan.weeks.filter(w => w.meals)) {
    const mon = week.meals.find(m => m.day === 'Mon');
    assert.equal(((mon.people || {})[adult] || {}).lunch, 'Work provides lunch');
  }
});

test('"Work or school provides lunch" without days means Monday to Friday', () => {
  const plan = build([{ age: 40 }, { age: 9, packed_lunch: 'Work or school provides lunch' }]);
  const child = Object.keys(plan.people)[1];
  for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) assert.equal(plan.people[child].weekday[d].lunch, 'School provides lunch');
});

test('both pool answers, and the older "Pool", count as having a pool', () => {
  const cardio = equipment => JSON.stringify(build([{ age: 40, equipment, exercise_likes: 'swimming' }]).weeks.map(w => w.exercise));
  assert.match(cardio(['Pool at home']), /Swim/);
  assert.match(cardio(['Public pool or swim centre']), /Swim at the pool/);
  assert.match(cardio(['Pool']), /Swim/);
});

test('public pool swims go only on the days they can get there', () => {
  const plan = build([{ age: 40, equipment: ['Public pool or swim centre'], exercise_likes: 'swimming', pool_days: ['Sat'] }]);
  for (const week of plan.weeks.filter(w => w.exercise)) {
    for (const day of Object.values(week.exercise)[0].days) {
      if (/Swim/.test(day.cardio || '')) assert.equal(day.day, 'Sat', 'a swim on ' + day.day);
    }
  }
  const days = Object.values(plan.weeks.find(w => w.exercise).exercise)[0].days;
  assert.ok(days.some(d => /Swim at the pool/.test(d.cardio || '')), 'no swim at all');
  assert.ok(days.some(d => /^Walk/.test(d.cardio || '')), 'other cardio days should be walks');
});

test('a foot injury swaps walks for the pool or bike, and leaves out calf raises and lunges', () => {
  const plan = build([{ age: 33, injuries: 'Injury with my right foot', equipment: ['Dumbbells', 'Bike', 'Public pool or swim centre'], pool_days: ['Sat', 'Sun'] }]);
  for (const week of plan.weeks.filter(w => w.exercise)) {
    for (const day of Object.values(week.exercise)[0].days) {
      if (!day.cardio) continue;
      assert.doesNotMatch(day.cardio, /^Walk/, 'a walk on ' + day.day);
      if (/Swim/.test(day.cardio)) assert.ok(['Sat', 'Sun'].includes(day.day), 'a swim on ' + day.day);
    }
  }
  const workouts = JSON.stringify(Object.values(plan.exercise)[0].workouts).toLowerCase();
  assert.doesNotMatch(workouts, /calf raise|lunge/);
});

// ---------------------------------------------------------------------------
// Health targets come before likes (api/healthtargets.js)
// ---------------------------------------------------------------------------

// Builds a plan and measures everyone's average vegetable and fruit serves a day against their
// targets: [{key, veg, fruit, target, short}].
function reviewOf(answersList, seed) {
  const people = answersList.map((answers, i) => ({ key: 'p' + i, name: 'Person ' + i, answers }));
  const plan = pb.build(people, { seed }).plan;
  return { plan, review: ht.review(plan, people) };
}

test('everyone’s days reach the guideline serves of vegetables and fruit', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { review } = reviewOf([{ age: 40, sex: 'Male' }, { age: 38, sex: 'Female' }, { age: 9, sex: 'Female' }], seed);
    for (const r of review) assert.deepEqual(r.short, [], r.key + ' got ' + r.veg + ' veg and ' + r.fruit + ' fruit with seed ' + seed);
  }
});

test('a child who dislikes most veggies and fruit still reaches their targets, in soft or blended forms', () => {
  const child = { age: 10, sex: 'Female', dislikes: 'Spicy food, most veggies, fruit', sensory: ['Crunchy or hard textures'], packed_lunch: 'Some days' };
  for (let seed = 1; seed <= 6; seed++) {
    const { plan, review } = reviewOf([{ age: 40, sex: 'Male' }, child], seed);
    assert.deepEqual(review[1].short, [], 'the child got ' + review[1].veg + ' veg and ' + review[1].fruit + ' fruit with seed ' + seed);
    // Nothing crunchy among their snacks and sides, because they said crunchy textures are hard.
    for (const snack of plan.people.p1.snacks) {
      const s = LIB.snacks.find(x => x.what === snack.what);
      assert.ok(!(s.texture || []).includes('crunchy'), snack.what + ' is crunchy');
    }
  }
});

test('a child’s sweeping dislikes aren’t a ban, but a food they name still is', () => {
  const child = pb.rulesFor({ key: 'c', name: 'C', answers: { age: 10, dislikes: 'most veggies, fruit, pumpkin' } });
  assert.deepEqual(child.avoidWords, ['pumpkin']);
  assert.ok(child.gentleVeg && child.gentleFruit);
  // An adult's own words are kept as they wrote them.
  const adult = pb.rulesFor({ key: 'a', name: 'A', answers: { age: 40, dislikes: 'most veggies, pumpkin' } });
  assert.deepEqual(adult.avoidWords, ['most veggy', 'pumpkin']);
});

test('one person disliking vegetables doesn’t lower them for everyone else', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { review } = reviewOf([{ age: 40, sex: 'Male' }, { age: 10, dislikes: 'most veggies' }], seed);
    assert.ok(review[0].veg >= review[0].target.veg - ht.CLOSE, 'the adult got ' + review[0].veg + ' veg with seed ' + seed);
  }
});

test('the three answers to "How much should the plan change what you eat?" each mean a different pace', () => {
  const find = node => Array.isArray(node) ? node.map(find).find(Boolean)
    : node && typeof node === 'object' ? (node.id === 'eating_change' ? node : find(Object.values(node))) : null;
  const options = find(require('../site/questions.json')).options;
  assert.deepEqual(options.map(o => ht.paceFor({ eating_change: o })), ['full', 'build', 'own']);
  assert.equal(ht.paceFor({}), 'full', 'no answer means from week 1');
});

test('someone building up gets less added in weeks 1 and 2, and reaches their serves by weeks 3 and 4', () => {
  const child = { age: 10, sex: 'Female', dislikes: 'most veggies, fruit', eating_change: 'Build up to them over the 4 weeks' };
  let eased = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { plan, review } = reviewOf([{ age: 40, sex: 'Male' }, child], seed);
    assert.deepEqual(review[1].short, [], 'the child got ' + review[1].veg + ' veg and ' + review[1].fruit + ' fruit in weeks 3 and 4 with seed ' + seed);
    for (const snack of plan.people.p1.snacks) {
      if (!snack.weeks) continue;
      eased++;
      assert.ok(snack.weeks.length < 4 && snack.weeks.every(n => n >= 1 && n <= 4), JSON.stringify(snack));
    }
    const early = ht.dailyAverage(plan, 'p1', [1]), late = ht.dailyAverage(plan, 'p1', [3, 4]);
    assert.ok(early.veg + early.fruit <= late.veg + late.fruit + 1.5, 'week 1 has more than weeks 3 and 4 with seed ' + seed);
  }
  assert.ok(eased > 0, 'nothing was added for only some weeks');
});

test('someone keeping close to what they eat now gets nothing added, and isn’t reported as short', () => {
  const own = { age: 10, dislikes: 'most veggies, fruit', eating_change: 'Keep it close to what I eat now' };
  for (let seed = 1; seed <= 6; seed++) {
    const people = [{ key: 'p0', name: 'Person 0', answers: { age: 40 } }, { key: 'p1', name: 'Person 1', answers: own }];
    const built = pb.build(people, { seed });
    for (const snack of built.plan.people.p1.snacks) assert.doesNotMatch(snack.when, /^With |^After dinner$/);
    assert.deepEqual(ht.review(built.plan, people)[1].short, []);
    assert.doesNotMatch(built.notesForAdmin, /Person 1’s days average/);
    assert.match(built.plan.people.p1.tips.join(' '), /You chose to keep close to what you eat now/);
  }
});

// ---------------------------------------------------------------------------
// Food already in the kitchen
// ---------------------------------------------------------------------------

test('the kitchen list is read into ingredients and amounts, and says what it couldn’t match', () => {
  const read = pb.kitchenStock(['rice 2 kg', '6 eggs', 'peas', '2 tins diced tomatoes, spaghetti', 'tomato sauce', 'dragon fruit']);
  assert.deepEqual(read.stock.rice.map(x => x.amount), [2000]);
  assert.deepEqual(read.stock.egg.map(x => x.amount), [6]);
  assert.deepEqual(read.stock['frozen peas'].map(x => x.amount), [1000], 'no amount means one pack');
  assert.deepEqual(read.stock['canned tomatoes'].map(x => x.amount), [800], '2 tins of 400 g');
  assert.ok(read.stock.pasta, 'spaghetti is pasta');
  assert.deepEqual(read.unknown, ['tomato sauce', 'dragon fruit']);
  assert.deepEqual(pb.kitchenStock(null), { stock: {}, counted: [], unknown: [] });
});

test('food already in the kitchen is left off the shopping lists, and meals that use it are preferred', () => {
  const people = [{ key: 'a', name: 'A', answers: { age: 40 } }, { key: 'b', name: 'B', answers: { age: 38 } }];
  const shop = plan => plan.weeks.flatMap(w => Object.values(w.shopping).flat());
  // How many dinners over the 4 weeks use rice.
  const riceDinners = plan => plan.weeks.flatMap(w => w.meals || []).filter(m => {
    const dish = LIB.dishes.find(d => d.name === m.dinner);
    return dish && dish.per.some(x => x[0] === 'rice');
  }).length;
  let withList = 0, withoutList = 0;
  for (let seed = 1; seed <= 6; seed++) {
    withoutList += riceDinners(pb.build(people, { seed }).plan);
    const built = pb.build(people, { seed, pantry: ['rice 5 kg', 'frozen peas 3 kg'] });
    withList += riceDinners(built.plan);
    assert.ok(!shop(built.plan).some(item => /^(Jasmine rice|Frozen peas)/.test(item[0])), 'rice or peas were bought with seed ' + seed);
    assert.match(built.notesForAdmin, /From your kitchen list, the plan counts: Jasmine rice 1 kg, Frozen peas 1 kg/);
  }
  assert.ok(withList > withoutList, withList + ' rice dinners with the list, ' + withoutList + ' without');
});

test('dinners the family rated well come back more often, and ones they rated poorly less often', () => {
  const people = [{ key: 'a', name: 'A', answers: { age: 40 } }, { key: 'b', name: 'B', answers: { age: 38 } }];
  // How many times each dinner turns up over several plans: {name: count}.
  const tally = rated => {
    const seen = {};
    for (let seed = 1; seed <= 8; seed++) {
      const plan = pb.build(people, { seed, rated }).plan;
      for (const m of plan.weeks.flatMap(w => w.meals || [])) seen[m.dinner] = (seen[m.dinner] || 0) + 1;
    }
    return seen;
  };
  const count = (name, rated) => tally(rated)[name] || 0;
  // Without ratings: the dinner that turns up most becomes the one they disliked, and one that
  // turns up least becomes the one they loved.
  const before = tally({});
  const names = LIB.dishes.filter(d => d.meal === 'dinner').map(d => d.name).sort((x, y) => (before[x] || 0) - (before[y] || 0));
  const loved = names[0], disliked = names[names.length - 1];
  const rated = { [loved.toLowerCase()]: 9.5, [disliked.toLowerCase()]: 2 };
  assert.ok(count(loved, rated) > count(loved, {}), loved + ' didn’t come back more often');
  assert.ok(count(disliked, rated) < count(disliked, {}), disliked + ' didn’t come back less often');
});

// ---------------------------------------------------------------------------
// Feedback, logged health numbers, small steps and use-it-up
// ---------------------------------------------------------------------------

test('a person’s own low score for a dinner makes it turn up less often', () => {
  const tally = feedback => {
    const seen = {};
    for (let seed = 1; seed <= 8; seed++) {
      const plan = pb.build([{ key: 'a', name: 'A', answers: { age: 40 }, feedback }], { seed }).plan;
      for (const m of plan.weeks.flatMap(w => w.meals || [])) seen[m.dinner] = (seen[m.dinner] || 0) + 1;
    }
    return seen;
  };
  const before = tally(null);
  const most = Object.keys(before).sort((x, y) => before[y] - before[x])[0];
  const after = tally({ rated: { [most.toLowerCase()]: 1 }, notes: [{ dish: most, note: 'too salty' }] });
  assert.ok((after[most] || 0) < before[most], most + ': ' + before[most] + ' times before, ' + (after[most] || 0) + ' after');
});

test('written notes are passed on to the admin, because the builder can’t read them', () => {
  const people = [{ key: 'a', name: 'Alex', answers: { age: 40 }, feedback: { rated: {}, notes: [{ dish: 'Tuna pasta bake', note: 'too dry' }] } }];
  assert.match(pb.build(people, { seed: 1 }).notesForAdmin, /Alex on Tuna pasta bake: “too dry”/);
});

test('a logged weight is used in place of the About me weight, and says so', () => {
  const answers = { age: 40, sex: 'Male', height: 180, weight: 80, activity: 'Mostly sitting (desk job)' };
  const built = measured => pb.build([{ key: 'a', name: 'Alex', answers, measured }], { seed: 1 });
  const lighter = built(null).plan.people.a, heavier = built({ weight: 110, weightDate: '2026-11-01' }).plan.people.a;
  assert.ok(heavier.portion > lighter.portion, heavier.portion + ' is not more than ' + lighter.portion);
  assert.match(heavier.guide, /latest logged weight \(110 kg on 2026-11-01\)/);
});

test('small steps: someone who isn’t keen on vegetables gets one new food a week, built on foods they like', () => {
  const answers = { age: 10, dislikes: 'most veggies', likes: 'chips and gravy, mac and cheese' };
  const stepsFor = person => pb.build([{ key: 'a', name: 'A', answers: { age: 40 } }, Object.assign({ key: 'k', name: 'K', answers }, person)], { seed: 1 }).plan.people.k.steps;
  const steps = stepsFor({});
  assert.deepEqual(steps.map(s => s.week), [1, 2, 3, 4]);
  for (const s of steps) assert.ok(['chips', 'mac and cheese'].includes(s.from), s.from);
  // A food they liked isn't offered again: the next plan moves on.
  const next = stepsFor({ tried: { [steps[0].food]: 'liked' } });
  assert.ok(!next.some(s => s.food === steps[0].food));
  // A milk allergy leaves out every step with milk or cheese in it.
  const noMilk = stepsFor({ answers: Object.assign({}, answers, { allergies: ['Milk'] }) });
  assert.ok(noMilk.length && !noMilk.some(s => /cheese|yoghurt|smoothie/i.test(s.food)), JSON.stringify(noMilk.map(s => s.food)));
  // People who are fine with vegetables, or who chose to keep to their own food, get none.
  assert.equal(stepsFor({ answers: { age: 10 } }), undefined);
  assert.equal(stepsFor({ answers: Object.assign({}, answers, { eating_change: 'Keep it close to what I eat now' }) }), undefined);
});

test('use it up: weeks list fresh food likely to be left over, as short pieces of text', () => {
  let listed = 0;
  for (let seed = 1; seed <= 4; seed++) {
    const plan = build([{ age: 40 }, { age: 38 }], { seed });
    for (const week of plan.weeks) {
      if (week.kind === 'stockup') assert.equal(week.useUp, undefined);
      for (const text of week.useUp || []) {
        listed++;
        assert.match(text, /^(most of the|about half of the|about a third of the) \S/);
        assert.doesNotMatch(text, /Frozen|rice 1 kg/i, 'pantry and freezer food keeps');
      }
    }
  }
  assert.ok(listed > 0);
});

test('vegetable sides are only added as sides, never as an ordinary or school snack', () => {
  const sides = new Set(LIB.snacks.filter(s => s.kind === 'side').map(s => s.what));
  assert.ok(sides.size >= 3, 'the library has vegetable sides');
  for (let seed = 1; seed <= 6; seed++) {
    const plan = build([{ age: 40 }, { age: 9, packed_lunch: 'Yes, most days' }], { seed });
    for (const person of Object.values(plan.people)) {
      for (const snack of person.snacks) if (sides.has(snack.what)) assert.match(snack.when, /^With (dinner|lunch)$/);
      for (const day of Object.values(person.weekday || {})) assert.ok(!sides.has(day.snack), day.snack + ' as a school snack');
    }
  }
});
