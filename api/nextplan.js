// The next plan: a whole new plan approved on Plan setup to start on a Monday that hasn't come yet.
// It waits here (data/next-plan.json) while the current plan keeps going, and takes over on its
// start date (checked every minute, in the family's time zone). Until then an admin can start it
// straight away or cancel it on Plan setup.
//
//   GET    /api/plan/next/shopping   everyone: the waiting plan's first shopping lists (its stock-up
//                                     and Week 1), so the family can shop for it before it starts
//   DELETE /api/plan/next         admins: cancel the waiting plan (the current one carries on)
//   POST   /api/plan/next/start   admins: use the waiting plan now, instead of on its start date
//
// Ticks on those lists are saved with the shopping ticks under "n" and the week's place ("n1"), and
// move to the new plan's own weeks when it starts (see savePlan in server.js).
//
// Only one plan waits at a time: approving another future plan replaces it.
const fs = require('fs');
const path = require('path');
const { send } = require('./requests');

const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'next-plan.json');
const CHECK_EVERY = 60 * 1000;   // a minute

// The waiting plan: {plan, startDate, tz, approvedBy, approvedAt}, or null if there isn't one.
function get() {
  try {
    const next = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return next && next.plan && next.startDate ? next : null;
  } catch (e) {
    return null;
  }
}

// Saves a plan to start on `startDate` ("YYYY-MM-DD", a Monday), in time zone `tz` (may be undefined).
function wait(plan, startDate, tz, approvedBy) {
  const next = { plan, startDate, tz: tz || null, approvedBy: approvedBy || null, approvedAt: new Date().toISOString() };
  const temp = FILE + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(next, null, 1));
  fs.renameSync(temp, FILE);
  return next;
}

// Forgets the waiting plan.
function cancel() {
  try { fs.unlinkSync(FILE); } catch (e) { /* there wasn't one */ }
}

// Today's date where the family is: "2026-11-30". An unknown time zone uses the server's own.
function todayIn(tz) {
  const format = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  try { return format(tz || undefined); } catch (e) { return format(undefined); }   // en-CA writes YYYY-MM-DD
}

// True when `startDate` is after today (where the family is), so a plan starting then should wait.
function isLater(startDate, tz) {
  return String(startDate) > todayIn(tz);
}

// Puts the waiting plan in place of the current one (backing the current one up, as any new plan
// does). Returns true if there was one.
function use(savePlan) {
  const next = get();
  if (!next) return false;
  savePlan(next.plan);
  cancel();
  return true;
}

// Uses the waiting plan if its start date has come. `today` is for the tests.
function switchIfDue(savePlan, today) {
  const next = get();
  if (!next) return false;
  if ((today || todayIn(next.tz)) < next.startDate) return false;
  return use(savePlan);
}

// What Plan setup shows about the waiting plan: {startDate, title, approvedAt}, or null.
function summary() {
  const next = get();
  return next ? { startDate: next.startDate, title: next.plan.title || null, approvedAt: next.approvedAt } : null;
}

// The waiting plan's lists to shop before it starts: {startDate, first, weeks}. `weeks` runs from the
// start of the plan to its first week with meals (`first`, its place in `weeks`), each with just
// {name, kind, cost, shopping, useUp}. Null if no plan is waiting.
function shopping() {
  const next = get();
  if (!next || !Array.isArray(next.plan.weeks)) return null;
  const all = next.plan.weeks;
  let first = all.findIndex(w => w && w.kind !== 'stockup');
  if (first < 0) first = all.length - 1;
  const weeks = all.slice(0, first + 1).map(w => ({ name: w.name, kind: w.kind, cost: w.cost, shopping: w.shopping || {}, useUp: w.useUp }));
  return { startDate: next.startDate, currency: next.plan.currency || null, first, weeks };
}

// Starts the once-a-minute check (and checks once now, in case the server was off on the day).
function start(ctx) {
  const check = () => {
    try {
      if (switchIfDue(ctx.savePlan)) console.log('The next plan has started.');
    } catch (e) {
      console.log('Couldn’t start the next plan:', e.message);
    }
  };
  check();
  setInterval(check, CHECK_EVERY).unref();
}

// Answers /api/plan/next requests. Returns true if it handled one.
function handle(req, res, urlPath, me, ctx) {
  if (urlPath === '/api/plan/next/shopping' && req.method === 'GET') {
    send(res, 200, { next: shopping() });   // everyone shops, so everyone can see it
    return true;
  }
  if (urlPath !== '/api/plan/next' && urlPath !== '/api/plan/next/start') return false;
  if (!me.admin) send(res, 403, { error: 'Only an admin can change the plan.' });
  else if (req.headers['x-requested-with'] !== 'app') send(res, 403, { error: 'bad request' });
  else if (urlPath === '/api/plan/next' && req.method === 'DELETE') {
    cancel();
    ctx.dropNextTicks();   // ticks on its lists have nothing to go to now
    send(res, 200, { ok: true });
  } else if (urlPath === '/api/plan/next/start' && req.method === 'POST') {
    if (!use(ctx.savePlan)) send(res, 404, { error: 'There’s no plan waiting.' });
    else send(res, 200, { ok: true });
  } else send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { get, wait, cancel, isLater, switchIfDue, summary, shopping, start, handle };
