// Checks how the plan builder reads how much is left of a Current food item ("three quarter full").

const test = require('node:test');
const assert = require('node:assert/strict');

test('a Current food item "three quarter full" counts as three quarters of a pack, not a quarter', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'planbuilder.js'), 'utf8');
  const words = eval(src.match(/const PART_WORDS = (\[[\s\S]*?\]\]);/)[1]);
  assert.equal(words.find(([w]) => w.test('milk 2 l, three quarter full'))[1], 0.75);
  assert.equal(words.find(([w]) => w.test('a quarter left'))[1], 0.25);
});
