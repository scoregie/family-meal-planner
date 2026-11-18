// Checks the "watch how" links on exercises (site/app-exercise.js): every workout item that
// matches a library exercise gets a YouTube search link, and a chosen demo video gets a Demo link.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { ROOT } = require('./helpers');

// Loads site/app-exercise.js with a pretend page, and the library given as `exercises`.
function loadExercise(exercises) {
  // A pretend element that keeps its children, text and attributes.
  const el = (tag, cls, text) => ({
    tag, className: cls, textContent: text || '', children: [], attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
  });
  const context = {
    el, document: { createTextNode: t => ({ text: t }) }, PLAN: { exercise: {} },
    isAdmin: () => false, ukey: s => String(s).toLowerCase(), console,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'site', 'app-exercise.js'), 'utf8'), context);
  vm.runInContext('EXLIB = ' + JSON.stringify({ exercises, fits: [], avoid: [], person: 'a' }), context);
  return context;
}

// The links inside a list item, as [text, href].
const linksIn = item => item.children.filter(c => c.tag === 'a').map(a => [a.textContent, a.href]);

test('a workout item that matches a library exercise gets a YouTube link, and a demo video gets a Demo link', () => {
  const page = loadExercise([
    { id: 'sit-to-stand', name: 'Sit to stand', type: 'squat', equipment: 'none', level: 1, dose: '3 × 10', how: '', flags: [] },
    { id: 'wall-push-up', name: 'Wall push-up', type: 'push', equipment: 'none', level: 1, dose: '3 × 10', how: '', flags: [], video: 'https://example.com/wall-push-up' },
  ]);
  const fold = page.workoutFold({ name: 'Day A', items: ['Sit to stand (3 × 10): slowly', 'Wall push-up (3 × 10): arms straight', 'Rest: 2 minutes'] }, {});
  const items = fold.children.find(c => c.tag === 'ol').children;
  const first = linksIn(items[0]);
  assert.equal(first.length, 1);
  assert.equal(first[0][0], 'YouTube');
  assert.match(first[0][1], /^https:\/\/www\.youtube\.com\/results\?search_query=Sit%20to%20stand/);
  assert.deepEqual(linksIn(items[1]).map(l => l[0]), ['Demo', 'YouTube']);
  assert.equal(linksIn(items[1])[0][1], 'https://example.com/wall-push-up');
  // "Rest" isn't an exercise, so it gets no links.
  assert.deepEqual(linksIn(items[2]), []);
});

test('a plan’s own demo link wins, and a link that isn’t https is left out', () => {
  const page = loadExercise([]);
  const fold = page.workoutFold({ name: 'Day A', items: ['Goblet squat (3 × 10): hold the weight close'] }, { 'Goblet squat': 'javascript:alert(1)' });
  const links = linksIn(fold.children.find(c => c.tag === 'ol').children[0]);
  assert.deepEqual(links.map(l => l[0]), ['YouTube']);
});
