// The food-group and macro estimators (tools/estimate_macros.py and tools/estimate_groups.py), which
// work out a plan's vegetable serves and macros from its recipes. Checks that an amount written in
// grams is read as grams (once, "60 g baby cos lettuce" was read as 60 whole lettuces, about 18 kg),
// and that cucumber, shredded cheese, sour cream and Mexican bean mix are recognised.
// The estimators are Python, so this skips itself where python3 isn't installed (like the local
// tools/test.sh container); GitHub's test run has it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { ROOT } = require('./helpers');

const hasPython = spawnSync('python3', ['--version']).status === 0;

// Asks the estimator how it reads each label: gives back [[food, grams], ...].
function read(items) {
  const code = 'import json, sys; sys.path.insert(0, sys.argv[1]); import estimate_macros as m; '
    + 'print(json.dumps([m.food_and_grams(i) for i in json.loads(sys.argv[2])]))';
  const run = spawnSync('python3', ['-c', code, path.join(ROOT, 'tools'), JSON.stringify(items)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('an amount in grams is grams, even for foods usually counted whole', { skip: !hasPython && 'python3 is not installed' }, () => {
  const got = read([
    { q: 60, l: 'g baby cos lettuce', i: 0 },
    { q: 1, l: 'cos lettuce', i: 1 },
    { q: 80, l: 'g cucumber, sliced', i: 0 },
    { q: 1, l: 'cucumber', i: 1 },
    { q: 40, l: 'g shredded cheese', i: 0 },
    { q: 30, l: 'g light sour cream', i: 0 },
    { q: 2, l: 'tomatoes, diced', i: 1 },
    { q: 1, l: '× 400 g can Mexican bean mix, drained', i: 1 },
  ]);
  assert.deepEqual(got, [
    ['cos lettuce', 60], ['cos lettuce', 300],
    ['cucumber', 80], ['cucumber', 300],
    ['tasty cheese', 40], ['sour cream', 30],
    ['tomato', 240],
    ['beans (drained)', 240],
  ]);
});
