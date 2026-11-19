// The exercise library (exercises.json): browse it, leave exercises out of your plans, and swap one
// in your plan for another of the same kind.
//
//   GET  /api/exercises?person=          the library, which ones suit the person, and their "leave out" list
//   PUT  /api/exercises/avoid?person=    {id, avoid: true|false}: leave an exercise out of future plans (or not)
//   POST /api/exercises/swap?person=     {workout, item, to, avoid}: swap item number `item` of a workout in
//                                        the person's plan for exercise `to` (and optionally leave the old one out)
//   GET  /api/exercises/cardio?person=   their cardio level now (cardio.js) and the sessions they've said how felt
//   POST /api/exercises/cardio?person=   {id: "2|Mon-cardio", feel: "easy"|"right"|"hard"}: how a cardio session
//                                        felt; two "too easy" in a row steps the level up, one "too hard" steps it back
//
// People can change their own; admins can change anyone's. A workout shared by everyone can only be
// changed by an admin.
const db = require('./db');
const rules = require('./sharedrules');   // rules the phone app follows too
const planbuilder = require('./planbuilder');
const cardio = require('./cardio');
const planextras = require('./planextras');   // logged numbers: Apple Watch cardio fitness and resting heart rate
const { send, readBody } = require('./requests');   // reading what a page sent, and sending JSON back

const EXERCISES = planbuilder.EXERCISES;

// The exercises a person asked to leave out of future plans (a list of exercise ids).
function avoidList(person) {
  try {
    const v = JSON.parse(db.getSetting('exercise-avoid:' + person) || '[]');
    return Array.isArray(v) ? v.filter(id => typeof id === 'string') : [];
  } catch (e) {
    return [];
  }
}

// Adds an exercise to a person's leave-out list (on = true) or takes it off. Returns the new list.
function setAvoid(person, id, on) {
  const list = avoidList(person).filter(x => x !== id);
  if (on) list.push(id);
  db.setSetting('exercise-avoid:' + person, JSON.stringify(list));
  return list;
}

// What is saved about how someone's cardio sessions felt ({base, offset, feels}), or null.
function cardioSaved(person) {
  try { return JSON.parse(db.getSetting('cardio-feel:' + person) || 'null'); } catch (e) { return null; }
}

// Someone's cardio level now, for the page: the level (cardio.js), which sessions they've
// already said how felt (`felt`: {"2|Mon-cardio": "easy"}), and `resting` when their resting
// heart rate is up today ({today, usual}).
function cardioFor(person) {
  const profile = db.getProfile(person);
  const saved = cardioSaved(person);
  const now = planbuilder.cardioNow((profile && profile.answers) || {}, saved, planextras.measuredFor(person));
  const check = planextras.restingCheck(person);
  if (check && check.up) now.resting = { today: check.today, usual: check.usual };
  const felt = {};
  for (const f of (saved && saved.feels) || []) felt[f.id] = f.feel;
  return Object.assign(now, { felt, top: cardio.TOP });
}

// Answers the requests this file looks after. server.js offers every /api/ request to each
// file in turn: this returns true if it answered, or false to let the next file try.
async function handle(req, res, urlPath, url, me, ctx) {
  if (!['/api/exercises', '/api/exercises/avoid', '/api/exercises/swap', '/api/exercises/cardio'].includes(urlPath)) return false;
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

  if (urlPath === '/api/exercises/cardio' && req.method === 'GET') {
    send(res, 200, cardioFor(person));
    return true;
  }

  let body;
  try { body = await readBody(req); } catch (e) { send(res, 400, { error: 'bad request' }); return true; }

  if (urlPath === '/api/exercises/cardio' && req.method === 'POST') {
    const id = String(body.id || '');
    if (!['easy', 'right', 'hard'].includes(body.feel) || !/^([A-Za-z0-9-]{1,40}\|)?\d{1,2}\|[A-Za-z]{3}-[a-z]{1,12}$/.test(id)) {
      send(res, 400, { error: 'bad request' });
      return true;
    }
    const profile = db.getProfile(person);
    const answers = (profile && profile.answers) || {};
    const before = planbuilder.cardioNow(answers, cardioSaved(person), planextras.measuredFor(person));
    const after = cardio.feelAfter(answers.cardio_level, cardioSaved(person), id, body.feel, before.limit, before.guess, before.steady);
    db.setSetting('cardio-feel:' + person, JSON.stringify(after.saved));
    send(res, 200, Object.assign(cardioFor(person), { moved: after.moved }));
    return true;
  }

  if (urlPath === '/api/exercises/avoid' && req.method === 'PUT') {
    if (!EXERCISES.some(e => e.id === body.id)) { send(res, 400, { error: 'unknown exercise' }); return true; }
    send(res, 200, { ok: true, avoid: setAvoid(person, body.id, !!body.avoid) });
    return true;
  }

  if (urlPath === '/api/exercises/swap' && req.method === 'POST') {
    const plan = ctx.readPlan();
    const ex = plan && plan.exercise;
    if (!ex) { send(res, 404, { error: 'The plan has no exercise section.' }); return true; }
    const shared = Array.isArray(ex.workouts);   // one set of workouts for everyone
    if (shared && !me.admin) { send(res, 403, { error: 'These workouts are shared by everyone, so only an admin can change them.' }); return true; }
    const target = shared ? ex : ex[rules.planKeyFor(plan, person)];
    // A person's own workout: the new exercise has to suit them (equipment, injuries, pregnancy,
    // seated) and not be one they left out. The page only offers these, but check here too.
    let suits = null;
    if (!shared) {
      const profile = db.getProfile(person);
      suits = planbuilder.exerciseFits({ answers: (profile && profile.answers) || {}, avoid: avoidList(person) });
    }
    const done = rules.swapExercise(target, body, EXERCISES, suits);
    if (done.error) { send(res, done.code, { error: done.error }); return true; }
    ctx.savePlan(plan);
    if (body.avoid && done.old.id !== body.to) setAvoid(person, done.old.id, true);
    send(res, 200, { ok: true, line: done.line });
    return true;
  }

  send(res, 405, { error: 'method not allowed' });
  return true;
}

module.exports = { handle };
