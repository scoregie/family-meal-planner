// The plan's dates (site/plandates.js): each week's and day's date from the Monday a plan starts
// on, stock-up weeks sharing the dates of the week after them, and which week today is in.
const test = require('node:test');
const assert = require('node:assert/strict');
const PlanDates = require('../site/plandates.js');

// A plan shaped like the app's: Stock-up 1, Week 1, Week 2, Stock-up 2, Week 3, Week 4.
const PLAN = {
  startDate: '2026-11-23',
  weeks: [{ kind: 'stockup' }, { meals: [] }, { meals: [] }, { kind: 'stockup' }, { meals: [] }, { meals: [] }],
};

test('only a real Monday is a start date', () => {
  assert.equal(PlanDates.isMonday('2026-11-23'), true);
  assert.equal(PlanDates.isMonday('2026-11-25'), false);   // a Wednesday
  assert.equal(PlanDates.isMonday('2026-02-30'), false);   // no such day
  assert.equal(PlanDates.isMonday('23/11/2026'), false);
  assert.equal(PlanDates.start({ startDate: '2026-11-25', weeks: [] }), null);
  assert.equal(PlanDates.start({ weeks: [] }), null);
});

test('the coming Monday, and the Monday of a week', () => {
  assert.equal(PlanDates.nextMonday('2026-11-23'), '2026-11-23');   // already a Monday
  assert.equal(PlanDates.nextMonday('2026-11-26'), '2026-11-30');
  assert.equal(PlanDates.nextMonday('2026-11-29'), '2026-11-30');   // a Sunday
  assert.equal(PlanDates.mondayOf('2026-11-29'), '2026-11-23');
  assert.equal(PlanDates.addDays('2026-12-28', 7), '2027-01-04');   // over the new year
});

test('each week gets its dates, and a stock-up shares the week after it', () => {
  assert.deepEqual(PlanDates.weekRange(PLAN, 0), { from: '2026-11-23', to: '2026-11-29' });   // Stock-up 1
  assert.deepEqual(PlanDates.weekRange(PLAN, 1), { from: '2026-11-23', to: '2026-11-29' });   // Week 1
  assert.deepEqual(PlanDates.weekRange(PLAN, 3), { from: '2026-12-07', to: '2026-12-13' });   // Stock-up 2
  assert.deepEqual(PlanDates.weekRange(PLAN, 5), { from: '2026-12-14', to: '2026-12-20' });   // Week 4
  assert.equal(PlanDates.dayDate(PLAN, 2, 'Wed'), '2026-12-02');
  assert.equal(PlanDates.dayDate(PLAN, 2, 'Sunday'), '2026-12-06');
  assert.equal(PlanDates.end(PLAN), '2026-12-20');
  assert.equal(PlanDates.weekRange({ weeks: PLAN.weeks }, 1), null, 'no dates without a start date');
});

test('which week today is in, and before or after the plan', () => {
  assert.deepEqual(PlanDates.locate(PLAN, '2026-11-20'), { state: 'before', index: 1, day: 'Fri' });
  assert.deepEqual(PlanDates.locate(PLAN, '2026-11-23'), { state: 'during', index: 1, day: 'Mon' });
  assert.deepEqual(PlanDates.locate(PLAN, '2026-12-09'), { state: 'during', index: 4, day: 'Wed' });   // Week 3
  assert.deepEqual(PlanDates.locate(PLAN, '2026-12-20'), { state: 'during', index: 5, day: 'Sun' });
  assert.deepEqual(PlanDates.locate(PLAN, '2026-12-21'), { state: 'after', index: 5, day: 'Mon' });
  assert.equal(PlanDates.locate({ weeks: PLAN.weeks }, '2026-11-23'), null);
});
