// Checks that one person's data can't reach someone else through the Family page: a sign-up
// with the name of someone already in the family (like a child with no login) is refused, and
// removing someone's login stops their Health sync key working.

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { if (server) await server.stop(); });

const OWNER = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery' };

// Logs in as the owner (making the first account the first time).
async function asOwner() {
  server.forgetCookie();
  const status = await server.request('GET', '/auth/status');
  if (status.json.setup) assert.equal((await server.request('POST', '/auth/register', OWNER)).status, 200);
  else await server.request('POST', '/auth/login', new URLSearchParams({ username: OWNER.email, password: OWNER.password, next: '/' }));
}

test('a sign-up with the name of someone already in the family without a login is refused', async () => {
  await asOwner();
  assert.equal((await server.request('POST', '/api/family/person', { name: 'Quinn Zed' })).status, 200);

  server.forgetCookie();
  const signed = await server.request('POST', '/auth/signup', { name: 'Quinn Zed', email: 'stranger@example.com', password: 'a long enough password' });
  assert.equal(signed.status, 200, signed.text);

  await asOwner();
  const family = await server.request('GET', '/api/family');
  const signup = family.json.signups.find(s => s.email === 'stranger@example.com');
  assert.ok(signup, 'the sign-up is waiting');
  const approved = await server.request('POST', '/api/family/signup/' + signup.id, { action: 'approve', role: 'member' });
  assert.equal(approved.status, 409);
  assert.match(approved.json.error, /already in the family/);
  const after = await server.request('GET', '/api/family');
  assert.ok(!after.json.accounts.some(a => a.email === 'stranger@example.com'), 'no login was made for Quinn');
});

test('removing someone’s login stops their Health sync key working', async () => {
  await asOwner();
  const invited = await server.request('POST', '/api/family/invite', { name: 'Bo', role: 'member' });
  assert.equal(invited.status, 200, invited.text);
  const t = new URL(invited.json.path, 'http://x').searchParams.get('join');

  server.forgetCookie();
  const joined = await server.request('POST', '/auth/join', { t, email: 'bo@example.com', password: 'another long password' });
  assert.equal(joined.status, 200, joined.text);
  const made = await server.request('POST', '/api/health/key', {});
  assert.equal(made.status, 200, made.text);
  const key = made.json.key;
  // An empty sync with a good key is accepted (nothing to save), so the key works now.
  const before = await fetch(server.url + '/auth/health-sync', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' });
  assert.notEqual(before.status, 401);

  await asOwner();
  const family = await server.request('GET', '/api/family');
  const bo = family.json.accounts.find(a => a.email === 'bo@example.com');
  assert.equal((await server.request('DELETE', '/api/family/member/' + bo.id, null, { 'X-Requested-With': 'app' })).status, 200);
  const afterRemove = await fetch(server.url + '/auth/health-sync', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(afterRemove.status, 401);
});
