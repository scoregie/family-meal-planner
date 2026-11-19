// api/sharedrules.js: the rules the web server and the phone app both follow. The phone app loads
// this same file with no require() and no Node, so it has to work on its own. (Before it existed
// the app kept its own copies, and two had drifted: its Swap checked shared workouts against one
// person, and its Current food messages differed.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const rules = require('../api/sharedrules');

const FILE = path.join(__dirname, '..', 'api', 'sharedrules.js');

test('it loads on its own, the way the phone app loads it', () => {
  const src = fs.readFileSync(FILE, 'utf8');
  const code = src.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /\brequire\(/, 'no other code');
  const page = { window: {} };
  vm.runInNewContext(src, page);
  assert.equal(page.window.SharedRules.toKey('Alex Smith'), 'alex-smith');
  // As the app does it: new Function("module", src)(holder).
  const holder = { exports: {} };
  new Function('module', src)(holder);
  assert.deepEqual(Object.keys(holder.exports).sort(), Object.keys(rules).sort());
});

test('Current food: adding and changing items', () => {
  const food = rules.emptyFood();
  assert.deepEqual(Object.keys(food), rules.FOOD.PLACES);
  assert.equal(rules.tidyFood('  <b>rice</b>   2 kg '), 'brice/b 2 kg');
  assert.equal(rules.addFood(food, 'pantry', 'Rice 2 kg'), '');
  assert.equal(rules.addFood(food, 'pantry', 'rice 2 KG'), '');   // the same thing twice stays one
  assert.deepEqual(food.pantry, ['Rice 2 kg']);
  assert.match(rules.addFood(food, 'pantry', ''), /Type what the food is/);
  assert.equal(rules.changeFood(food, 'pantry', 'Rice 2 kg', 'Rice 1 kg', 'spices'), '');
  assert.deepEqual([food.pantry, food.spices], [[], ['Rice 1 kg']]);
  assert.match(rules.changeFood(food, 'pantry', 'Rice 2 kg', 'x', 'pantry'), /isn’t on the list any more/);
  for (let i = 0; i < rules.FOOD.MAX_ITEMS; i++) food.fridge.push('item ' + i);
  assert.match(rules.addFood(food, 'fridge', 'one more'), /full/);
});

test('Planned meals: their own breakfast, school lunch and a meal set just for them', () => {
  const plan = {
    people: { kid1: { name: 'Sam', breakfast: 'Porridge', weekday: { Mon: { lunch: 'Wrap (packed)', snack: 'Apple' } } } },
    weeks: [{ meals: [{ day: 'Mon', breakfast: 'Toast', lunch: 'Soup', dinner: 'Pasta', people: { kid1: { dinner: 'Plain pasta' } } }] }],
  };
  const key = rules.planKeyFor(plan, 'sam');
  assert.equal(key, 'kid1');
  assert.equal(rules.plannedDish(plan, 0, 'Mon', 'Breakfast', key), 'Porridge');
  assert.equal(rules.plannedDish(plan, 0, 'Mon', 'Lunch', key), 'Wrap (packed)');
  assert.equal(rules.plannedDish(plan, 0, 'Mon', 'School snack', key), 'Apple');
  assert.equal(rules.plannedDish(plan, 0, 'Mon', 'Dinner', key), 'Plain pasta');
  assert.equal(rules.plannedDish(plan, 0, 'Mon', 'Dinner', null), 'Pasta');
  assert.equal(rules.dishKey('Wrap (packed)'), 'wrap');
});

test('Exercise swaps: same kind only, and only checked against a person for their own workouts', () => {
  const exercises = [
    { id: 'sq', name: 'Goblet squat', type: 'squat', dose: '3 x 10', how: 'Hold one dumbbell.' },
    { id: 'lu', name: 'Reverse lunge', type: 'lunge', dose: '3 x 8 each leg', how: 'Step back.' },
    { id: 'pu', name: 'Push-up', type: 'push', dose: '3 x 8', how: 'Hands under shoulders.' },
  ];
  const workouts = () => ({ workouts: [{ name: 'A', items: ['Warm-up: Goblet squat (2 x 5): easy', 'Push-up: slow'] }] });
  let t = workouts();
  const done = rules.swapExercise(t, { workout: 'A', item: 0, to: 'lu' }, exercises, null);
  assert.equal(done.line, 'Warm-up: Reverse lunge (3 x 8 each leg): Step back.');
  assert.equal(done.old.id, 'sq');
  assert.equal(t.workouts[0].items[0], done.line);
  assert.equal(rules.swapExercise(workouts(), { workout: 'A', item: 1, to: 'sq' }, exercises, null).code, 400);
  assert.equal(rules.swapExercise(workouts(), { workout: 'B', item: 0, to: 'lu' }, exercises, null).code, 409);
  assert.equal(rules.swapExercise(workouts(), { workout: 'A', item: 0, to: 'lu' }, exercises, ['sq']).code, 400);
  assert.ok(rules.swapExercise(workouts(), { workout: 'A', item: 0, to: 'lu' }, exercises, ['lu']).line);
});
