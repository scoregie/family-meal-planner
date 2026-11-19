// "How the week went": one person's week (Monday to Sunday) next to the week before, for the card
// on Today and the full page (site/week.html, opened from Progress).
//
//   Went well          meals eaten, best-rated meals, exercise sessions done, cardio stepping up,
//                      new foods tried
//   Harder this week   meals they didn't have and why ("Didn't have it?" on the Meals tab), days
//                      short on vegetables or fruit, sessions missed, meals they scored low
//   To consider        one thing for next week, in the app's health wording: a consideration,
//                      reporting what they said, deferring to their GP, dietitian or physio
//
// Everything comes from what was ticked in the app (meal_log, exercise_log), plus a small dated
// log of cardio steps and small-step foods (remember(), below), because those records keep no dates.
// The working out itself is in weeksummary.js, shared with the phone app; this file gathers the
// records from the database and answers the request.
//
//   GET /api/week-review?person=...&week=last|this&tz=...   your own (admins: anyone's)

const db = require('./db');
const path = require('path');
const progress = require('./progress');
const rules = require('./sharedrules');
const HealthTargets = require('./healthtargets');
const WeekSummary = require('./weeksummary');   // the working out, shared with the phone app
const { send } = require('./requests');
const SkipReasons = require(path.join(path.dirname(process.env.PLAN_FILE || '/site/plan.json'), 'skipreasons.js'));

const LOG_KEEP = 200;   // newest events kept in each person's week log

// ---------------------------------------------------------------------------
// The dated log (cardio steps and small-step foods)
// ---------------------------------------------------------------------------

// Notes something worth showing in "How the week went": {kind: "cardio", moved, level} when cardio
// steps up or back, or {kind: "tried", food, result} when a small-step food is tried.
function remember(person, event) {
  try {
    const log = readLog(person);
    log.push(Object.assign({ at: Date.now() }, event));
    db.setSetting('week-log:' + person, JSON.stringify(log.slice(-LOG_KEEP)));
  } catch (e) { /* the log is a nice-to-have: the change itself is already saved */ }
}

// One person's dated log, oldest first.
function readLog(person) {
  try {
    const log = JSON.parse(db.getSetting('week-log:' + person) || '[]');
    return Array.isArray(log) ? log : [];
  } catch (e) {
    return [];
  }
}

// "How the week went" for one person: {person, which, today, week, before, consider}.
// `which` is "last" (the week just finished) or "this" (this week so far). The working out is in
// weeksummary.js, which the phone app uses too; this gathers the records it needs.
function review(person, which, tz, ctx) {
  const today = progress.localDate(Date.now(), tz);
  const span = WeekSummary.weekSpan(today, which);
  const plan = ctx.readPlan() || {};
  const profile = db.getProfile(person);
  return Object.assign({ person, which, today }, WeekSummary.summarise({
    today, which, plan,
    rows: db.mealsBetween(person, span.from, span.to),
    sessions: db.sessionsSince(person, span.from).filter(x => x.done_at <= span.to),
    log: readLog(person),
    planKey: rules.planKeyFor(plan, person),
    answers: (profile && profile.answers) || {},
    localDate: ms => progress.localDate(ms, tz),
    HealthTargets, SkipReasons,
  }));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// Answers GET /api/week-review. Returns true if it handled the request.
async function handle(req, res, urlPath, url, me, ctx) {
  if (urlPath !== '/api/week-review') return false;
  if (req.method !== 'GET') { send(res, 404, { error: 'not found' }); return true; }
  const person = String(url.searchParams.get('person') || me.person || '').toLowerCase();
  if (!ctx.people().includes(person)) { send(res, 404, { error: 'unknown person' }); return true; }
  if (!me.admin && person !== me.person) { send(res, 403, { error: 'you can only see your own week' }); return true; }
  const which = url.searchParams.get('week') === 'this' ? 'this' : 'last';
  send(res, 200, review(person, which, progress.zoneOrDefault(url.searchParams.get('tz')), ctx));
  return true;
}

module.exports = { handle, review, remember, considerNext: WeekSummary.considerNext, plannedSessions: WeekSummary.plannedSessions };
