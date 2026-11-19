// Checks a few accessibility fixes in the pages' styles and scripts stay fixed: readable error
// toasts in dark mode, text boxes with visible edges, and no faded "At home" rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('./helpers');

// The text of a file in site/.
const site = (name) => fs.readFileSync(path.join(ROOT, 'site', name), 'utf8');
const pages = fs.readdirSync(path.join(ROOT, 'site')).filter(f => /\.(html|css)$/.test(f));

test('error toasts don’t put white text on the light red used in dark mode', () => {
  for (const f of pages) assert.doesNotMatch(site(f), /\.status\.err\{background:var\(--low\);color:#fff\}/, f);
});

test('text boxes don’t use the faint line colour for their border', () => {
  for (const f of pages) {
    for (const rule of site(f).match(/(input|select|textarea)[^{}"();\n]*\{[^}]*\}/g) || []) {
      assert.doesNotMatch(rule, /border:\d?px solid var\(--line\)/, f + ': ' + rule.slice(0, 80));
    }
  }
});

test('"At home" shopping rows aren’t faded, and Shop mode keeps focus inside it', () => {
  assert.doesNotMatch(site('index.html'), /li\.home \.row\{opacity/);
  assert.match(site('app-shopping.js'), /setAttribute\("inert"/);
  assert.match(site('index.html'), /id="err" role="alert"/);
});

test('pop-up messages stay on the page (so screen readers hear them) and errors don’t vanish on a timer', () => {
  for (const f of pages.filter(n => n.endsWith('.html'))) {
    const html = site(f);
    if (!/function status\(/.test(html) || !/id="status"/.test(html)) continue;
    assert.doesNotMatch(html, /id="status" role="status" hidden/, f + ': the message box is hidden until a message');
    const fn = html.slice(html.indexOf('function status('), html.indexOf('\n}', html.indexOf('function status(')));
    assert.doesNotMatch(fn, /hidden = true/, f);
    assert.match(fn, /if \(!isError\) status\.timer/, f + ': only non-errors go away by themselves');
  }
});

test('the eaten box and small pill buttons have a tap area of at least 44px', () => {
  const css = site('index.html');
  assert.match(css, /\.eathit\{[^}]*min-width:2\.75rem;min-height:2\.75rem/);
  assert.match(css, /\.rate-btn::after,\.swapbtn::after\{[^}]*height:2\.75rem/);
  assert.match(site('app-meals.js'), /el\("label", "eathit"\)/);
});
