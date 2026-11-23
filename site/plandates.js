// The plan's dates. A plan can have a "startDate": the Monday that Week 1 starts on (YYYY-MM-DD).
// From it this file works out each week's dates, the date of each day, and which week today is
// in. A plan without a start date still works: the pages just show no dates.
//
// Stock-up weeks (kind "stockup") have no days of their own: they are shopped just before the
// week after them, so they get that week's dates.
//
// Pages load it with <script src="plandates.js"> (it sets window.PlanDates); the server loads it
// with require(), the same way it loads skipreasons.js. Dates are plain "YYYY-MM-DD" text, so
// there are no time zones to go wrong: the pages pass in today's date on the device.
(function () {
  "use strict";

  var DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  var DAY_MS = 86400000;

  // "2026-11-23" to a number of days, so dates can be added and compared (null if it isn't a real date).
  function toDays(text) {
    var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(text || ""));
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var back = new Date(ms);
    if (back.getUTCMonth() !== +m[2] - 1 || back.getUTCDate() !== +m[3]) return null;   // like 31 Feb
    return ms / DAY_MS;
  }

  // A number of days back to "YYYY-MM-DD".
  function fromDays(n) {
    return new Date(n * DAY_MS).toISOString().slice(0, 10);
  }

  // The date `n` days after `date` ("YYYY-MM-DD"; n can be negative).
  function addDays(date, n) {
    var d = toDays(date);
    return d === null ? null : fromDays(d + n);
  }

  // True if `date` is a real date and a Monday.
  function isMonday(date) {
    var d = toDays(date);
    return d !== null && new Date(d * DAY_MS).getUTCDay() === 1;
  }

  // The Monday of the week `date` is in.
  function mondayOf(date) {
    var d = toDays(date);
    if (d === null) return null;
    return fromDays(d - (new Date(d * DAY_MS).getUTCDay() + 6) % 7);
  }

  // The coming Monday: `today` itself if it is a Monday. What Plan setup suggests for a new plan.
  function nextMonday(today) {
    return isMonday(today) ? today : addDays(mondayOf(today), 7);
  }

  // The plan's start date if it has a good one (a Monday), or null.
  function start(plan) {
    return plan && isMonday(plan.startDate) ? plan.startDate : null;
  }

  // Which week of days `index` (a place in plan.weeks) is: 0 for Week 1. Stock-ups count as the
  // week after them (or the last week, if one comes at the end).
  function weekOffset(plan, index) {
    var weeks = (plan && plan.weeks) || [];
    var n = -1, found = -1;
    for (var i = 0; i < weeks.length; i++) {
      if (weeks[i] && weeks[i].kind === "stockup") continue;
      n++;
      if (i >= index) { found = n; break; }
    }
    return found >= 0 ? found : Math.max(n, 0);
  }

  // The Monday and Sunday of the week at `index` in plan.weeks: {from, to}, or null without a start date.
  function weekRange(plan, index) {
    var s = start(plan);
    if (!s) return null;
    var from = addDays(s, 7 * weekOffset(plan, index));
    return { from: from, to: addDays(from, 6) };
  }

  // The date of a day ("Mon" or "Monday") in the week at `index`, or null.
  function dayDate(plan, index, day) {
    var range = weekRange(plan, index);
    var at = DAYS.indexOf(String(day || "").slice(0, 3));
    return range && at >= 0 ? addDays(range.from, at) : null;
  }

  // Where `today` falls in the plan: {state: "before" | "during" | "after", index, day}.
  // `index` is the place in plan.weeks of the week today is in (the first week when before, the
  // last when after), and `day` is today's "Mon" to "Sun". Null without a start date.
  function locate(plan, today) {
    var s = start(plan), t = toDays(today);
    if (!s || t === null) return null;
    var weeks = (plan && plan.weeks) || [];
    var days = [];   // the places in plan.weeks of the weeks with days, in order
    weeks.forEach(function (w, i) { if (!(w && w.kind === "stockup")) days.push(i); });
    if (!days.length) return null;
    var offset = Math.floor((t - toDays(s)) / 7);
    var day = DAYS[(new Date(t * DAY_MS).getUTCDay() + 6) % 7];
    if (offset < 0) return { state: "before", index: days[0], day: day };
    if (offset >= days.length) return { state: "after", index: days[days.length - 1], day: day };
    return { state: "during", index: days[offset], day: day };
  }

  // The last day of the plan (the Sunday of its last week), or null.
  function end(plan) {
    var weeks = (plan && plan.weeks) || [];
    var range = weekRange(plan, weeks.length - 1);
    return range ? range.to : null;
  }

  var PlanDates = {
    DAYS: DAYS, addDays: addDays, isMonday: isMonday, mondayOf: mondayOf, nextMonday: nextMonday,
    start: start, weekRange: weekRange, dayDate: dayDate, locate: locate, end: end,
  };
  if (typeof module === "object" && module.exports) module.exports = PlanDates;
  else window.PlanDates = PlanDates;
})();
