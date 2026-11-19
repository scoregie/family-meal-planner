// Checks the Meals tab's "things to consider" for a day (site/app-meals.js dayConsiderations):
// the strength-day snack line only names snacks that are in this week's snacks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers');

// Loads app-meals.js with small stand-ins for the parts of the app it uses here.
function loadMeals(mealWeek) {
  const page = {
    week: 0,
    short: d => String(d).slice(0, 3),
    mealWeekNumber: () => mealWeek,
    exDayOf: () => ({ day: 'Mon', strength: 'Strength 1A' }),
    sessionLines: () => ['Strength 1A'],
    isWeightsDay: () => true,
  };
  vm.createContext(page);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', 'app-meals.js'), 'utf8'), page);
  // app-meals.js has its own helpers with these names; keep the stand-ins.
  Object.assign(page, { short: d => String(d).slice(0, 3), mealWeekNumber: () => mealWeek, exDayOf: () => ({ day: 'Mon', strength: 'Strength 1A' }), sessionLines: () => ['Strength 1A'], isWeightsDay: () => true });
  return page;
}

test('a strength snack that starts in week 3 isn’t named on a week 1 strength day', () => {
  const person = { snacks: [{ when: 'After training', what: 'Glass of milk', exercise: 'strength', weeks: [3, 4] }] };
  const week1 = loadMeals(1).dayConsiderations({ day: 'Mon' }, person, [], 'a', 0).join(' ');
  assert.doesNotMatch(week1, /Glass of milk/);
  const week3 = loadMeals(3).dayConsiderations({ day: 'Mon' }, person, [], 'a', 0).join(' ');
  assert.match(week3, /Strength day: Glass of milk/);
});
