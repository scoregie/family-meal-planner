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
//
//   GET /api/week-review?person=...&week=last|this&tz=...   your own (admins: anyone's)

const db = require('./db');
const path = require('path');
const progress = require('./progress');
const rules = require('./sharedrules');
const HealthTargets = require('./healthtargets');
const { send } = require('./requests');
const SkipReasons = require(path.join(path.dirname(process.env.PLAN_FILE || '/site/plan.json'), 'skipreasons.js'));

const DAY = 24 * 60 * 60 * 1000;
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

// ---------------------------------------------------------------------------
// Working out one week
// ---------------------------------------------------------------------------

// The plan's exercise sessions for one person in one plan week (not optional ones, not rest days).
function plannedSessions(plan, weekIndex, planKey) {
  const week = plan && plan.weeks && plan.weeks[weekIndex];
  const mine = week && week.exercise && planKey && week.exercise[planKey];
  if (!mine || !Array.isArray(mine.days)) return 0;
  let n = 0;
  for (const day of mine.days) {
    for (const k of Object.keys(day || {})) {
      if (k !== 'day' && typeof day[k] === 'string' && day[k].trim() && !/^(optional|rest)/i.test(day[k])) n++;
    }
  }
  return n;
}

// Which meal week (1 to 4) a plan week is, for someone building up their vegetables.
function mealWeekNumber(plan, weekIndex) {
  let n = 0;
  for (let i = 0; i <= weekIndex && i < plan.weeks.length; i++) if (Array.isArray(plan.weeks[i].meals)) n++;
  return Math.max(1, n);
}

// The days that came in under the vegetable or fruit target: {veg: [days], fruit: [days], counted}.
// Days are the plan's days (Monday's meals count for Monday even when ticked on Thursday). A day
// counts once two or more of its meals were ticked; it adds the ticked meals (by the person's
// portion) and that day's planned snacks and sides from the plan's food groups.
function shortDays(eatenRows, plan, planKey, answers) {
  const out = { veg: [], fruit: [], counted: 0 };
  if (!plan || !Array.isArray(plan.weeks) || !plan.groups || HealthTargets.paceFor(answers) === 'own') return out;
  const person = (plan.people || {})[planKey] || {};
  const portion = Number(person.portion) || 1;
  const groups = {};
  for (const name of Object.keys(plan.groups)) groups[HealthTargets.nameKey(name)] = plan.groups[name];
  const byDay = new Map();
  for (const r of eatenRows) {
    if (String(r.plan_id) !== String(plan.id || 'default') || !plan.weeks[r.week]) continue;
    const day = r.week + '|' + r.day;   // the plan's week and day
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  for (const [day, rows] of byDay) {
    if (rows.length < 2) continue;
    out.counted++;
    let veg = 0, fruit = 0;
    for (const r of rows) {
      const g = groups[HealthTargets.nameKey(r.dish)];
      if (g) { veg += (g.veg || 0) * portion; fruit += (g.fruit || 0) * portion; }
    }
    const week = plan.weeks[rows[0].week];
    const meal = (week.meals || []).find(m => String(m.day || '').slice(0, 3) === rows[0].day);
    if (meal) {
      for (const s of HealthTargets.eatenOn(week, meal, person, planKey, mealWeekNumber(plan, rows[0].week))) {
        const g = s.snack && groups[HealthTargets.nameKey(s.name)];
        if (g) { veg += g.veg || 0; fruit += g.fruit || 0; }
      }
    }
    const target = HealthTargets.weekTarget(answers, mealWeekNumber(plan, rows[0].week));
    if (!target) continue;
    if (veg < target.veg - HealthTargets.CLOSE) out.veg.push(day);
    if (fruit < target.fruit - HealthTargets.CLOSE) out.fruit.push(day);
  }
  return out;
}

// The most common value in a list, or null.
function mostCommon(list) {
  const counts = new Map();
  for (const x of list) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null, n = 0;
  for (const [x, c] of counts) if (c > n) { best = x; n = c; }
  return best;
}

// Foods tried, once each with the newest answer ("tried" then "liked" shows as liked): [{food, result}].
function newestPerFood(events) {
  const byFood = new Map();
  for (const e of events) byFood.set(String(e.food).toLowerCase(), { food: e.food, result: e.result });
  return [...byFood.values()];
}

// Everything about one week (`monday` to the Sunday after) for one person.
function oneWeek(person, monday, tz, plan, answers) {
  const sunday = progress.addDays(monday, 6);
  const inWeek = ms => { const d = progress.localDate(ms, tz); return d >= monday && d <= sunday; };
  // Read a day either side, so a time zone can't push something out; then keep this week's.
  const from = new Date(monday + 'T00:00:00Z').getTime() - DAY;
  const to = new Date(sunday + 'T00:00:00Z').getTime() + 2 * DAY;
  const rows = db.mealsBetween(person, from, to);
  const eaten = rows.filter(r => r.eaten && inWeek(r.eaten_at));
  const skipped = rows.filter(r => !r.eaten && r.skip_reason && inWeek(r.updated_at));
  const scored = rows.filter(r => r.score != null && inWeek(r.updated_at) && r.dish);
  const sessions = db.sessionsSince(person, from).filter(s => s.done_at <= to && inWeek(s.done_at));

  const planKey = rules.planKeyFor(plan, person);
  const thisPlan = r => String(r.plan_id) === String((plan && plan.id) || 'default');
  const planWeek = mostCommon(rows.filter(thisPlan).map(r => r.week));
  const planned = plan && planWeek != null ? plannedSessions(plan, planWeek, planKey) : 0;

  const reasons = {};
  for (const r of skipped) reasons[r.skip_reason] = (reasons[r.skip_reason] || 0) + 1;
  const log = readLog(person).filter(e => e && inWeek(e.at));
  const short = shortDays(eaten, plan, planKey, answers);
  return {
    monday, sunday,
    meals: eaten.length,
    best: scored.filter(r => r.score >= 8).sort((a, b) => b.score - a.score).slice(0, 3).map(r => ({ dish: r.dish, score: r.score })),
    low: scored.filter(r => r.score <= 4).sort((a, b) => a.score - b.score).slice(0, 3).map(r => ({ dish: r.dish, score: r.score })),
    sessions: sessions.length,
    planned,
    cardio: log.filter(e => e.kind === 'cardio' && e.moved).map(e => ({ moved: e.moved, level: e.level })),
    tried: newestPerFood(log.filter(e => e.kind === 'tried' && (e.result === 'tried' || e.result === 'liked'))),
    skipped: skipped.length,
    skippedMeals: skipped.slice(0, 10).map(r => ({ dish: r.dish, day: r.day, slot: r.slot, reason: SkipReasons.label(r.skip_reason) })),
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, label: SkipReasons.label(key), n })),
    shortVeg: short.veg.length,
    shortFruit: short.fruit.length,
    daysCounted: short.counted,
  };
}

// One thing to consider next week, from what happened. Wording follows the app's rules for health
// text: "consider", no absolutes, report what they said, and leave health calls to their GP,
// dietitian or physio.
function considerNext(w, name) {
  const said = key => (w.reasons.find(r => r.key === key) || { n: 0 }).n;
  const you = name ? name + ' said' : 'You said';
  const rushed = said('time') + said('effort');
  if (rushed >= 2) {
    return you + ' “No time” or “Too much effort” for ' + rushed + ' meals. Something to consider: cooking a double batch on a quieter day, '
      + 'so a busy night is reheat-and-serve. The next plan leans towards quicker dinners from what was said.';
  }
  if (said('missing') >= 2) {
    return you + ' “Missing ingredients” for ' + said('missing') + ' meals. Something to consider: a quick look through the week’s recipes '
      + 'against the cupboard before the shop, and “At home” on anything you already have.';
  }
  if (said('refused') >= 2) {
    return you + ' “Didn’t want to eat it” for ' + said('refused') + ' meals. The next plan offers those dishes less often. '
      + 'Something to consider: a side that’s already a favourite next to anything new, as a gentle way to keep trying.';
  }
  if (w.planned && w.planned - w.sessions >= 2) {
    return (w.sessions ? w.sessions + ' of ' + w.planned : 'None of the ' + w.planned) + ' planned exercise sessions were ticked. '
      + 'Something to consider: picking two set times for next week, even short ones. If something is getting in the way, like pain or tiredness, '
      + 'a physio or GP can help adjust the plan.';
  }
  if (w.shortVeg >= 3) {
    return w.shortVeg + ' days came in under the vegetable serves. Something to consider: one extra vegetable side or salad with dinner. '
      + 'A dietitian or GP can help if there’s a health reason to change the amounts.';
  }
  if (w.shortFruit >= 3) {
    return w.shortFruit + ' days came in under the fruit serves. Something to consider: a piece of fruit as a snack or with breakfast.';
  }
  if (!w.meals && !w.sessions && !w.skipped) {
    return 'Nothing was ticked this week. Ticking meals and sessions as they happen (or “Didn’t have it?” when plans change) '
      + 'is what lets this page show how the week went.';
  }
  return 'A steady week. Something to consider: keeping the same rhythm, and rating a meal or two so the next plan brings back the ones that worked.';
}

// "How the week went" for one person: {week: this one, before: the one before, consider}.
// `which` is "last" (the week just finished) or "this" (this week so far).
function review(person, which, tz, ctx) {
  const today = progress.localDate(Date.now(), tz);
  const monday = progress.addDays(progress.mondayOf(today), which === 'this' ? 0 : -7);
  const plan = ctx.readPlan() || {};
  const profile = db.getProfile(person);
  const answers = (profile && profile.answers) || {};
  const week = oneWeek(person, monday, tz, plan, answers);
  const before = oneWeek(person, progress.addDays(monday, -7), tz, plan, answers);
  return { person, which, today, week, before, consider: considerNext(week, '') };
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

module.exports = { handle, review, remember, considerNext, plannedSessions };
