// The progress dashboard: weigh-ins, imports from Lose It and Apple Health, and week-by-week totals.
//
//   GET    /api/progress?person=...&weeks=12&tz=...   week-by-week numbers for the charts
//   POST   /api/progress/import?person=...            read the newest Lose It and Apple Health files
//   POST   /api/measurements?person=...               add a weigh-in {date, weight}
//   DELETE /api/measurements?person=...&id=...        remove a weigh-in typed in by hand
//
// Everyone sees only their own progress. Admins can see anyone's.
//
// Where the numbers come from:
//   weight         weigh-ins typed in here, then Apple Health, then Lose It (the first one that has a value that day)
//   steps          Apple Health, then Lose It
//   active energy  Apple Health ("Move" kilojoules)
//   workouts       Apple Health workouts
//   food energy    Lose It food logs (kJ, protein, carbs and fat)
//   meals, ratings, exercise sessions: the ticks in this app (from the database)
//   plan estimate  the meals ticked as eaten × each dish's macros × the person's portion
const fs = require('fs');
const path = require('path');
const db = require('./db');
const zip = require('./zip');
const uploads = require('./uploads');

const DAY = 24 * 60 * 60 * 1000;
const KJ_PER_KCAL = 4.184;
const KG_PER_LB = 0.45359237;

// Sends a JSON answer with an HTTP status code.
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Reads the JSON the page sent (up to 10 KB).
function body(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (text.length > 1e4) {
        reject(new Error('too big'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Dates. Everything is grouped by the person's local date, written "YYYY-MM-DD".
// ---------------------------------------------------------------------------

// A time zone name the browser sent, if Node knows it. Otherwise the server's own.
function zoneOrDefault(tz) {
  try {
    if (tz) {
      new Intl.DateTimeFormat('en-CA', { timeZone: tz });
      return tz;
    }
  } catch (e) { /* unknown time zone */ }
  return undefined;
}

// The local date of a time (milliseconds), like "2026-11-08".
function localDate(ms, tz) {
  // The en-CA format happens to be YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

// Adds days to a "YYYY-MM-DD" date.
function addDays(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// The Monday on or before a date: weeks start on Monday.
function mondayOf(date) {
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
  return addDays(date, weekday === 0 ? -6 : 1 - weekday);
}

// "05/17/2026" (Lose It's US-style dates) to "2026-05-17".
function fromUsDate(text) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(text).trim());
  return m ? m[3] + '-' + m[1] + '-' + m[2] : null;
}

// True for a date written like "2026-11-10".
function isDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(text)) && !isNaN(new Date(text + 'T00:00:00Z'));
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

// Splits one line of a CSV file into fields (Lose It quotes fields that have commas in them).
function csvFields(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field.replace(/\r$/, ''));
  return out;
}

// A CSV file's rows as objects, using the first line as the column names.
function csvRows(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const names = csvFields(lines.shift() || '');
  return lines.map(line => {
    const fields = csvFields(line);
    return Object.fromEntries(names.map((n, i) => [n, fields[i]]));
  });
}

// Ignores obviously wrong values, like a weight of 0 or a start date of 01/01/2001.
function sensible(kind, value, date) {
  if (!Number.isFinite(value) || !date || date < '2005-01-01') return false;
  const limits = { weight: [20, 400], steps: [1, 150000], active_energy: [1, 40000], workouts: [1, 20],
    workout_minutes: [1, 1440], energy_in: [1, 60000], protein_in: [0.1, 1000], carbs_in: [0.1, 2000], fat_in: [0.1, 1000] };
  const [low, high] = limits[kind] || [-Infinity, Infinity];
  return value >= low && value <= high;
}

// Reads a Lose It export (a zip of CSV files) into measurement rows.
async function readLoseIt(file) {
  const entries = zip.list(file);
  const find = name => entries.find(e => e.name === name || e.name.endsWith('/' + name));
  const rows = [];
  const add = (date, kind, value, unit) => {
    if (sensible(kind, value, date)) rows.push({ date, kind, value: Math.round(value * 100) / 100, unit });
  };

  const weights = find('weights.csv');
  if (weights) {
    for (const r of csvRows(await zip.readText(file, weights, 5e6))) {
      if (String(r.Deleted).toLowerCase() === 'true') continue;
      add(fromUsDate(r.Date), 'weight', Number(r.Weight), 'kg');
    }
  }
  // Files with one value per day: "Date,Value,...".
  const daily = [['steps.csv', 'steps', 'steps'], ['protein.csv', 'protein_in', 'g'], ['carbohydrates.csv', 'carbs_in', 'g'], ['fat.csv', 'fat_in', 'g']];
  for (const [name, kind, unit] of daily) {
    const entry = find(name);
    if (!entry) continue;
    for (const r of csvRows(await zip.readText(file, entry, 5e6))) add(fromUsDate(r.Date), kind, Number(r.Value), unit);
  }
  const summary = find('daily-calorie-summary.csv');
  if (summary) {
    for (const r of csvRows(await zip.readText(file, summary, 5e6))) add(fromUsDate(r.Date), 'energy_in', Number(r['Food kJ']), 'kJ');
  }
  return rows;
}

// Reads one attribute from an XML line: attr('<Record value="83.9"/>', 'value') gives "83.9".
function attr(line, name) {
  const at = line.indexOf(' ' + name + '="');
  if (at < 0) return null;
  const start = at + name.length + 3;
  return line.slice(start, line.indexOf('"', start));
}

// Reads an Apple Health export (a zip with apple_health_export/export.xml, often hundreds of MB)
// a line at a time, keeping only weight, steps, active energy and workouts.
async function readAppleHealth(file) {
  const entry = zip.list(file).find(e => /(^|\/)export\.xml$/.test(e.name));
  if (!entry) throw new Error('no export.xml in this zip');

  const weights = new Map();     // date -> the last weight that day
  const perSource = new Map();   // "kind|date|source" -> total. Phone and watch both count steps,
                                 // so we add up each source, then keep the biggest (not the sum).
  const workouts = new Map();    // date -> {count, minutes}

  await zip.eachLine(file, entry, line => {
    if (line.includes('<Record ')) {
      const type = attr(line, 'type');
      const date = (attr(line, 'startDate') || '').slice(0, 10);   // already the phone's local date
      const value = Number(attr(line, 'value'));
      if (type === 'HKQuantityTypeIdentifierBodyMass') {
        const unit = attr(line, 'unit');
        weights.set(date, unit === 'lb' ? value * KG_PER_LB : value);
      } else if (type === 'HKQuantityTypeIdentifierStepCount' || type === 'HKQuantityTypeIdentifierActiveEnergyBurned') {
        const kind = type === 'HKQuantityTypeIdentifierStepCount' ? 'steps' : 'active_energy';
        const amount = kind === 'active_energy' && attr(line, 'unit') === 'kcal' ? value * KJ_PER_KCAL : value;
        const key = kind + '|' + date + '|' + attr(line, 'sourceName');
        if (Number.isFinite(amount)) perSource.set(key, (perSource.get(key) || 0) + amount);
      }
    } else if (line.includes('<Workout ')) {
      const date = (attr(line, 'startDate') || '').slice(0, 10);
      let minutes = Number(attr(line, 'duration'));
      const unit = attr(line, 'durationUnit');
      if (unit === 's') minutes /= 60;
      if (unit === 'hr' || unit === 'h') minutes *= 60;
      const w = workouts.get(date) || { count: 0, minutes: 0 };
      w.count++;
      if (Number.isFinite(minutes)) w.minutes += minutes;
      workouts.set(date, w);
    }
  });

  const rows = [];
  const add = (date, kind, value, unit) => {
    if (sensible(kind, value, date)) rows.push({ date, kind, value: Math.round(value * 100) / 100, unit });
  };
  for (const [date, kg] of weights) add(date, 'weight', kg, 'kg');
  const best = new Map();   // "kind|date" -> the biggest source total
  for (const [key, total] of perSource) {
    const [kind, date] = key.split('|');
    const k = kind + '|' + date;
    if (!best.has(k) || total > best.get(k)) best.set(k, total);
  }
  for (const [k, total] of best) {
    const [kind, date] = k.split('|');
    add(date, kind, total, kind === 'steps' ? 'steps' : 'kJ');
  }
  for (const [date, w] of workouts) {
    add(date, 'workouts', w.count, 'sessions');
    add(date, 'workout_minutes', w.minutes, 'min');
  }
  return rows;
}

// The newest file of each kind in someone's uploads (Lose It zip, Apple Health zip), with its age.
function newestExports(person) {
  const found = [];
  for (const [category, source] of [['lose-it', 'lose-it'], ['apple-health', 'apple-health']]) {
    const dir = path.join(uploads.ROOT, person, category);
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { continue; }
    const zips = names.filter(n => /\.zip$/i.test(n))
      .map(n => ({ file: path.join(dir, n), name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (zips.length) found.push(Object.assign({ source }, zips[0]));
  }
  return found;
}

// Files that are newer than the last import (so the page knows to ask for one).
function waitingImports(person) {
  return newestExports(person).filter(f => {
    const last = JSON.parse(db.getSetting('import:' + person + ':' + f.source) || 'null');
    return !last || last.name !== f.name || last.mtime !== f.mtime;
  });
}

// Imports the newest Lose It and Apple Health files. Only one import runs at a time.
let importing = null;
// Reads the newest Lose It or Apple Health export someone uploaded, saving its numbers. Only one
// import runs at a time, so two can't write the same numbers at once.
async function runImport(person) {
  while (importing) await importing.catch(() => {});
  const work = (async () => {
    const results = [];
    for (const f of newestExports(person)) {
      const started = Date.now();
      try {
        const rows = f.source === 'lose-it' ? await readLoseIt(f.file) : await readAppleHealth(f.file);
        db.saveMeasurements(person, f.source, rows);
        db.setSetting('import:' + person + ':' + f.source, JSON.stringify({ name: f.name, mtime: f.mtime, at: Date.now(), rows: rows.length }));
        results.push({ source: f.source, file: f.name, rows: rows.length, seconds: Math.round((Date.now() - started) / 100) / 10 });
      } catch (e) {
        results.push({ source: f.source, file: f.name, error: String(e.message || e) });
      }
    }
    return results;
  })();
  importing = work;
  try {
    return await work;
  } finally {
    importing = null;
  }
}

// ---------------------------------------------------------------------------
// The weekly summary
// ---------------------------------------------------------------------------

// Which source to trust for each kind, best first.
// "apple-shortcut" is the daily sync from an iPhone Shortcut (healthsync.js): the full export
// wins when both have a day, as it has every source.
const PREFER = {
  weight: ['manual', 'apple-health', 'apple-shortcut', 'lose-it'],
  steps: ['apple-health', 'apple-shortcut', 'lose-it', 'manual'],
  active_energy: ['apple-health', 'apple-shortcut'],
  energy_in: ['lose-it', 'apple-shortcut'],
  protein_in: ['lose-it', 'apple-shortcut'],
  carbs_in: ['lose-it', 'apple-shortcut'],
  fat_in: ['lose-it', 'apple-shortcut'],
};

// The average of a list of numbers, or null if it is empty.
function average(list) {
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

// Rounds to a number of decimal places: round(3.14159, 2) gives 3.14.
function round(n, places) {
  return n == null ? null : Math.round(n * 10 ** places) / 10 ** places;
}

// kJ in a serve with p, c and f grams of protein, carbohydrate and fat.
function kjOf(m) {
  return 17 * (m.p || 0) + 17 * (m.c || 0) + 37 * (m.f || 0);
}

// Builds everything the dashboard shows for one person over the last `weeks` weeks.
function summary(person, weeks, tz, ctx) {
  const today = localDate(Date.now(), tz);
  const firstWeek = addDays(mondayOf(today), -7 * (weeks - 1));
  // Read a day early and late, so a time zone can't push a tick out of range.
  const sinceMs = new Date(firstWeek + 'T00:00:00Z').getTime() - DAY;

  // One value per date and kind, from the best source.
  const byKind = {};   // kind -> Map(date -> {value, source})
  const manual = [];
  for (const m of db.measurements(person, firstWeek)) {
    const order = PREFER[m.kind] || [m.source];
    const map = byKind[m.kind] || (byKind[m.kind] = new Map());
    const current = map.get(m.date);
    const rank = s => (order.indexOf(s) < 0 ? 99 : order.indexOf(s));
    if (!current || rank(m.source) < rank(current.source)) map.set(m.date, { value: m.value, source: m.source });
    if (m.source === 'manual' && m.kind === 'weight') manual.push({ id: m.id, date: m.date, weight: m.value });
  }

  // The weeks, oldest first.
  const list = [];
  const index = {};
  for (let i = 0; i < weeks; i++) {
    const start = addDays(firstWeek, 7 * i);
    index[start] = list.length;
    list.push({ week: start, weight: [], steps: [], active_energy: [], workouts: 0, workout_minutes: 0,
      energy_in: [], protein_in: [], meals: 0, plan_kj: {}, plan_protein: {}, scores: [], sessions: 0 });
  }
  const weekOf = date => (date >= firstWeek && date <= today ? list[index[mondayOf(date)]] : null);

  for (const kind of ['weight', 'steps', 'active_energy', 'energy_in', 'protein_in']) {
    for (const [date, v] of byKind[kind] || []) {
      const w = weekOf(date);
      if (w) w[kind].push(v.value);
    }
  }
  for (const kind of ['workouts', 'workout_minutes']) {
    for (const [date, v] of byKind[kind] || []) {
      const w = weekOf(date);
      if (w) w[kind] += v.value;
    }
  }

  // The plan's estimate: each ticked meal's macros × this person's portion.
  const plan = ctx.readPlan() || {};
  const planKey = db.planKeyFor(plan, person, ctx.toKey);
  const portion = Number(plan.people && plan.people[planKey] && plan.people[planKey].portion) || 1;
  for (const meal of db.eatenMeals(person, sinceMs)) {
    const date = localDate(meal.eaten_at, tz);
    const w = weekOf(date);
    if (!w) continue;
    w.meals++;
    if (meal.macros) {
      w.plan_kj[date] = (w.plan_kj[date] || 0) + kjOf(meal.macros) * portion;
      w.plan_protein[date] = (w.plan_protein[date] || 0) + (meal.macros.p || 0) * portion;
    }
  }
  for (const r of db.ratingsSince(person, sinceMs)) {
    const w = weekOf(localDate(r.updated_at, tz));
    if (w) w.scores.push(r.score);
  }
  for (const s of db.sessionsSince(person, sinceMs)) {
    const w = weekOf(localDate(s.done_at, tz));
    if (w) w.sessions++;
  }

  // Turn each week's lists into averages. Daily numbers are "per day that has a value".
  const out = list.map(w => ({
    week: w.week,
    weight: round(average(w.weight), 1),
    steps: round(average(w.steps), 0),
    active_energy: round(average(w.active_energy), 0),
    workouts: w.workouts,
    workout_minutes: round(w.workout_minutes, 0),
    energy_in: round(average(w.energy_in), 0),
    protein_in: round(average(w.protein_in), 0),
    meals: w.meals,
    plan_kj: round(average(Object.values(w.plan_kj)), 0),
    plan_protein: round(average(Object.values(w.plan_protein)), 0),
    score: round(average(w.scores), 1),
    sessions: w.sessions,
  }));

  // Every weigh-in in the range, for the weight chart's dots.
  const weighIns = [...(byKind.weight || new Map())]
    .map(([date, v]) => ({ date, weight: v.value, source: v.source }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  // The newest day (today, else yesterday) with phone numbers, for the Today page.
  let latest = null;
  for (const date of [today, addDays(today, -1)]) {
    const day = { date };
    for (const kind of ['steps', 'active_energy', 'energy_in']) {
      const v = byKind[kind] && byKind[kind].get(date);
      if (v) day[kind] = round(v.value, 0);
    }
    if (Object.keys(day).length > 1) { latest = day; break; }
  }

  const profile = db.getProfile(person);
  const answers = (profile && profile.answers) || {};
  return {
    person,
    today,
    latest,
    weeks: out,
    weighIns,
    manual: manual.sort((a, b) => (a.date < b.date ? 1 : -1)),
    goalWeight: Number(answers.goal_weight) || null,
    waiting: waitingImports(person).map(f => f.source),
    imported: newestExports(person).map(f => Object.assign({ source: f.source }, JSON.parse(db.getSetting('import:' + person + ':' + f.source) || 'null'))),
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

// Answers /api/progress, /api/progress/import and /api/measurements. Returns true if it handled one.
async function handle(req, res, urlPath, url, me, ctx) {
  const mine = ['/api/progress', '/api/progress/import', '/api/measurements'];
  if (!mine.includes(urlPath)) return false;

  // Changes must come from the app itself (a second guard on top of the SameSite cookie).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }
  const person = String(url.searchParams.get('person') || me.person || '').toLowerCase();
  if (!ctx.people().includes(person)) {
    send(res, 404, { error: 'unknown person' });
    return true;
  }
  if (!me.admin && person !== me.person) {
    send(res, 403, { error: 'you can only see your own progress' });
    return true;
  }

  if (urlPath === '/api/progress' && req.method === 'GET') {
    const weeks = Math.min(104, Math.max(4, parseInt(url.searchParams.get('weeks'), 10) || 12));
    send(res, 200, summary(person, weeks, zoneOrDefault(url.searchParams.get('tz')), ctx));
    return true;
  }

  if (urlPath === '/api/progress/import' && req.method === 'POST') {
    send(res, 200, { ok: true, results: await runImport(person) });
    return true;
  }

  if (urlPath === '/api/measurements' && req.method === 'POST') {
    const b = await body(req);
    const weight = Number(b.weight);
    const date = String(b.date || '');
    if (!isDate(date) || date > addDays(localDate(Date.now()), 1)) {
      send(res, 400, { error: 'Pick a date that is not in the future.' });
      return true;
    }
    if (!sensible('weight', weight, date)) {
      send(res, 400, { error: 'Enter a weight in kg, like 82.4.' });
      return true;
    }
    db.saveMeasurement(person, date, 'weight', Math.round(weight * 10) / 10, 'kg', 'manual', null);
    send(res, 200, { ok: true });
    return true;
  }

  if (urlPath === '/api/measurements' && req.method === 'DELETE') {
    const id = parseInt(url.searchParams.get('id'), 10);
    if (db.deleteMeasurement(person, id)) send(res, 200, { ok: true });
    else send(res, 404, { error: 'not found' });
    return true;
  }

  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { sensible, handle, summary, readLoseIt, readAppleHealth, mondayOf, csvFields };
