// "Remove from the family" and "Bring back" on the Family page (api/familyremove.js). Checks that
// removing someone takes them out of the plan and the records but keeps a copy, that bringing them
// back puts it all back, and that people with a login, an invite, or yourself can't be removed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('./helpers');

// This file loads familyremove.js itself too, so it gets its own empty data folder (never /data).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fhp-remove-'));
test.after(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
const familyRemove = require('../api/familyremove');

let server;
test.before(async () => { server = await startServer(); });
test.after(async () => { if (server) await server.stop(); });

const OWNER = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery' };

// Logs in as the owner (making the first account the first time).
async function asOwner() {
  server.forgetCookie();
  const status = await server.request('GET', '/auth/status');
  if (status.json.setup) assert.equal((await server.request('POST', '/auth/register', { ...OWNER, setupCode: server.setupCode() })).status, 200);
  else await server.request('POST', '/auth/login', new URLSearchParams({ username: OWNER.email, password: OWNER.password, next: '/' }));
}

test('taking someone out of a plan, and putting them back into the same plan', () => {
  const plan = {
    id: 'p1',
    people: { me: { name: 'Alex' }, kid: { name: 'Juno', portion: 0.7 } },
    exercise: { me: { workouts: [] }, kid: { workouts: ['Play'] } },
    weeks: [{ exercise: { me: { days: [] }, kid: { days: [{ day: 'Mon', cardio: 'Scooter' }] } },
      meals: [{ day: 'Mon', dinner: 'Stew', people: { kid: { dinner: 'Plain pasta' } } }, { day: 'Tue', dinner: 'Tacos' }] }],
  };
  const before = JSON.parse(JSON.stringify(plan));
  const taken = familyRemove.takeOutOfPlan(plan, 'kid');
  assert.deepEqual(Object.keys(plan.people), ['me']);
  assert.equal(plan.exercise.kid, undefined);
  assert.equal(plan.weeks[0].exercise.kid, undefined);
  assert.equal(plan.weeks[0].meals[0].people, undefined, 'an emptied "people" on a day is tidied away');

  familyRemove.putBackInPlan(plan, taken, true);
  assert.deepEqual(plan, before, 'the same plan comes back exactly');

  const other = { id: 'p2', people: { me: { name: 'Alex' } }, weeks: [{ meals: [{ day: 'Mon', dinner: 'Soup' }] }] };
  familyRemove.putBackInPlan(other, taken, false);
  assert.deepEqual(other.people.kid, { name: 'Juno', portion: 0.7 }, 'a newer plan gets their portion back');
  assert.equal(other.weeks[0].meals[0].people, undefined, 'but not the old plan’s meals');
});

test('remove someone without a login, then bring them back', async () => {
  await asOwner();
  assert.equal((await server.request('POST', '/api/family/person', { name: 'Juno', portion: 0.7 })).status, 200);
  const saved = await server.request('PUT', '/api/profile?person=juno', { answers: { age: '9', dislikes: 'Mushrooms' } });
  assert.equal(saved.status, 200, saved.text);
  const files = path.join(server.dir, 'data', 'uploads', 'juno', 'food-photos');
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(path.join(files, 'shelf.jpg'), 'photo');

  const removed = await server.request('POST', '/api/family/person/juno/remove', {});
  assert.equal(removed.status, 200, removed.text);
  const family = await server.request('GET', '/api/family');
  assert.ok(!family.json.people.some(p => p.person === 'juno'), 'out of the plan');
  assert.deepEqual(family.json.removed.map(r => r.name), ['Juno']);
  assert.ok(!fs.existsSync(path.join(server.dir, 'data', 'uploads', 'juno')), 'their files are put away');
  const archive = JSON.parse(fs.readFileSync(path.join(server.dir, 'data', 'archived-people', removed.json.id, 'archive.json'), 'utf8'));
  assert.equal(archive.rows.profiles.length, 1, 'the copy has their About me answers');

  const back = await server.request('POST', '/api/family/removed/' + removed.json.id + '/restore', {});
  assert.equal(back.status, 200, back.text);
  const after = await server.request('GET', '/api/family');
  assert.ok(after.json.people.some(p => p.person === 'juno'), 'back in the plan');
  assert.deepEqual(after.json.removed, [], 'the copy is cleared once they are back');
  const profile = await server.request('GET', '/api/profile?person=juno');
  assert.equal(profile.json.answers.dislikes, 'Mushrooms');
  assert.ok(fs.existsSync(path.join(files, 'shelf.jpg')), 'their files are back');
});

test('yourself, someone with an invite, and someone not in the plan can’t be removed', async () => {
  await asOwner();
  const me = await server.request('GET', '/api/account');
  const self = await server.request('POST', '/api/family/person/' + me.json.person + '/remove', {});
  assert.equal(self.status, 409, self.text);
  assert.match(self.json.error, /remove yourself/);

  assert.equal((await server.request('POST', '/api/family/invite', { name: 'Bo', role: 'member' })).status, 200);
  const invited = await server.request('POST', '/api/family/person/bo/remove', {});
  assert.equal(invited.status, 409);
  assert.match(invited.json.error, /invite waiting/);

  assert.equal((await server.request('POST', '/api/family/person/nobody/remove', {})).status, 404);
  assert.equal((await server.request('POST', '/api/family/removed/2026-01-01-nobody/restore', {})).status, 404);
});

test('only admins can remove people', async () => {
  server.forgetCookie();
  assert.notEqual((await server.request('POST', '/api/family/person/juno/remove', {})).status, 200);
});
