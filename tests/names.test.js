// Checks people's keys: the server (api/names.js) and the browser (site/appearance.js) must turn
// every name into the same key, or someone's ticks and answers would be saved in two places.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { toKey } = require('../api/names');
const { ROOT } = require('./helpers');

// Loads site/appearance.js as a browser would, with just enough of a pretend browser around it.
function browserPersonKey() {
  const noop = () => {};
  // A pretend page element: any method called on it does nothing.
  const fakeElement = () => new Proxy({ style: {}, dataset: {}, classList: { add: noop, remove: noop, toggle: noop } }, {
    get: (target, prop) => (prop in target ? target[prop] : noop),
  });
  const window = {
    addEventListener: noop,
    dispatchEvent: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: { language: 'en-AU' },
    location: { pathname: '/index.html', href: 'http://localhost/index.html', origin: 'http://localhost' },
    fetch: () => new Promise(noop),
    CustomEvent: function () {},
  };
  window.document = {
    documentElement: fakeElement(),
    head: fakeElement(),
    body: fakeElement(),
    getElementById: () => null,
    createElement: () => fakeElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    readyState: 'complete',
  };
  window.window = window;
  vm.createContext(window);
  for (const file of ['regions.js', 'appearance.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', file), 'utf8'), window, { filename: file });
  }
  return window.Appearance.personKey;
}

test('simple names become lower-case keys with dashes', () => {
  assert.equal(toKey('Alex Smith'), 'alex-smith');
  assert.equal(toKey('  Sam  '), '-sam-');
  assert.equal(toKey('Émile'), '-mile');   // existing keys stay as they were in earlier versions
});

test('names with no a-z letters get a "p-" code that is the same every time', () => {
  const yuki = toKey('ゆき');
  assert.match(yuki, /^p-[0-9a-f]{8}$/);
  assert.equal(toKey('ゆき'), yuki);
  assert.notEqual(toKey('민준'), yuki);
});

test('the browser and the server agree on every key', () => {
  const personKey = browserPersonKey();
  for (const name of ['Alex Smith', 'Émile', 'ゆき', '민준', 'Zoë-Jane O’Brien', '李华', '  Sam  ', 'Ana 2', '', '🙂']) {
    assert.equal(personKey(name), toKey(name), 'for the name ' + JSON.stringify(name));
  }
});
