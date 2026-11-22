// "How the week went", worked out: one person's week next to the week before, from what was
// ticked, rated and skipped. The web server (weekreview.js) and the phone app (its local-api.js)
// both use this file, each giving it their own saved records, so the two can't drift apart.
// So it uses nothing else: no database, no files, no require(). The two helpers it needs
// (healthtargets.js and site/skipreasons.js) are handed in.
//
// What it is given (`data`):
//   today       "YYYY-MM-DD", the person's local date
//   which       "last" (the week just finished) or "this" (this week so far)
//   rows        meal slots ticked, rated or skipped around the two weeks:
//               [{plan_id, week, day, slot, dish, eaten, eaten_at, score, skip_reason, updated_at}]
//   sessions    exercise sessions ticked around the two weeks: [{done_at}]
//   log         the dated log: [{at, kind: "cardio", moved, level} | {at, kind: "tried", food, result}]
//   plan, planKey, answers   the plan, their key in its "people" block, and their About me answers
//   localDate   a function: a time (milliseconds) to their local "YYYY-MM-DD"
//   HealthTargets, SkipReasons   the two helper files
// What it gives back: {week, before, consider} (see oneWeek for what a week holds).

// Adds days to a "YYYY-MM-DD" date.
function weekAddDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The Monday on or before a date: weeks start on Monday.
function weekMondayOf(date) {
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
  return weekAddDays(date, weekday === 0 ? -6 : 1 - weekday);
}

// The times (milliseconds) to read records between for a review: from a day before the week
// before, to two days after the week asked for, so no time zone can push something out.
function weekSpan(today, which) {
  const monday = weekAddDays(weekMondayOf(today), which === 'this' ? 0 : -7);
  const DAY = 24 * 60 * 60 * 1000;
  return {
    monday,
    from: new Date(weekAddDays(monday, -7) + 'T00:00:00Z').getTime() - DAY,
    to: new Date(weekAddDays(monday, 6) + 'T00:00:00Z').getTime() + 2 * DAY,
  };
}

// The plan's exercise sessions for one person in one plan week (not optional ones, not rest days).
// `leaveOut` is an optional list of days, like ["Wed", "Thu"], whose sessions aren't counted.
function plannedSessions(plan, weekIndex, planKey, leaveOut) {
  const week = plan && plan.weeks && plan.weeks[weekIndex];
  const mine = week && week.exercise && planKey && week.exercise[planKey];
  if (!mine || !Array.isArray(mine.days)) return 0;
  let n = 0;
  for (const day of mine.days) {
    if (leaveOut && day && leaveOut.includes(day.day)) continue;
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
function shortDays(eatenRows, data) {
  const { plan, planKey, answers, HealthTargets } = data;
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

// Everything about one week (`monday` to the Sunday after).
function oneWeek(data, monday) {
  const { plan, planKey, SkipReasons } = data;
  const sunday = weekAddDays(monday, 6);
  const inWeek = ms => { const d = data.localDate(ms); return d >= monday && d <= sunday; };
  const rows = data.rows || [];
  const eaten = rows.filter(r => r.eaten && inWeek(r.eaten_at));
  const skipped = rows.filter(r => !r.eaten && r.skip_reason && inWeek(r.updated_at));
  const scored = rows.filter(r => r.score != null && inWeek(r.updated_at) && r.dish);
  const sessions = (data.sessions || []).filter(s => inWeek(s.done_at));

  const thisPlan = r => String(r.plan_id) === String((plan && plan.id) || 'default');
  const planWeek = mostCommon(rows.filter(r => thisPlan(r) && (inWeek(r.updated_at) || (r.eaten && inWeek(r.eaten_at)))).map(r => r.week));
  // Days they said they were unwell ("Unwell" on a meal): that day's sessions aren't counted as missed.
  const unwellDays = [...new Set(skipped.filter(r => r.skip_reason === 'unwell' && thisPlan(r) && r.week === planWeek).map(r => r.day))];
  const allPlanned = plan && planWeek != null ? plannedSessions(plan, planWeek, planKey) : 0;
  const planned = plan && planWeek != null ? plannedSessions(plan, planWeek, planKey, unwellDays) : 0;

  const reasons = {};
  for (const r of skipped) reasons[r.skip_reason] = (reasons[r.skip_reason] || 0) + 1;
  const log = (data.log || []).filter(e => e && inWeek(e.at));
  const short = shortDays(eaten, data);
  return {
    monday, sunday,
    meals: eaten.length,
    best: scored.filter(r => r.score >= 8).sort((a, b) => b.score - a.score).slice(0, 3).map(r => ({ dish: r.dish, score: r.score })),
    low: scored.filter(r => r.score <= 4).sort((a, b) => a.score - b.score).slice(0, 3).map(r => ({ dish: r.dish, score: r.score })),
    sessions: sessions.length,
    planned,
    unwellDays: unwellDays.length,
    restedSessions: allPlanned - planned,
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
  if (said('unwell')) {
    return (name ? name + ' said they were' : 'You said you were') + ' unwell for ' + said('unwell') + (said('unwell') === 1 ? ' meal' : ' meals') + ', so sessions planned on those days aren’t counted as missed. '
      + 'Something to consider: easing back in with shorter, easier sessions and simple meals until you feel like yourself again. '
      + 'If you’re still unwell, or it keeps coming back, your GP or pharmacist can help, including with any medicines while you’re sick.';
  }
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

// The whole review: {week: the one asked for, before: the one before it, consider}.
function summarise(data) {
  const monday = weekSpan(data.today, data.which).monday;
  const week = oneWeek(data, monday);
  const before = oneWeek(data, weekAddDays(monday, -7));
  return { week, before, consider: considerNext(week, '') };
}

const WeekSummary = { summarise, weekSpan, considerNext, plannedSessions, mondayOf: weekMondayOf, addDays: weekAddDays };
if (typeof module === 'object' && module.exports) module.exports = WeekSummary;
else window.WeekSummary = WeekSummary;
