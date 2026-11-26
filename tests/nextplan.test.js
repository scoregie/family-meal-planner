// Checks the next plan: a new plan approved to start on a Monday still to come waits, and the
// current plan carries on until that date. Then it takes over by itself, or straight away with
// "Start it now", or not at all with "Cancel it". Its first lists can be shopped (and ticked)
// before it starts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./helpers');

const OWNER = { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery' };
const LATER = '2099-01-05';   // a Monday a long way off

// Starts a server with one person, makes a built-in draft, and returns {server, draftId}.
async function withDraft() {
  const server = await startServer();
  assert.equal((await server.request('POST', '/auth/register', { ...OWNER, setupCode: server.setupCode() })).status, 200);
  await server.request('PUT', '/api/profile?person=alex-smith', { answers: { age: '41' } });
  const draft = await server.request('POST', '/api/plan/draft', { how: 'builtin' });
  assert.equal(draft.status, 200, draft.text);
  return { server, draftId: (await server.request('GET', '/api/plan/setup')).json.draft.id };
}

// The plan the site is showing now.
const livePlan = server => JSON.parse(fs.readFileSync(path.join(server.dir, 'site', 'plan.json'), 'utf8'));

test('a plan starting on a later Monday waits, and the current plan carries on', async () => {
  const { server, draftId } = await withDraft();
  try {
    const before = livePlan(server);
    const approve = await server.request('POST', '/api/requests/' + draftId + '/approve', { startDate: LATER, tz: 'Australia/Adelaide' });
    assert.equal(approve.status, 200, approve.text);
    assert.equal(livePlan(server).id, before.id, 'the current plan is unchanged');
    const setup = (await server.request('GET', '/api/plan/setup')).json;
    assert.equal(setup.next.startDate, LATER);
    assert.equal(setup.draft, null, 'the draft is no longer waiting for approval');

    // Its first lists can be shopped now: the stock-up and Week 1, but no later weeks.
    const shop = (await server.request('GET', '/api/plan/next/shopping')).json.next;
    assert.equal(shop.startDate, LATER);
    assert.equal(shop.weeks[shop.first].name, 'Week 1');
    assert.ok(shop.weeks.length === shop.first + 1 && Object.keys(shop.weeks[shop.first].shopping).length);
    // Ticks on this plan's list and the next plan's are saved side by side.
    const ticked = await server.request('PUT', '/api/shared', { ticks: { 0: ['0-0'], ['n' + shop.first]: ['0-0', '0-1'] } });
    assert.equal(ticked.status, 200, ticked.text);

    // "Start it now" swaps it in, with its start date.
    const started = await server.request('POST', '/api/plan/next/start', {});
    assert.equal(started.status, 200, started.text);
    assert.notEqual(livePlan(server).id, before.id);
    assert.equal(livePlan(server).startDate, LATER);
    // What was ticked on its list stays ticked, now under its own week; the old plan's ticks are gone.
    const state = (await server.request('GET', '/api/state')).json;
    assert.deepEqual(state.shared.ticks, { [shop.first]: ['0-0', '0-1'] });
    assert.equal((await server.request('GET', '/api/plan/setup')).json.next, null);
    assert.equal((await server.request('POST', '/api/plan/next/start', {})).status, 404, 'nothing left to start');
  } finally {
    await server.stop();
  }
});

test('a waiting plan can be cancelled, and a start date already here is used straight away', async () => {
  const { server, draftId } = await withDraft();
  try {
    const before = livePlan(server);
    await server.request('POST', '/api/requests/' + draftId + '/approve', { startDate: LATER });
    await server.request('PUT', '/api/shared', { ticks: { 0: ['0-0'], n1: ['0-0'] } });
    const cancel = await server.request('DELETE', '/api/plan/next', null, { 'X-Requested-With': 'app' });
    assert.equal(cancel.status, 200, cancel.text);
    assert.equal((await server.request('GET', '/api/plan/setup')).json.next, null);
    assert.equal(livePlan(server).id, before.id, 'the current plan carries on');
    assert.deepEqual((await server.request('GET', '/api/state')).json.shared.ticks, { 0: ['0-0'] }, 'only the next plan’s ticks go');
  } finally {
    await server.stop();
  }
});

test('the waiting plan takes over on its start date, not before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhp-next-'));
  const old = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  delete require.cache[require.resolve('../api/nextplan')];
  const nextplan = require('../api/nextplan');
  process.env.DATA_DIR = old;
  try {
    const saved = [];
    nextplan.wait({ id: 'new', weeks: [] }, '2026-11-30', 'Australia/Adelaide', 'owner');
    assert.equal(nextplan.switchIfDue(p => saved.push(p), '2026-11-29'), false, 'Sunday: still waiting');
    assert.equal(saved.length, 0);
    assert.equal(nextplan.switchIfDue(p => saved.push(p), '2026-11-30'), true, 'Monday: it starts');
    assert.deepEqual(saved.map(p => p.id), ['new']);
    assert.equal(nextplan.get(), null, 'and stops waiting');
    assert.equal(nextplan.isLater('2026-11-30', 'Australia/Adelaide'), '2026-11-30' > new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Adelaide' }).format(new Date()));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
