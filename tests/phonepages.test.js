// The pages shared with the phone app (docs/how-it-works.md, "Pages shared with the phone app"):
// each loads local-api.js and then edition.js before any other script, and edition.js switches a
// page to the phone's wording when window.PHONE is set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SITE = path.join(__dirname, '..', 'site');
const SHARED = ['index.html', 'profile.html', 'progress.html', 'settings.html', 'setup.html', 'exercises.html', 'food.html'];

test('each shared page loads local-api.js, then edition.js, before any other script', () => {
  for (const page of SHARED) {
    const html = fs.readFileSync(path.join(SITE, page), 'utf8');
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map(m => (/src="([^"]+)"/.exec(m[1]) || [, 'inline'])[1]);
    assert.deepEqual(scripts.slice(0, 2), ['local-api.js', 'edition.js'], page);
  }
  assert.match(fs.readFileSync(path.join(SITE, 'local-api.js'), 'utf8'), /window\.PHONE = null;/);
});

// Runs edition.js on a pretend page with one data-phone element. Returns the page.
function runEdition(phone) {
  const classes = new Set();
  const swapped = { textContent: 'web words', getAttribute: () => 'phone words' };
  const head = [];
  const document = {
    readyState: 'complete',
    documentElement: { classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } },
    createElement: () => ({}),
    head: { appendChild: el => head.push(el) },
    querySelectorAll: sel => (sel === '[data-phone]' ? [swapped] : []),
  };
  vm.runInNewContext(fs.readFileSync(path.join(SITE, 'edition.js'), 'utf8'), { window: { PHONE: phone }, document });
  return { classes, swapped, style: head[0] && head[0].textContent };
}

test('edition.js: the web hides phone-only parts; the phone hides web-only parts and swaps the words', () => {
  const web = runEdition(null);
  assert.equal(web.classes.has('phone'), false);
  assert.equal(web.swapped.textContent, 'web words');
  assert.match(web.style, /html\.phone \[data-web-only\]/);
  assert.match(web.style, /html:not\(\.phone\) \[data-phone-only\]/);
  const phone = runEdition({ app: true });
  assert.equal(phone.classes.has('phone'), true);
  assert.equal(phone.swapped.textContent, 'phone words');
});

test('questions marked webOnly or with phone wording are well formed', () => {
  const q = JSON.parse(fs.readFileSync(path.join(SITE, 'questions.json'), 'utf8'));
  assert.equal(typeof q.introPhone, 'string');
  const all = q.sections.flatMap(s => s.questions);
  assert.ok(all.find(x => x.id === 'share_results').webOnly, 'blood test sharing is web-only');
  for (const x of all) {
    if (x.helpPhone) assert.ok(x.help && !/admin/i.test(x.helpPhone), x.id);
    if ('webOnly' in x) assert.equal(x.webOnly, true, x.id);
  }
});
