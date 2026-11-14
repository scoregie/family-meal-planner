// Checks the main app page's script files: every file index.html loads is there, is saved for
// offline use by sw.js, and is valid JavaScript. (The page's script is split across app-*.js.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const site = path.join(__dirname, '..', 'site');

// The file names index.html loads with <script src="...">, in order.
function scriptsOnPage() {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  return Array.from(html.matchAll(/<script src="([^"]+)"/g), m => m[1]);
}

test('every script the main page loads exists and is valid JavaScript', () => {
  const scripts = scriptsOnPage();
  assert.ok(scripts.includes('app-core.js') && scripts.includes('app-start.js'));
  for (const name of scripts) {
    const code = fs.readFileSync(path.join(site, name), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code, { filename: name }), name);
  }
});

test('every script the main page loads is saved for offline use', () => {
  const sw = fs.readFileSync(path.join(site, 'sw.js'), 'utf8');
  for (const name of scriptsOnPage()) assert.ok(sw.includes('"' + name + '"'), name + ' is missing from sw.js');
});

test('app-start.js, which starts the page, is loaded after the other parts', () => {
  const scripts = scriptsOnPage().filter(name => name.startsWith('app-'));
  assert.strictEqual(scripts[0], 'app-core.js');
  assert.strictEqual(scripts[scripts.length - 1], 'app-start.js');
});

test('More has Apple Health sync and calendar reminders, so they are easy to find', () => {
  const html = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  const more = html.slice(html.indexOf('id="moreView"'), html.indexOf('id="adminGroup"'));
  assert.ok(more.includes('href="health-sync.html"'), 'More has no link to Apple Health sync');
  assert.ok(more.includes('id="moreCal"'), 'More has no calendar reminders box');
  const start = fs.readFileSync(path.join(site, 'app-start.js'), 'utf8');
  assert.ok(start.includes('moreCalendar()'), 'opening More does not fill the calendar reminders box');
});
