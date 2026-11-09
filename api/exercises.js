// The exercise library (exercises.json): browse it, leave exercises out of your plans, and swap one
// in your plan for another of the same kind.
//
//   GET  /api/exercises?person=          the library, which ones suit the person, and their "leave out" list
//   PUT  /api/exercises/avoid?person=    {id, avoid: true|false}: leave an exercise out of future plans (or not)
//   POST /api/exercises/swap?person=     {workout, item, to, avoid}: swap item number `item` of a workout in
//                                        the person's plan for exercise `to` (and optionally leave the old one out)
//
// People can change their own; admins can change anyone's. A workout shared by everyone can only be
// changed by an admin.
const db = require('./db');
const planbuilder = require('./planbuilder');

const EXERCISES = planbuilder.EXERCISES;

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (text.length > 2e4) { reject(new Error('too big')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(text || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function avoidList(person) {
  try {
    const v = JSON.parse(db.getSetting('exercise-avoid:' + person) || '[]');
    return Array.isArray(v) ? v.filter(id => typeof id === 'string') : [];
  } catch (e) {
    return [];
  }
}

function setAvoid(person, id, on) {
  const list = avoidList(person).filter(x => x !== id);
  if (on) list.push(id);
  db.setSetting('exercise-avoid:' + person, JSON.stringify(list));
  return list;
}

// The library exercise a workout line is about ("Warm-up: March on the spot (5 minutes): ..." or
// "Goblet squat: hold one dumbbell...") or null.
function match(line) {
  const name = String(line || '').replace(/^(warm-up|cool-down)\s*:\s*/i, '').split(/\s*[(:]/)[0].trim().toLowerCase();
  if (!name) return null;
  return EXERCISES.find(e => e.name.toLowerCase() === name)
    || EXERCISES.find(e => name.startsWith(e.name.toLowerCase()) || e.name.toLowerCase().startsWith(name)) || null;
}

// A workout line for an exercise, keeping a "Warm-up: " or "Cool-down: " start.
function lineFor(e, old) {
  const start = (/^(warm-up|cool-down)\s*:\s*/i.exec(old) || [''])[0];
  return start + e.name + ' (' + e.dose + '): ' + e.how;
}

async function handle(req, res, urlPath, url, me, ctx) {
  if (!['/api/exercises', '/api/exercises/avoid', '/api/exercises/swap'].includes(urlPath)) return false;
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }
  const person = String(url.searchParams.get('person') || me.person || '').toLowerCase();
  if (!ctx.people().includes(person)) { send(res, 404, { error: 'unknown person' }); return true; }
  if (!me.admin && person !== me.person) { send(res, 403, { error: 'you can only change your own exercises' }); return true; }

  if (urlPath === '/api/exercises' && req.method === 'GET') {
    const profile = db.getProfile(person);
    const avoid = avoidList(person);
    const fits = planbuilder.exerciseFits({ answers: (profile && profile.answers) || {}, avoid: [] });
    send(res, 200, { exercises: EXERCISES, fits, avoid });
    return true;
  }

  let body;
  try { body = await readBody(req); } catch (e) { send(res, 400, { error: 'bad request' }); return true; }

  if (urlPath === '/api/exercises/avoid' && req.method === 'PUT') {
    if (!EXERCISES.some(e => e.id === body.id)) { send(res, 400, { error: 'unknown exercise' }); return true; }
    send(res, 200, { ok: true, avoid: setAvoid(person, body.id, !!body.avoid) });
    return true;
  }

  if (urlPath === '/api/exercises/swap' && req.method === 'POST') {
    const to = EXERCISES.find(e => e.id === body.to);
    if (!to) { send(res, 400, { error: 'unknown exercise' }); return true; }
    const plan = ctx.readPlan();
    const ex = plan && plan.exercise;
    if (!ex) { send(res, 404, { error: 'The plan has no exercise section.' }); return true; }
    let target;
    if (Array.isArray(ex.workouts)) {
      if (!me.admin) { send(res, 403, { error: 'These workouts are shared by everyone, so only an admin can change them.' }); return true; }
      target = ex;
    } else {
      const key = db.planKeyFor(plan, person, ctx.toKey);
      target = ex[key];
    }
    const workout = target && Array.isArray(target.workouts) ? target.workouts.find(w => w && w.name === body.workout) : null;
    const index = Number(body.item);
    if (!workout || !Array.isArray(workout.items) || !Number.isInteger(index) || index < 0 || index >= workout.items.length) {
      send(res, 409, { error: 'That workout has changed. Reload the page and try again.' });
      return true;
    }
    const old = match(workout.items[index]);
    if (!old) { send(res, 400, { error: 'That line isn’t an exercise from the library, so it can’t be swapped here.' }); return true; }
    if (old.type !== to.type && !(old.type === 'lunge' && to.type === 'squat') && !(old.type === 'squat' && to.type === 'lunge')) {
      send(res, 400, { error: 'Pick an exercise of the same kind.' });
      return true;
    }
    workout.items[index] = lineFor(to, workout.items[index]);
    ctx.savePlan(plan);
    if (body.avoid && old.id !== to.id) setAvoid(person, old.id, true);
    send(res, 200, { ok: true, line: workout.items[index] });
    return true;
  }

  send(res, 405, { error: 'method not allowed' });
  return true;
}

module.exports = { handle, match };
