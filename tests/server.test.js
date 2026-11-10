// Starts a real copy of the server (in a temporary folder) and uses it the way the pages do:
// making the first account, logging in, About me, building a plan with the built-in builder,
// approving it, ticking things off, and the login safety checks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('./helpers');

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { if (server) await server.stop(); });

const OWNER = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery', country: 'nz' };

test('a new server asks for the first account, then refuses a second one', async () => {
  const status = await server.request('GET', '/auth/status');
  assert.equal(status.json.setup, true);

  const made = await server.request('POST', '/auth/register', OWNER);
  assert.equal(made.status, 200, made.text);

  const me = await server.request('GET', '/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.json.person, 'alex-smith');
  assert.equal(me.json.admin, true);

  const again = await server.request('POST', '/auth/register', { ...OWNER, email: 'someone@example.com' });
  assert.equal(again.status, 403);
});

test('the country chosen on the first-account form is saved', async () => {
  const look = await server.request('GET', '/api/appearance');
  assert.equal(look.json.country, 'nz');
});

test('pages and data need a login', async () => {
  server.forgetCookie();
  const data = await server.request('GET', '/api/state');
  assert.equal(data.status, 401);
  const page = await server.request('GET', '/auth/check', null, { 'X-Forwarded-Uri': '/index.html' });
  assert.equal(page.status, 302);
  assert.match(page.location, /^\/login\?next=/);
});

test('logging in works, and only sends people back to pages on this site', async () => {
  const form = next => new URLSearchParams({ username: OWNER.email, password: OWNER.password, next });
  for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil.example', '/\tevil']) {
    server.forgetCookie();
    const res = await server.request('POST', '/auth/login', form(bad));
    assert.equal(res.status, 303);
    assert.ok(res.location.startsWith('/') && !res.location.startsWith('//') && !/evil/.test(res.location), bad + ' went to ' + res.location);
  }
  const ok = await server.request('POST', '/auth/login', form('/progress.html'));
  assert.equal(ok.location, '/progress.html');
  assert.equal((await server.request('GET', '/auth/me')).status, 200);
});

test('About me answers are saved and read back', async () => {
  const answers = { age: '41', allergies: ['Peanuts'], diet: ['None'], injuries: 'Sore left knee' };
  const saved = await server.request('PUT', '/api/profile?person=alex-smith', { answers });
  assert.equal(saved.status, 200, saved.text);
  const read = await server.request('GET', '/api/profile?person=alex-smith');
  assert.deepEqual(read.json.answers.allergies, ['Peanuts']);
  assert.equal(read.json.answers.injuries, 'Sore left knee');
});

test('the built-in builder drafts a plan, and approving it makes it the plan', async () => {
  const draft = await server.request('POST', '/api/plan/draft', { how: 'builtin' });
  assert.equal(draft.status, 200, draft.text);

  const setup = await server.request('GET', '/api/plan/setup');
  assert.ok(setup.json.draft, 'a draft is waiting');
  // The preview shows how each person's vegetables and fruit measure up against their targets.
  const health = setup.json.draft.people[0].health;
  assert.ok(health && health.veg > 0 && health.target.veg >= 5, JSON.stringify(health));
  assert.deepEqual(health.short, []);
  const approve = await server.request('POST', '/api/requests/' + setup.json.draft.id + '/approve', {});
  assert.equal(approve.status, 200, approve.text);

  const plan = JSON.parse(fs.readFileSync(path.join(server.dir, 'site', 'plan.json'), 'utf8'));
  assert.equal(plan.currency, 'NZD', 'priced in the household’s country');
  assert.ok(plan.weeks.length >= 4);
  assert.ok(plan.people['alex-smith'] || Object.values(plan.people).some(p => p.name === 'Alex Smith'));
});

test('the instructions for an AI-written plan give each person’s vegetable and fruit targets', async () => {
  const handoff = await server.request('GET', '/api/plan/handoff');
  assert.equal(handoff.status, 200, handoff.text);
  assert.match(handoff.json.user, /target at least \d(\.5)? serves of vegetables and \d(\.5)? of fruit a day/);
  assert.match(handoff.json.system, /order of importance/);
});

test('a tick on the shopping list is saved for everyone', async () => {
  const put = await server.request('PUT', '/api/shared', { ticks: { 0: ['milk'] } });
  assert.equal(put.status, 200, put.text);
  const state = await server.request('GET', '/api/state');
  assert.deepEqual(state.json.shared.ticks['0'], ['milk']);
});

test('changes without the pages’ X-Requested-With header are refused (so other websites can’t make them)', async () => {
  const res = await server.request('PUT', '/api/appearance/energy', { energy: 'kcal' }, { 'X-Requested-With': '' });
  assert.equal(res.status, 403);
});

test('a plan that is the wrong shape is refused', async () => {
  const res = await server.request('PUT', '/api/plan', { plan: { weeks: [{ shopping: { Fruit: [['Apples', 'cheap']] } }] } });
  assert.equal(res.status, 400);
});

test('after 10 wrong passwords, logins from that address are paused', async () => {
  server.forgetCookie();
  const wrong = new URLSearchParams({ username: OWNER.email, password: 'not it', next: '/' });
  for (let i = 0; i < 10; i++) {
    const res = await server.request('POST', '/auth/login', wrong);
    assert.match(res.location, /e=1/);
  }
  const right = new URLSearchParams({ username: OWNER.email, password: OWNER.password, next: '/' });
  const locked = await server.request('POST', '/auth/login', right);
  assert.match(locked.location, /e=locked/, 'even the right password waits');
});
