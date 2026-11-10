// What the plan writer is told about each person on top of their About me answers:
//   - their feedback on earlier meals (the scores out of 10 and the "what didn't you like?" notes),
//   - the health numbers they've logged or uploaded (weight, steps, energy, food, workouts),
//   - their "small steps" record (new foods they've tried, and whether they liked them).
// The built-in plan builder (planbuilder.js) and the AI's instructions (plandraft.js) both use it.
//
//   GET /api/steps?person=...   your own small-steps record (admins: anyone's)
//   PUT /api/steps?person=...   {food, result}: result is "tried", "liked", "not yet" or "" to clear
//
// Files uploaded as PDFs or photos (blood tests and so on) can't be read here: only the numbers
// from Lose It, Apple Health and Health sync, which are saved as measurements.
const db = require('./db');

const DAY = 24 * 3600 * 1000;
const RESULTS = ['tried', 'liked', 'not yet'];

// Sends an answer back to the page: a status code and an object, turned into JSON text.
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Reads what the page sent (a small piece of JSON text) and turns it into an object.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 5000) { reject(new Error('too big')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// One person's feedback on meals from earlier plans:
//   {rated: {"lower-case dish name": average score out of 10}, notes: [{dish, note}]}.
function feedbackFor(person) {
  const rated = {}, notes = [];
  try {
    for (const f of db.mealFeedback(person)) {
      if (f.score != null) rated[f.dish.toLowerCase()] = f.score;
      for (const note of f.notes) if (notes.length < 20) notes.push({ dish: f.dish, note: note.slice(0, 200) });
    }
  } catch (e) { /* feedback is a nice-to-have: a plan can still be made without it */ }
  return { rated, notes };
}

// A date as YYYY-MM-DD, `days` before today.
function daysAgo(days) {
  return new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
}

// The average of a list of numbers, or null for an empty list.
function average(list) {
  return list.length ? list.reduce((n, x) => n + x, 0) / list.length : null;
}

// The health numbers one person has logged or uploaded, summed up for the plan writer, or null
// if there are none from the last 8 weeks. Averages are over the last 4 weeks, using the days
// that have a number. {weight, weightDate, weightChange, steps, activeEnergy, energyIn,
// proteinIn, workoutsPerWeek}: anything not logged is left out.
function measuredFor(person) {
  let rows = [];
  try { rows = db.measurements(person, daysAgo(56)); } catch (e) { return null; }
  if (!rows.length) return null;
  // One value per kind and date (the biggest, so steps counted by two apps aren't added twice).
  const byKind = {};
  for (const r of rows) {
    const days = byKind[r.kind] = byKind[r.kind] || new Map();
    days.set(r.date, Math.max(days.get(r.date) || 0, r.value));
  }
  const recent = kind => [...(byKind[kind] || new Map())].filter(([date]) => date >= daysAgo(28)).map(([, value]) => value);
  const out = {};
  const weights = [...(byKind.weight || new Map())].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (weights.length) {
    const [date, value] = weights[weights.length - 1];
    out.weight = Math.round(value * 10) / 10;
    out.weightDate = date;
    // The change since the oldest weight in the 8 weeks, if that is at least 2 weeks earlier.
    const [firstDate, first] = weights[0];
    if (firstDate <= daysAgo(14) && firstDate !== date) out.weightChange = Math.round((value - first) * 10) / 10;
  }
  const round = (n, step) => (n == null ? null : Math.round(n / step) * step);
  const numbers = {
    steps: round(average(recent('steps')), 100),
    activeEnergy: round(average(recent('active_energy')), 50),
    energyIn: round(average(recent('energy_in')), 50),
    proteinIn: round(average(recent('protein_in')), 1),
  };
  for (const [k, v] of Object.entries(numbers)) if (v) out[k] = v;
  const workouts = recent('workouts').reduce((n, x) => n + x, 0);
  if (workouts) out.workoutsPerWeek = Math.round(workouts / 4 * 10) / 10;
  return Object.keys(out).length ? out : null;
}

// A sentence for the AI about someone's logged numbers, or '' when there are none.
function measuredText(m) {
  if (!m) return '';
  const bits = [];
  if (m.weight) bits.push('latest weight ' + m.weight + ' kg on ' + m.weightDate + (m.weightChange ? ' (' + (m.weightChange > 0 ? 'up ' : 'down ') + Math.abs(m.weightChange) + ' kg over the last 8 weeks or less)' : ''));
  if (m.steps) bits.push('about ' + m.steps + ' steps a day');
  if (m.activeEnergy) bits.push('about ' + m.activeEnergy + ' kJ of active energy a day');
  if (m.energyIn) bits.push('food logged at about ' + m.energyIn + ' kJ a day' + (m.proteinIn ? ' with ' + m.proteinIn + ' g of protein' : ''));
  if (m.workoutsPerWeek) bits.push('about ' + m.workoutsPerWeek + ' logged workouts a week');
  return bits.join('; ');
}

// One person's small-steps record: {"food they were offered": "tried" | "liked" | "not yet"}.
function triedFor(person) {
  try {
    const saved = JSON.parse(db.getSetting('small-steps:' + person) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch (e) {
    return {};
  }
}

// Answers /api/steps requests. Returns true if it handled the request. `ctx.people()` lists the
// people in the plan. People see and change their own record; admins can do it for anyone
// (parents usually tick for a child).
async function handle(req, res, urlPath, url, me, ctx) {
  if (urlPath !== '/api/steps') return false;
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') { send(res, 403, { error: 'bad request' }); return true; }
  const person = String(url.searchParams.get('person') || me.person || '').toLowerCase();
  if (!ctx.people().includes(person)) { send(res, 404, { error: 'unknown person' }); return true; }
  if (!me.admin && person !== me.person) { send(res, 403, { error: 'You can only change your own small steps.' }); return true; }

  if (req.method === 'GET') { send(res, 200, { person, tried: triedFor(person) }); return true; }
  if (req.method === 'PUT') {
    let b;
    try { b = await readBody(req); } catch (e) { send(res, 400, { error: 'bad request' }); return true; }
    const food = String(b.food || '').trim().slice(0, 120);
    const result = String(b.result || '');
    if (!food || (result && !RESULTS.includes(result))) { send(res, 400, { error: 'bad request' }); return true; }
    const tried = triedFor(person);
    if (result) tried[food] = result; else delete tried[food];
    // Keep the newest 200, so the record can't grow forever.
    const kept = Object.fromEntries(Object.entries(tried).slice(-200));
    db.setSetting('small-steps:' + person, JSON.stringify(kept));
    send(res, 200, { ok: true, tried: kept });
    return true;
  }
  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle, feedbackFor, measuredFor, measuredText, triedFor };
