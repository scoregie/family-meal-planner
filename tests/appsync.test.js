// Checks how the main app keeps ticks and ratings on the device (site/app-core.js): changes that
// haven't reached the server aren't overwritten by the server's older copy, and "Reset all"
// forgets everyone's ratings on the device, not just the person shown.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers');

// Loads site/app-core.js with a pretend browser whose storage is `store`.
function loadCore(store) {
  const localStorage = {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
  const element = () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, setAttribute() {}, addEventListener() {}, appendChild() {} });
  const context = {
    Appearance: { personKey: n => String(n).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-'), money: n => String(n) },
    localStorage, console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0,
    location: { hash: '', pathname: '/', search: '' }, navigator: {},
    document: { getElementById: element, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: element, documentElement: element(), body: element() },
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
  };
  context.window.localStorage = localStorage;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', 'app-core.js'), 'utf8'), context);
  return context;
}

test('a person’s unsent changes win over the server’s older copy', () => {
  const page = loadCore({});
  vm.runInContext('USER = "Riley"; exTicks = { 1: ["a"] }; markSent(ukey(USER), false);', page);
  const found = { changed: false, needPush: false };
  vm.runInContext('takeMine', page)({ users: { riley: { ex: {}, eaten: {}, ratings: {} } } }, found);
  assert.equal(found.needPush, true);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('exTicks', page))), { 1: ['a'] });
  // Once sent, the server's copy is taken again.
  vm.runInContext('markSent("riley", true)', page);
  const again = { changed: false, needPush: false };
  vm.runInContext('takeMine', page)({ users: { riley: { ex: {}, eaten: {}, ratings: {} } } }, again);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('exTicks', page))), {});
});

test('Reset all forgets everyone’s ratings on this device', () => {
  const store = { 'coles-plan-rates-v1-plan1-riley': '{"1":{}}', 'coles-plan-rates-v1-plan1-sam': '{"1":{}}', 'coles-plan-unsent': '{"sam":true}' };
  const page = loadCore(store);
  vm.runInContext('PLAN = { id: "plan1" }; USERS = ["Riley", "Sam"]; rates = { 1: { "Mon|Dinner": { s: 7 } } };', page);
  vm.runInContext('forgetEveryoneHere()', page);
  assert.deepEqual(Object.keys(store), []);
  assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('rates', page))), {});
});
