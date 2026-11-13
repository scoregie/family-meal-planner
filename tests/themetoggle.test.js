// Checks the light or dark button that site/appearance.js adds to the top of every page:
// it is put in the top row, a tap swaps the look, and the choice is remembered on the device.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers');

// Loads site/appearance.js in a small pretend browser. `deviceDark` says whether the pretend
// device is set to dark. Gives back the pieces the tests look at.
function loadPage(deviceDark) {
  const noop = () => {};
  const saved = {};       // the pretend browser storage
  const attributes = {};  // what is set on the page's <html> element, like data-theme
  // A pretend element that remembers its attributes and the functions listening to it.
  const element = () => ({
    style: {}, attrs: {}, listeners: {}, children: [],
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    appendChild: noop,
    querySelector: () => null,
  });
  const topRow = element();
  topRow.insertBefore = (child) => { topRow.added = child; };
  const window = {
    addEventListener: noop,
    dispatchEvent: noop,
    Event: function () {},
    matchMedia: () => ({ matches: deviceDark, addEventListener: noop }),
    localStorage: {
      getItem: (key) => (key in saved ? saved[key] : null),
      setItem: (key, value) => { saved[key] = value; },
    },
    location: { pathname: '/settings.html' },
    fetch: () => new Promise(noop),
  };
  window.document = {
    documentElement: {
      setAttribute: (name, value) => { attributes[name] = value; },
      removeAttribute: (name) => { delete attributes[name]; },
    },
    head: element(),
    body: element(),
    getElementById: () => null,
    createElement: element,
    querySelector: (selector) => (selector === '.top' ? topRow : null),
    querySelectorAll: () => [],
    addEventListener: noop,
    readyState: 'complete',
  };
  window.window = window;
  vm.createContext(window);
  for (const file of ['regions.js', 'appearance.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', file), 'utf8'), window, { filename: file });
  }
  return { button: topRow.added, attributes, saved, Appearance: window.Appearance };
}

test('the light or dark button is added to the top row and offers dark on a light page', () => {
  const page = loadPage(false);
  assert.ok(page.button, 'the button was put in the top row');
  assert.equal(page.button.attrs['aria-label'], 'Switch to dark mode');
});

test('tapping the button swaps to dark, then back to light, and remembers it', () => {
  const page = loadPage(false);
  page.button.listeners.click();
  assert.equal(page.attributes['data-theme'], 'dark');
  assert.equal(JSON.parse(page.saved['appearance-mine']).theme, 'dark');
  assert.equal(page.button.attrs['aria-label'], 'Switch to light mode');
  page.button.listeners.click();
  assert.equal(page.attributes['data-theme'], 'light');
  assert.equal(JSON.parse(page.saved['appearance-mine']).theme, 'light');
});

test('on a device set to dark, the first tap goes to light', () => {
  const page = loadPage(true);
  assert.equal(page.button.attrs['aria-label'], 'Switch to light mode');
  page.button.listeners.click();
  assert.equal(page.attributes['data-theme'], 'light');
});

test('the button keeps a colour chosen on this device, and follows a choice made in Settings', () => {
  const page = loadPage(false);
  page.Appearance.setMine({ colour: 'blue', theme: 'dark' });
  assert.equal(page.button.attrs['aria-label'], 'Switch to light mode');
  page.button.listeners.click();
  assert.deepEqual(JSON.parse(page.saved['appearance-mine']), { colour: 'blue', theme: 'light' });
});
