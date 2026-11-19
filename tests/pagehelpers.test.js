// The small helpers every page uses ($, el, api, status, toLogin) live once, in site/page.js.
// These tests check every page loads it, no page keeps its own copy (copies drifted apart before:
// some sent a logged-out person to the login page and others showed an error), and that api()
// behaves the same for everyone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SITE = path.join(__dirname, '..', 'site');
const PAGES = fs.readdirSync(SITE).filter(f => f.endsWith('.html'));
const HELPERS = ['$', 'el', 'api', 'status', 'toLogin'];

// The order a page loads its scripts in: each script's file name, or "inline".
function scriptOrder(html) {
  return [...html.matchAll(/<script\b([^>]*)>/g)].map(m => (/src="([^"]+)"/.exec(m[1]) || [, 'inline'])[1]);
}

test('every page loads page.js before its own script', () => {
  for (const page of PAGES) {
    const order = scriptOrder(fs.readFileSync(path.join(SITE, page), 'utf8'));
    if (!order.includes('inline')) continue;
    assert.ok(order.includes('page.js'), page + ' loads page.js');
    assert.ok(order.indexOf('page.js') < order.indexOf('inline'), page + ' loads page.js first');
  }
  assert.match(fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8'), /"page\.js"/, 'kept for offline use');
});

test('no page or script keeps its own copy of the helpers', () => {
  const files = PAGES.concat(fs.readdirSync(SITE).filter(f => /^app-.*\.js$/.test(f)));
  for (const file of files) {
    const src = fs.readFileSync(path.join(SITE, file), 'utf8');
    for (const name of HELPERS) {
      const own = new RegExp('^\\s*function ' + name.replace('$', '\\$') + '\\s*\\(', 'm');
      assert.doesNotMatch(src, own, file + ' defines its own ' + name + '()');
    }
  }
});

// Runs page.js in a pretend page whose fetch() gives back `reply`. Returns the page's globals and
// the requests it made.
function pretendPage(reply, pathname) {
  const sent = [];
  const page = {
    location: { pathname: pathname || '/settings.html', search: '?x=1', hash: '#top', href: '' },
    fetch(url, request) {
      sent.push({ url, request });
      return Promise.resolve({ ok: reply.status < 400, status: reply.status, json: () => Promise.resolve(reply.body) });
    },
  };
  vm.createContext(page);
  vm.runInContext(fs.readFileSync(path.join(SITE, 'page.js'), 'utf8'), page);
  return { page, sent };
}

test('api() sends JSON with the app header, and gives back the answer', async () => {
  const { page, sent } = pretendPage({ status: 200, body: { ok: true } });
  assert.deepEqual(await page.api('PUT', '/api/x', { a: 1 }), { ok: true });
  assert.equal(sent[0].request.headers['X-Requested-With'], 'app');
  assert.equal(sent[0].request.headers['Content-Type'], 'application/json');
  assert.equal(sent[0].request.body, '{"a":1}');
  assert.equal(sent[0].request.keepalive, undefined);
  await page.api('DELETE', '/api/uploads/a', null, { from: 'files', keepalive: true });
  assert.equal(sent[1].request.headers['X-Requested-With'], 'files');
  assert.equal(sent[1].request.body, undefined);
  assert.equal(sent[1].request.keepalive, true);
});

test("api() throws the server's message with its status", async () => {
  const { page } = pretendPage({ status: 409, body: { error: 'Someone else changed it.' } });
  await assert.rejects(page.api('GET', '/api/x'), e => e.message === 'Someone else changed it.' && e.status === 409);
});

test('api() sends someone who was logged out to the login page, back to the same place', async () => {
  const { page } = pretendPage({ status: 401, body: { error: 'login needed' } });
  await assert.rejects(page.api('GET', '/api/x'), e => e.loginNeeded === true);
  assert.equal(page.location.href, '/login?next=' + encodeURIComponent('/settings.html?x=1#top'));
  // On the login page itself, a 401 is just a wrong password: it stays put.
  const login = pretendPage({ status: 401, body: { error: 'Wrong email or password.' } }, '/login');
  await assert.rejects(login.page.api('POST', '/auth/login', {}), e => e.message === 'Wrong email or password.');
  assert.equal(login.page.location.href, '');
});
