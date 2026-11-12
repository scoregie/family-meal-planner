// Checks the Current food lists (api/currentfood.js) on their own, with a throwaway database:
// a kitchen list typed on Plan setup before the Current food page existed is sorted into
// pantry, fridge, freezer and other the first time it is read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The database goes in a temporary folder, set before the server's files are loaded.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhp-food-'));
process.env.DATA_DIR = dir;
const db = require('../api/db');
const food = require('../api/currentfood');

test.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

test('an older kitchen list is sorted into places once, then kept as it is', () => {
  assert.deepEqual(food.items(), [], 'nothing saved yet');

  db.setSetting('kitchen-list', JSON.stringify(['rice 2 kg', '6 eggs', 'frozen peas', 'dragon fruit']));
  assert.deepEqual(food.read(), { pantry: ['rice 2 kg'], fridge: ['6 eggs'], freezer: ['frozen peas'], other: ['dragon fruit'] });
  assert.deepEqual(food.lines(), ['Pantry: rice 2 kg', 'Fridge: 6 eggs', 'Freezer: frozen peas', 'Other: dragon fruit']);

  // It is saved in the new form, so a later change to the old list makes no difference.
  db.setSetting('kitchen-list', JSON.stringify(['milk']));
  assert.deepEqual(food.items().map(item => item.text), ['rice 2 kg', '6 eggs', 'frozen peas', 'dragon fruit']);
});
