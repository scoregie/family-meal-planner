// The app's small web server (the "API").
//
// It has no npm packages and no database. Everything people tick, rate or mark "at home"
// is kept in one JSON file, data/state.json. The page in site/ talks to it with fetch().
//
// Each request is passed along a chain of handlers (logins, calendar, plan editing,
// uploads, then the tick routes below). The first handler that recognises the address
// answers it, and the rest are skipped.
const http = require('http');
const fs = require('fs');
const path = require('path');
const auth = require('./auth');          // logins and the login cookie
const calendar = require('./calendar');  // .ics calendar files of eating times
const uploads = require('./uploads');    // the "My files" page
const db = require('./db');              // the long-term database (data/app.db)
const peopleRoutes = require('./people'); // adding people, the About me questions, passwords
const progress = require('./progress');   // the progress dashboard, weigh-ins and imports

// Settings, read from environment variables (set in docker-compose.yml or .env).
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATIC_DIR = process.env.STATIC_DIR || '';   // only used for local testing without Caddy
const PORT = +process.env.PORT || 3000;
const MAX_BODY = 1e6;                              // largest request body we read, in characters (about 1 MB)
const PLAN_FILE = process.env.PLAN_FILE || '/site/plan.json';
const PLAN_EXAMPLE = PLAN_FILE.replace(/plan\.json$/, 'plan.example.json');
const BACKUPS_DIR = path.join(DATA_DIR, 'plan-backups');
const BACKUPS_TO_KEEP = 30;

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

// Turns a name into a simple key: "Alex Smith" becomes "alex-smith".
function toKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

// Remembers the last list of people, so the plan file is only re-read when it changes.
let peopleCache = { file: '', modified: 0, list: [] };

// Returns the keys of everyone in the household, such as ["alex", "sam", "riley"].
// They come from the plan's "people" block, or from PEOPLE=a,b,c in .env if the plan has none.
function people() {
  try {
    const file = fs.existsSync(PLAN_FILE) ? PLAN_FILE : PLAN_EXAMPLE;
    const modified = fs.statSync(file).mtimeMs;
    const fileChanged = file !== peopleCache.file || modified !== peopleCache.modified;
    if (fileChanged) {
      const peopleBlock = JSON.parse(fs.readFileSync(file, 'utf8')).people || {};
      const list = Object.values(peopleBlock)
        .filter(person => person && typeof person === 'object' && person.name)
        .map(person => toKey(person.name));
      peopleCache = { file, modified, list };
    }
    if (peopleCache.list.length) return peopleCache.list;
  } catch (e) {
    // The plan could not be read. Fall through to the .env list below.
  }
  return String(process.env.PEOPLE || '').split(',').map(toKey).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Saved state (ticks, ratings and "at home" marks)
// ---------------------------------------------------------------------------

// The shape of data/state.json:
//   users:   each person's meal and exercise ticks and meal ratings
//   shared:  the shopping list ticks, and who ticked each item
//   have:    names of items marked "At home"
//   updated: when each part last changed, so other phones know to refresh
//   epoch:   when an admin last pressed "Reset all"
let state = { users: {}, shared: null, have: null, updated: {}, epoch: 0 };
try {
  state = Object.assign(state, JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
} catch (e) {
  // No saved file yet (first run). Start empty.
}

// Saves the state to disk. It writes a temporary file first and then renames it,
// so a crash halfway through can never leave a half-written state.json.
function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(state));
  fs.renameSync(tempFile, STATE_FILE);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Sends a JSON answer with an HTTP status code (200 = OK, 400 = bad request, 403 = not allowed, ...).
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Reads the JSON the page sent with its request. Gives up if it is bigger than `max`.
function body(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (text.length > max) {
        reject(new Error('big'));
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

// True for a plain object like {a: 1}. False for lists, null, text and numbers.
function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Keeps only sensible meal ratings from what the page sent, with limits on size.
// The shape is {week: {"Day|Meal": {s: score 1 to 10, n: "note", t: "dish name"}}}.
function cleanRatings(ratings) {
  const out = {};
  if (!isObj(ratings)) return out;
  for (const [week, meals] of Object.entries(ratings).slice(0, 100)) {
    if (!isObj(meals)) continue;
    const cleanWeek = {};
    for (const [mealId, rating] of Object.entries(meals).slice(0, 200)) {
      if (!isObj(rating) || mealId.length > 80) continue;
      const score = Number.isInteger(rating.s) && rating.s >= 1 && rating.s <= 10 ? rating.s : undefined;
      const note = typeof rating.n === 'string' ? rating.n.slice(0, 1000) : '';
      if (!score && !note.trim()) continue;   // nothing worth keeping
      const kept = {};
      if (score) kept.s = score;
      if (note.trim()) kept.n = note;
      if (typeof rating.t === 'string' && rating.t) kept.t = rating.t.slice(0, 300);
      cleanWeek[mealId] = kept;
    }
    if (Object.keys(cleanWeek).length) out[week] = cleanWeek;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admin plan editing (the "Edit plan" page)
// ---------------------------------------------------------------------------
// The admin page sends the whole plan back. The old file is kept in data/plan-backups (the last 30).

// Which plan file to read: the real one, or the example if there is no real one yet.
function planPath() {
  return fs.existsSync(PLAN_FILE) ? PLAN_FILE : PLAN_EXAMPLE;
}

// A "version" for the plan: the time the file was last changed. If two admins edit at once,
// the second save sees a different version and is refused instead of overwriting the first.
function planVersion() {
  try {
    return String(Math.floor(fs.statSync(PLAN_FILE).mtimeMs));
  } catch (e) {
    return '0';
  }
}

// Checks a plan has the basic shape the app needs. Returns '' if it is fine,
// or a message saying what is wrong. (docs/plan-format.md explains every field.)
function checkPlan(plan) {
  if (!isObj(plan) || !Array.isArray(plan.weeks) || !plan.weeks.length) {
    return 'The plan needs a non-empty "weeks" list.';
  }
  for (let i = 0; i < plan.weeks.length; i++) {
    const week = plan.weeks[i];
    const where = 'Week ' + (i + 1) + ': ';
    if (!isObj(week) || !isObj(week.shopping)) return where + '"shopping" must be an object of sections.';

    for (const [section, items] of Object.entries(week.shopping)) {
      if (!Array.isArray(items)) return where + 'section "' + section + '" must be a list.';
      for (const item of items) {
        const looksRight = Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number' && isFinite(item[1]);
        if (!looksRight) return where + 'each item in "' + section + '" needs a name and a price.';
      }
    }

    if (week.meals !== undefined && !Array.isArray(week.meals)) return where + '"meals" must be a list.';

    if (week.exercise !== undefined) {
      if (!isObj(week.exercise)) return where + '"exercise" must be an object.';
      // Either one plan for everyone ({days: [...]}) or one per person ({you: {days: [...]}, ...}).
      const plans = Array.isArray(week.exercise.days) ? [week.exercise] : Object.values(week.exercise);
      for (const p of plans) {
        if (!isObj(p) || !Array.isArray(p.days)) return where + 'each exercise plan needs a "days" list.';
      }
    }
  }
  if (plan.macros !== undefined && !isObj(plan.macros)) return '"macros" must be an object.';
  return '';
}

// Makes a lookup of a week's shopping items by position: {"0-0": "Tomatoes × 3", "0-1": ...}.
// The position is "<section number>-<item number>".
function itemNamesByPosition(week) {
  const names = {};
  const sections = (week && week.shopping) || {};
  Object.values(sections).forEach((items, sectionIndex) => {
    items.forEach((item, itemIndex) => {
      names[sectionIndex + '-' + itemIndex] = item[0];
    });
  });
  return names;
}

// Shopping ticks are stored by position ("<section>-<item>"), so after an edit we move each tick
// to the item with the same name in that week. Ticks on items that were removed are dropped.
function remapTicks(oldPlan, newPlan) {
  if (!state.shared || !isObj(state.shared.ticks)) return;
  const newTicks = {};
  const newBy = {};
  const oldBy = state.shared.by || {};

  for (const [week, tickedIds] of Object.entries(state.shared.ticks)) {
    const oldNames = itemNamesByPosition(oldPlan.weeks[week]);
    const newNames = itemNamesByPosition(newPlan.weeks[week]);

    // For each name in the new list, where it now sits (the first one, if a name appears twice).
    const newPositionOf = {};
    Object.entries(newNames).forEach(([id, name]) => {
      if (!(name in newPositionOf)) newPositionOf[name] = id;
    });

    const moved = [];
    for (const oldId of Array.isArray(tickedIds) ? tickedIds : []) {
      const newId = newPositionOf[oldNames[oldId]];
      if (!newId || moved.includes(newId)) continue;
      moved.push(newId);
      // Keep "ticked by Sam at 5:02 pm" with the item too.
      if (oldBy[week + '|' + oldId]) newBy[week + '|' + newId] = oldBy[week + '|' + oldId];
    }
    if (moved.length) newTicks[week] = moved;
  }
  state.shared = { ticks: newTicks, by: newBy };
  state.updated.shared = Date.now();
}

// Saves a new plan.json, keeping a dated copy of the old one in data/plan-backups.
function savePlan(plan) {
  let oldPlan = null;
  try {
    oldPlan = JSON.parse(fs.readFileSync(planPath(), 'utf8'));
  } catch (e) {
    // No old plan (or it was broken). Nothing to move ticks from.
  }

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  if (fs.existsSync(PLAN_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');   // e.g. 2026-11-08T01-02-03-456Z
    fs.copyFileSync(PLAN_FILE, path.join(BACKUPS_DIR, 'plan-' + stamp + '.json'));
    // Delete all but the newest 30 backups. The names sort by date, so newest first after reverse().
    fs.readdirSync(BACKUPS_DIR)
      .filter(f => /^plan-.*\.json$/.test(f))
      .sort()
      .reverse()
      .slice(BACKUPS_TO_KEEP)
      .forEach(f => fs.unlinkSync(path.join(BACKUPS_DIR, f)));
  }

  const tempFile = PLAN_FILE + '.tmp';
  fs.writeFileSync(tempFile, JSON.stringify(plan, null, 1));
  fs.renameSync(tempFile, PLAN_FILE);

  // Same plan id means it is an edit of the same plan, so keep people's shopping ticks.
  if (oldPlan && Array.isArray(oldPlan.weeks) && oldPlan.id === plan.id) {
    remapTicks(oldPlan, plan);
    persist();
  }
  safely('remember dishes', () => db.rememberDishes(plan));
}

// The backup file names, newest first.
function backups() {
  try {
    return fs.readdirSync(BACKUPS_DIR).filter(f => /^plan-[0-9TZ-]+\.json$/.test(f)).sort().reverse();
  } catch (e) {
    return [];
  }
}

// Answers /api/plan... requests. Returns true if it handled the request.
async function handlePlan(req, res, urlPath, me) {
  if (!urlPath.startsWith('/api/plan')) return false;
  if (!me.admin) {
    send(res, 403, { error: 'only an admin can edit the plan' });
    return true;
  }

  // Read the plan.
  if (urlPath === '/api/plan' && req.method === 'GET') {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(planPath(), 'utf8'));
    } catch (e) {
      send(res, 500, { error: 'plan.json could not be read: ' + e.message });
      return true;
    }
    send(res, 200, { plan, version: planVersion(), example: !fs.existsSync(PLAN_FILE) });
    return true;
  }

  // Save the plan.
  if (urlPath === '/api/plan' && req.method === 'PUT') {
    const b = await body(req, 8e6);   // plans can be big, so allow up to about 8 MB
    if (b.version !== undefined && String(b.version) !== planVersion()) {
      send(res, 409, { error: 'The plan was changed somewhere else since you opened it. Reload to get the latest copy.' });
      return true;
    }
    const problem = checkPlan(b.plan);
    if (problem) {
      send(res, 400, { error: problem });
      return true;
    }
    savePlan(b.plan);
    send(res, 200, { ok: true, version: planVersion() });
    return true;
  }

  // List the backups.
  if (urlPath === '/api/plan/backups' && req.method === 'GET') {
    send(res, 200, { backups: backups() });
    return true;
  }

  // Put an old plan back.
  if (urlPath === '/api/plan/restore' && req.method === 'POST') {
    const b = await body(req);
    if (!backups().includes(b.name)) {   // only names from the list, so nobody can read other files
      send(res, 404, { error: 'no such backup' });
      return true;
    }
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(path.join(BACKUPS_DIR, b.name), 'utf8'));
    } catch (e) {
      send(res, 400, { error: 'that backup could not be read' });
      return true;
    }
    savePlan(plan);
    send(res, 200, { ok: true, version: planVersion() });
    return true;
  }

  send(res, 404, { error: 'not found' });
  return true;
}

// ---------------------------------------------------------------------------
// The database (meal history and remembered dishes)
// ---------------------------------------------------------------------------

// Runs a database step. If it fails, the error is logged and the app carries on, because ticks
// are already safe in state.json and the history can catch up next time.
function safely(what, step) {
  try {
    step();
  } catch (e) {
    console.error('database: could not ' + what + ':', e.message);
  }
}

// The current plan, or null if it can't be read.
function readPlan() {
  try {
    return JSON.parse(fs.readFileSync(planPath(), 'utf8'));
  } catch (e) {
    return null;
  }
}

// When the server starts: remember the plan's dishes, and copy any ticks already in state.json
// into the meal history (so nothing ticked before the database existed is lost).
function startDatabase() {
  safely('open data/app.db', () => db.open());
  const plan = readPlan();
  safely('remember dishes', () => db.rememberDishes(plan));
  for (const [person, saved] of Object.entries(state.users || {})) {
    safely('log meals', () => db.syncMeals(person, plan, state.epoch || 0, saved.eaten, saved.ratings, toKey));
    safely('log exercise', () => db.syncExercise(person, plan, state.epoch || 0, saved.ex, toKey));
  }
}

// GET /api/history?person=...: one person's meal history (your own, or anyone's for admins).
function getHistory(res, url, me) {
  const person = String(url.searchParams.get('person') || me.person).toLowerCase();
  if (!people().includes(person)) return send(res, 404, { error: 'unknown person' });
  if (!me.admin && person !== me.person) return send(res, 403, { error: 'you can only see your own history' });
  return send(res, 200, { person, meals: db.history(person) });
}

// GET /api/dishes: every dish that has been in a plan, with how often it was eaten and its average score.
function getDishes(res, me) {
  if (!me.admin) return send(res, 403, { error: 'only an admin can see every dish' });
  return send(res, 200, { dishes: db.dishes() });
}

// ---------------------------------------------------------------------------
// Ticks, ratings and "at home"
// ---------------------------------------------------------------------------

// GET /api/state: everything the page needs to show ticks. Admins get it all. Everyone else gets
// the shared shopping list plus only their own meal and exercise ticks.
function getState(res, me) {
  if (me.admin) return send(res, 200, state);
  const onlyKeys = (obj, keep) => Object.fromEntries(Object.entries(obj || {}).filter(([key]) => keep(key)));
  const users = onlyKeys(state.users, key => key === me.person);
  const updated = onlyKeys(state.updated, key => key === me.person || key === 'shared');
  return send(res, 200, Object.assign({}, state, { users, updated }));
}

// PUT /api/user/<person>: saves one person's meal ticks, exercise ticks and ratings.
async function putUser(req, res, me, person) {
  if (!people().includes(person)) return send(res, 404, { error: 'unknown user' });
  if (!me.admin && person !== me.person) return send(res, 403, { error: 'you can only change your own ticks' });
  const b = await body(req);
  if (!isObj(b.ex) || !isObj(b.eaten)) return send(res, 400, { error: 'bad body' });
  // Older pages that do not send ratings keep what is already saved.
  const oldRatings = (state.users[person] || {}).ratings || {};
  const ratings = 'ratings' in b ? cleanRatings(b.ratings) : oldRatings;
  state.users[person] = { ex: b.ex, eaten: b.eaten, ratings };
  state.updated[person] = Date.now();
  persist();
  const plan = readPlan();
  safely('log meals', () => db.syncMeals(person, plan, state.epoch || 0, b.eaten, ratings, toKey));
  safely('log exercise', () => db.syncExercise(person, plan, state.epoch || 0, b.ex, toKey));
  return send(res, 200, { ok: true });
}

// PUT /api/shared: saves the shopping list ticks, and remembers who ticked each new item and when.
// "by" looks like {"<week>|<item id>": {who: "alex", at: 1762560000000}}.
async function putShared(req, res, me) {
  const b = await body(req);
  if (!isObj(b.ticks)) return send(res, 400, { error: 'bad body' });
  const previousTicks = (state.shared && state.shared.ticks) || {};
  const by = Object.assign({}, (state.shared && state.shared.by) || {});
  const stillTicked = new Set();
  const now = Date.now();

  for (const week of Object.keys(b.ticks)) {
    const ids = Array.isArray(b.ticks[week]) ? b.ticks[week] : [];
    const wasTicked = new Set(previousTicks[week] || []);
    for (const id of ids) {
      const key = week + '|' + id;
      stillTicked.add(key);
      if (!wasTicked.has(id)) by[key] = { who: me.person, at: now };   // newly ticked by this person
    }
  }
  // Forget "ticked by" for anything that is no longer ticked.
  for (const key of Object.keys(by)) {
    if (!stillTicked.has(key)) delete by[key];
  }

  state.shared = { ticks: b.ticks, by };
  state.updated.shared = now;
  persist();
  return send(res, 200, { ok: true, by });
}

// PUT /api/have: saves the names of items marked "At home".
async function putHave(req, res) {
  const b = await body(req);
  if (!Array.isArray(b.have)) return send(res, 400, { error: 'bad body' });
  state.have = b.have.filter(x => typeof x === 'string').slice(0, 2000);
  persist();
  return send(res, 200, { ok: true });
}

// POST /api/reset: an admin clears every tick, rating and "at home" mark.
function postReset(res, me) {
  if (!me.admin) return send(res, 403, { error: 'only an admin can reset' });
  state = { users: {}, shared: null, have: [], updated: {}, epoch: Date.now() };
  persist();
  return send(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Local testing only: serve the site/ files without Caddy (when STATIC_DIR is set)
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.png': 'image/png',
  '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json',
};

// Sends a file from STATIC_DIR, refusing anything outside it.
function serveStatic(res, urlPath) {
  const file = path.join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(path.resolve(STATIC_DIR))) return send(res, 403, {});
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, {});
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// The server: every request starts here
// ---------------------------------------------------------------------------

// Looks at the address and method of each request and passes it to the right handler.
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://x');   // the host does not matter; we only want the path and ?query
  const urlPath = url.pathname;
  try {
    // Login, logout and Caddy's "is this person logged in?" check.
    if (await auth.handle(req, res, urlPath)) return;

    // Everything under /api/ needs a login. `me` is {user, person, admin}.
    let me = null;
    if (urlPath.startsWith('/api/')) {
      me = auth.session(req);
      if (!me) return send(res, 401, { error: 'login needed' });
      auth.refresh(req, res, me);   // keeps people logged in while they use the app
    }

    if (calendar.handle(req, res, urlPath, url)) return;
    if (await handlePlan(req, res, urlPath, me)) return;
    if (await uploads.handle(req, res, urlPath, url, me, people())) return;
    if (await peopleRoutes.handle(req, res, urlPath, url, me, { readPlan, savePlan, toKey, people })) return;
    if (await progress.handle(req, res, urlPath, url, me, { readPlan, toKey, people })) return;

    if (urlPath === '/api/state' && req.method === 'GET') return getState(res, me);
    if (urlPath === '/api/history' && req.method === 'GET') return getHistory(res, url, me);
    if (urlPath === '/api/dishes' && req.method === 'GET') return getDishes(res, me);

    const userMatch = urlPath.match(/^\/api\/user\/([a-z0-9-]+)$/);
    if (userMatch && req.method === 'PUT') return await putUser(req, res, me, userMatch[1]);

    if (urlPath === '/api/shared' && req.method === 'PUT') return await putShared(req, res, me);
    if (urlPath === '/api/have' && req.method === 'PUT') return await putHave(req, res);
    if (urlPath === '/api/reset' && req.method === 'POST') return postReset(res, me);

    if (urlPath.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (STATIC_DIR) return serveStatic(res, urlPath);
    send(res, 404, { error: 'not found' });
  } catch (e) {
    // Something went wrong reading the request (for example, broken JSON).
    send(res, 400, { error: String(e.message || e) });
  }
}

startDatabase();

http.createServer(handleRequest)
  // Long enough for a big Apple Health export over slow Wi-Fi (Node's default is 5 minutes).
  .on('listening', function () { this.requestTimeout = 60 * 60 * 1000; })
  .listen(PORT, () => {
    console.log('tick API on', PORT, 'logins:', auth.users().join(', ') || 'NONE - add LOGIN_<NAME> lines to .env');
  });
