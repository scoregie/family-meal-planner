// How much vegetables and fruit a plan should reach for each person, and how much it does reach.
//
// When a plan is made, the order of importance is:
//   1. Hard limits: allergies, diets and medicine rules. Never traded away.
//   2. Health targets: each person's vegetable and fruit serves for their age and sex (this file),
//      at the pace they chose in About me: from week 1, building up, or not at all.
//   3. Safe foods and textures: these decide HOW the targets are met (soft, blended, on the side).
//   4. Likes and dislikes: these only choose between dishes that already fit 1 to 3.
//
// The numbers are the Australian Dietary Guidelines' serves a day (a serve is 75 g of vegetables or
// 150 g of fruit), the same numbers as site/guidelines.json. They are at or above what New Zealand,
// the UK, Japan and Korea ask for, so one table is used for every country. A test checks this
// table against site/guidelines.json so the two can't drift apart.
//
// Used by the built-in plan builder (planbuilder.js), by the instructions the AI gets
// (plandraft.js), and to tell the admin how a draft measures up before they approve it.
// It also runs in the phone app, which has no require(), so it ends like planbuilder.js does.

// Serves a day by age and sex: [youngest age, oldest age, sex, vegetables, fruit].
// (The names here are spelled out because the phone app loads this file next to planbuilder.js,
// and two files can't both have a top-level name like "TABLE".)
const VEG_FRUIT_TABLE = [
  [2, 3, 'any', 2.5, 1],
  [4, 8, 'any', 4.5, 1.5],
  [9, 11, 'any', 5, 2],
  [12, 18, 'male', 5.5, 2],
  [12, 18, 'female', 5, 2],
  [19, 50, 'male', 6, 2],
  [19, 50, 'female', 5, 2],
  [51, 70, 'male', 5.5, 2],
  [51, 70, 'female', 5, 2],
  [71, 120, 'any', 5, 2],
];

// Each person chooses in About me how much the plan should change what they eat
// (the "eating_change" question). The answer becomes one of three paces:
//   "full"   reach the guideline serves from week 1 (also used when they haven't answered)
//   "build"  start part of the way there and reach them by week 3
//   "own"    keep close to what they eat now: nothing is added to reach the serves
function paceFor(answers) {
  const choice = String((answers || {}).eating_change || '');
  if (/^Build up/.test(choice)) return 'build';
  if (/^Keep it close/.test(choice)) return 'own';
  return 'full';
}

// For the "build" pace: the share of the full serves aimed for in each of the 4 meal weeks.
const BUILD_UP = [0.7, 0.85, 1, 1];

// The serves to aim for in one meal week (1 to 4) for someone's pace: {veg, fruit}, or null when
// they chose to keep to what they eat now.
function weekTarget(answers, weekNumber) {
  const pace = paceFor(answers);
  if (pace === 'own') return null;
  const full = targetFor(answers);
  const share = pace === 'build' ? BUILD_UP[Math.max(1, Math.min(4, weekNumber)) - 1] : 1;
  return { veg: full.veg * share, fruit: full.fruit * share };
}

// A plan counts as reaching a target when it is within this many serves of it.
const CLOSE_ENOUGH = 0.5;

// The vegetable and fruit serves a day for someone, from their About me answers (age and sex):
// {veg, fruit}. Without an age it uses an adult's numbers; without a sex, the lower of the two.
function targetFor(answers) {
  const a = answers || {};
  const age = parseFloat(a.age);
  const sex = a.sex === 'Male' ? 'male' : a.sex === 'Female' ? 'female' : null;
  const years = Number.isFinite(age) ? Math.max(2, Math.min(120, Math.floor(age))) : 30;
  const rows = VEG_FRUIT_TABLE.filter(r => years >= r[0] && years <= r[1]);
  const row = rows.find(r => r[2] === sex) || rows.find(r => r[2] === 'any') || rows.slice().sort((x, y) => x[3] - y[3])[0];
  return { veg: row[3], fruit: row[4] };
}

// A dish or snack name the way the plan's "groups" block is matched: lower case, without a
// trailing "(packed)".
function nameKey(name) {
  return String(name || '').toLowerCase().replace(/\s*\(packed\)\s*$/, '').trim();
}

// True if a day of someone's exercise plan has a strength (weights) session.
function isStrengthDay(exDay) {
  if (!exDay) return false;
  if (exDay.strength) return true;
  return Object.keys(exDay).some(k => k !== 'day' && typeof exDay[k] === 'string'
    && /strength|weights|resistance/i.test(exDay[k]) && !/^optional/i.test(exDay[k]));
}

// The dishes and snacks one person eats on one day of a meal week, as [{name, snack}]. It follows
// the same rules as the Meals page: their own breakfast or school lunch, anything set just for
// them that day, and the snacks that fall on that day (optional snacks are left out).
// `weekNumber` is which meal week this is (1 to 4), for snacks that only run in some weeks.
function eatenOn(week, meal, person, key, weekNumber) {
  const day = String(meal.day || '').slice(0, 3);
  const rows = { breakfast: meal.breakfast, lunch: meal.lunch, dinner: meal.dinner };
  const out = [];
  const school = person.weekday && person.weekday[day];
  if (school && school.lunch) rows.lunch = school.lunch;
  if (person.breakfast) rows.breakfast = person.breakfast;
  const own = meal.people && meal.people[key];
  if (own) for (const slot of Object.keys(rows)) if (own[slot]) rows[slot] = own[slot];
  for (const slot of Object.keys(rows)) if (rows[slot]) out.push({ name: rows[slot], snack: false });
  if (school && school.snack) out.push({ name: school.snack, snack: true });

  const exPlan = week.exercise && week.exercise[key];
  const exDay = exPlan && Array.isArray(exPlan.days)
    ? exPlan.days.find(d => String(d.day || '').slice(0, 3) === day) || {} : null;
  for (const s of person.snacks || []) {
    if (!s || !s.what || s.optional) continue;
    if (Array.isArray(s.days) && !s.days.includes(day)) continue;
    if (Array.isArray(s.weeks) && weekNumber && !s.weeks.includes(weekNumber)) continue;
    if (s.exercise && exDay) {
      const active = Object.keys(exDay).some(k => k !== 'day' && exDay[k] && !/^optional|^rest/i.test(String(exDay[k])));
      if (s.exercise === 'strength' && !isStrengthDay(exDay)) continue;
      if (s.exercise === 'rest' && isStrengthDay(exDay)) continue;
      if (s.exercise === 'active' && !active) continue;
      if (s.exercise === 'inactive' && active) continue;
    }
    out.push({ name: s.what, snack: true });
  }
  return out;
}

// One person's average vegetable and fruit serves a day over the plan's meal weeks: {veg, fruit}.
// Meals are scaled by the person's portion; snacks are already written for them, so they aren't.
// `plan` needs weeks, people and groups (food groups for each dish name, see docs/plan-format.md).
// `onlyWeeks` (optional) is a list of meal week numbers to measure, like [3, 4]; without it, all.
function dailyAverage(plan, key, onlyWeeks) {
  const person = (plan.people || {})[key] || {};
  const portion = Number(person.portion) || 1;
  const groups = {};
  for (const name of Object.keys(plan.groups || {})) groups[nameKey(name)] = plan.groups[name];
  let veg = 0, fruit = 0, days = 0, weekNumber = 0;
  for (const week of plan.weeks || []) {
    if (!Array.isArray(week.meals)) continue;   // a stock-up week has no meals
    weekNumber++;
    if (onlyWeeks && !onlyWeeks.includes(weekNumber)) continue;
    for (const meal of week.meals) {
      days++;
      for (const row of eatenOn(week, meal, person, key, weekNumber)) {
        const g = groups[nameKey(row.name)];
        if (!g) continue;
        const factor = row.snack ? 1 : portion;
        veg += (g.veg || 0) * factor;
        fruit += (g.fruit || 0) * factor;
      }
    }
  }
  return days ? { veg: veg / days, fruit: fruit / days } : { veg: 0, fruit: 0 };
}

// One decimal place: 5.25 gives 5.3.
function oneDecimal(n) {
  return Math.round(n * 10) / 10;
}

// How every person's plan measures up:
//   [{key, name, pace, veg, fruit, target: {veg, fruit}, short: [...]}].
// `people` is a list of {key, name, answers}. "short" lists the groups ("veg", "fruit") that are
// more than half a serve under the target. Someone building up is measured on weeks 3 and 4,
// where they are meant to have arrived. Someone keeping to what they eat now is measured but
// never counted as short, because that was their choice.
function review(plan, people) {
  return people.filter(p => plan.people && plan.people[p.key]).map(p => {
    const pace = paceFor(p.answers);
    const target = targetFor(p.answers);
    const got = dailyAverage(plan, p.key, pace === 'build' ? [3, 4] : null);
    const short = pace === 'own' ? [] : ['veg', 'fruit'].filter(g => got[g] < target[g] - CLOSE_ENOUGH);
    return { key: p.key, name: p.name, pace, veg: oneDecimal(got.veg), fruit: oneDecimal(got.fruit), target, short };
  });
}

// A sentence for the admin about anyone whose plan is short, or '' when everyone's reaches the targets.
function shortNote(plan, people) {
  const words = { veg: 'vegetables', fruit: 'fruit' };
  const bits = [];
  for (const r of review(plan, people)) {
    for (const g of r.short) bits.push(r.name + '’s days average about ' + r[g] + ' of ' + r.target[g] + ' serves of ' + words[g]);
  }
  if (!bits.length) return '';
  return 'Against the guideline amounts, ' + bits.join('; ') + '. These are estimates from the plan’s food groups. Consider adding a side or a snack in Edit plan, or drafting again.';
}

const HealthTargets = { TABLE: VEG_FRUIT_TABLE, CLOSE: CLOSE_ENOUGH, BUILD_UP, targetFor, paceFor, weekTarget, dailyAverage, review, shortNote, eatenOn, nameKey };
if (typeof module === 'object' && module.exports) module.exports = HealthTargets;
else window.HealthTargets = HealthTargets;
