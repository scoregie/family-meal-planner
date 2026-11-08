// The app's database: one SQLite file, data/app.db. SQLite is built into Node, so no packages.
//
// plan.json is still the current plan, and state.json still holds this fortnight's ticks.
// The database keeps things for the long run:
//   meal_log      every meal someone ate or rated, kept even after "Reset all" or a new plan
//   dishes        every dish and recipe that has been in a plan, with its macros
//   measurements  weigh-ins and other numbers for the progress dashboard
//   profiles      each person's answers to the "getting started" questions
//   requests      changes people have asked an admin to make
//   settings      app-wide settings such as colours and fonts
//   logins        logins added from the app (logins in .env still work too)
//
// To look inside it yourself:  sqlite3 data/app.db ".tables"   (or any SQLite viewer)
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || '/data';
const DB_FILE = path.join(DATA_DIR, 'app.db');

// Each step changes the database's layout once. They run in order, and the database remembers
// how many have run (PRAGMA user_version), so adding step 2 later upgrades existing databases.
const MIGRATIONS = [
  // 1: the first layout
  `
  CREATE TABLE meal_log (
    person     TEXT NOT NULL,     -- person key, like "alex"
    plan_id    TEXT NOT NULL,     -- the plan's "id"
    round      INTEGER NOT NULL,  -- changes each time an admin presses "Reset all", so old rounds are kept
    week       INTEGER NOT NULL,  -- position in the plan's weeks (0 is the first)
    week_name  TEXT,              -- like "Week 1"
    day        TEXT NOT NULL,     -- "Mon" to "Sun"
    slot       TEXT NOT NULL,     -- "Breakfast", "Lunch", "Dinner" or "School snack"
    dish       TEXT,              -- what was planned for that person
    eaten      INTEGER NOT NULL DEFAULT 0,  -- 1 if ticked as eaten
    eaten_at   INTEGER,           -- when it was first ticked (milliseconds since 1970)
    score      INTEGER,           -- rating 1 to 10, or empty
    note       TEXT,              -- what they didn't like
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (person, plan_id, round, week, day, slot)
  );
  CREATE INDEX meal_log_by_person ON meal_log (person, eaten_at);

  CREATE TABLE dishes (
    key        TEXT PRIMARY KEY,  -- lower-case name, the same matching the app uses for macros
    name       TEXT NOT NULL,
    recipe     TEXT,              -- the recipe from the plan, as JSON (empty for dishes without one)
    macros     TEXT,              -- {"p","c","f"} per average serve, as JSON
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    plan_id    TEXT               -- the last plan it was in
  );

  CREATE TABLE measurements (
    id         INTEGER PRIMARY KEY,
    person     TEXT NOT NULL,
    date       TEXT NOT NULL,     -- YYYY-MM-DD
    kind       TEXT NOT NULL,     -- "weight", "waist", "steps", "energy", ...
    value      REAL NOT NULL,
    unit       TEXT,              -- "kg", "cm", "steps", "kJ", ...
    source     TEXT NOT NULL DEFAULT 'manual',  -- "manual", "lose-it", "apple-health"
    note       TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE (person, date, kind, source)
  );

  CREATE TABLE profiles (
    person     TEXT PRIMARY KEY,
    answers    TEXT NOT NULL,     -- the answers, as JSON
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE requests (
    id         INTEGER PRIMARY KEY,
    person     TEXT NOT NULL,     -- who asked
    created_at INTEGER NOT NULL,
    title      TEXT NOT NULL,
    details    TEXT,
    change     TEXT,              -- a suggested change to the plan, as JSON, if there is one
    status     TEXT NOT NULL DEFAULT 'open',  -- "open", "done" or "declined"
    decided_by TEXT,
    decided_at INTEGER,
    reply      TEXT
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL           -- as JSON
  );
  `,
  // 2: logins added from the People tab of Edit plan
  `
  CREATE TABLE logins (
    username   TEXT PRIMARY KEY,  -- lower case, like "sam"
    hash       TEXT NOT NULL,     -- the password, scrambled with scrypt (never the password itself)
    person     TEXT NOT NULL,     -- the person key they tick as
    admin      INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    created_by TEXT
  );
  `,
];

let db = null;

// Opens the database (making it the first time) and brings its layout up to date.
function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');   // safer and faster when reading and writing at once
  db.exec('PRAGMA foreign_keys = ON');
  const done = db.prepare('PRAGMA user_version').get().user_version;
  for (let step = done; step < MIGRATIONS.length; step++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[step]);
      db.exec('PRAGMA user_version = ' + (step + 1));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

// Runs `work` as one transaction: either all of its changes are saved, or none are.
function transaction(work) {
  const d = open();
  d.exec('BEGIN');
  try {
    const result = work(d);
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  }
}

// How the app matches a dish to its macros: lower case, ignoring a trailing "(packed)".
function dishKey(name) {
  return String(name || '').replace(/\s*\(packed\)\s*$/i, '').trim().toLowerCase();
}

// The plan's own key for a person ("adult1"), from the server's key ("alex", made from the name).
function planKeyFor(plan, person, toKey) {
  const block = (plan && plan.people) || {};
  return Object.keys(block).find(k => block[k] && block[k].name && toKey(block[k].name) === person) || null;
}

// What `person` was planned to eat in a meal slot, following the same rules as the Meals tab:
// their own breakfast, a packed school lunch or snack, or a meal an admin set just for them.
function plannedDish(plan, weekIndex, dayName, slot, planKey) {
  const week = plan.weeks[weekIndex];
  const day = week && (week.meals || []).find(d => d.day === dayName);
  if (!day) return null;
  const person = planKey ? (plan.people || {})[planKey] : null;
  const school = person && person.weekday && person.weekday[dayName];
  let dish = slot === 'School snack' ? null : day[slot.toLowerCase()];
  if (slot === 'Breakfast' && person && person.breakfast) dish = person.breakfast;
  if (slot === 'Lunch' && school && school.lunch) dish = school.lunch;
  if (slot === 'School snack' && school) dish = school.snack;
  const own = planKey && day.people && day.people[planKey];
  if (own && own[slot.toLowerCase()]) dish = own[slot.toLowerCase()];
  return dish || null;
}

// Copies one person's current ticks and ratings into meal_log. `eaten` and `ratings` are what the
// page saves ({week: ["Mon|Breakfast"]} and {week: {"Mon|Dinner": {s, n, t}}}). Rows for this
// round that are no longer eaten or rated are removed; earlier rounds and plans are never touched.
function syncMeals(person, plan, round, eaten, ratings, toKey) {
  if (!plan || !Array.isArray(plan.weeks)) return;
  const planId = String(plan.id || 'default');
  const planKey = planKeyFor(plan, person, toKey);
  const now = Date.now();

  // Every meal slot that is eaten or rated now: "week|Day|Slot" -> {week, day, slot, eaten, rating}
  const current = new Map();
  const slotFor = (week, id) => {
    const [day, slot] = String(id).split('|');
    if (!day || !slot) return null;
    const key = week + '|' + day + '|' + slot;
    if (!current.has(key)) current.set(key, { week: +week, day, slot, eaten: false, rating: null });
    return current.get(key);
  };
  for (const [week, ids] of Object.entries(eaten || {})) {
    for (const id of Array.isArray(ids) ? ids : []) {
      const row = slotFor(week, id);
      if (row) row.eaten = true;
    }
  }
  for (const [week, meals] of Object.entries(ratings || {})) {
    for (const [id, rating] of Object.entries(meals || {})) {
      const row = slotFor(week, id);
      if (row) row.rating = rating;
    }
  }

  transaction(d => {
    const existing = d.prepare('SELECT week, day, slot, eaten_at FROM meal_log WHERE person = ? AND plan_id = ? AND round = ?')
      .all(person, planId, round);
    const firstEaten = new Map(existing.map(r => [r.week + '|' + r.day + '|' + r.slot, r.eaten_at]));
    const remove = d.prepare('DELETE FROM meal_log WHERE person = ? AND plan_id = ? AND round = ? AND week = ? AND day = ? AND slot = ?');
    for (const r of existing) {
      if (!current.has(r.week + '|' + r.day + '|' + r.slot)) remove.run(person, planId, round, r.week, r.day, r.slot);
    }

    const save = d.prepare(`
      INSERT INTO meal_log (person, plan_id, round, week, week_name, day, slot, dish, eaten, eaten_at, score, note, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (person, plan_id, round, week, day, slot) DO UPDATE SET
        week_name = excluded.week_name, dish = excluded.dish, eaten = excluded.eaten, eaten_at = excluded.eaten_at,
        score = excluded.score, note = excluded.note, updated_at = excluded.updated_at`);
    for (const [key, row] of current) {
      const week = plan.weeks[row.week];
      if (!week) continue;
      const rating = row.rating || {};
      const planned = rating.t || plannedDish(plan, row.week, row.day, row.slot, planKey);
      const dish = planned ? String(planned).replace(/\s*\(packed\)\s*$/i, '').trim() : null;
      // Keep the time it was first ticked. Unticking clears it.
      const eatenAt = row.eaten ? (firstEaten.get(key) || now) : null;
      const score = Number.isInteger(rating.s) ? rating.s : null;
      const note = typeof rating.n === 'string' && rating.n.trim() ? rating.n : null;
      save.run(person, planId, round, row.week, week.name || null, row.day, row.slot, dish, row.eaten ? 1 : 0, eatenAt, score, note, now);
    }
  });
}

// Remembers every dish in a plan (recipes, meals, snacks), with its recipe and macros. Dishes from
// older plans stay in the table, so they can be found again later.
function rememberDishes(plan) {
  if (!plan || !Array.isArray(plan.weeks)) return;
  const now = Date.now();
  const planId = String(plan.id || 'default');
  const macros = {};
  for (const [name, value] of Object.entries(plan.macros || {})) macros[dishKey(name)] = value;

  // name -> recipe (or null). The first recipe with a name wins, like on the Meals tab.
  const found = new Map();
  const add = (name, recipe) => {
    const key = dishKey(name);
    if (!key || key === 'school provides lunch') return;
    if (!found.has(key)) found.set(key, { name: String(name).replace(/\s*\(packed\)\s*$/i, '').trim(), recipe: null });
    if (recipe && !found.get(key).recipe) found.get(key).recipe = recipe;
  };
  for (const week of plan.weeks) {
    for (const recipe of week.recipes || []) {
      if (recipe && typeof recipe === 'object' && recipe.name) add(recipe.name, recipe);
    }
    for (const day of week.meals || []) {
      for (const meal of ['breakfast', 'lunch', 'dinner']) if (day[meal]) add(day[meal]);
      for (const own of Object.values(day.people || {})) {
        for (const meal of ['breakfast', 'lunch', 'dinner']) if (own && own[meal]) add(own[meal]);
      }
    }
  }
  for (const person of Object.values(plan.people || {})) {
    if (!person || typeof person !== 'object') continue;
    if (person.breakfast) add(person.breakfast);
    for (const school of Object.values(person.weekday || {})) {
      if (school && school.lunch) add(school.lunch);
      if (school && school.snack) add(school.snack);
    }
    for (const snack of person.snacks || []) if (snack && snack.what) add(snack.what);
  }

  transaction(d => {
    // A dish that is no longer in the plan keeps its old recipe and macros.
    const save = d.prepare(`
      INSERT INTO dishes (key, name, recipe, macros, first_seen, last_seen, plan_id) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET
        name = excluded.name,
        recipe = COALESCE(excluded.recipe, dishes.recipe),
        macros = COALESCE(excluded.macros, dishes.macros),
        last_seen = excluded.last_seen, plan_id = excluded.plan_id`);
    for (const [key, dish] of found) {
      const recipe = dish.recipe ? JSON.stringify(dish.recipe) : null;
      const m = macros[key] ? JSON.stringify(macros[key]) : null;
      save.run(key, dish.name, recipe, m, now, now, planId);
    }
  });
}

// One person's meal history, newest first: what they ate and how they rated it.
function history(person, limit = 1000) {
  return open().prepare(`
    SELECT plan_id, round, week, week_name, day, slot, dish, eaten, eaten_at, score, note, updated_at
    FROM meal_log WHERE person = ? ORDER BY COALESCE(eaten_at, updated_at) DESC LIMIT ?`).all(person, limit);
}

// Every remembered dish, with how often it has been eaten and its average rating across everyone.
function dishes() {
  const rows = open().prepare(`
    SELECT d.key, d.name, d.recipe, d.macros, d.first_seen, d.last_seen, d.plan_id,
           (SELECT COUNT(*) FROM meal_log m WHERE lower(m.dish) = d.key AND m.eaten = 1) AS times_eaten,
           (SELECT ROUND(AVG(m.score), 1) FROM meal_log m WHERE lower(m.dish) = d.key AND m.score IS NOT NULL) AS avg_score,
           (SELECT COUNT(m.score) FROM meal_log m WHERE lower(m.dish) = d.key) AS ratings
    FROM dishes d ORDER BY d.name`).all();
  return rows.map(r => Object.assign({}, r, {
    recipe: r.recipe ? JSON.parse(r.recipe) : null,
    macros: r.macros ? JSON.parse(r.macros) : null,
  }));
}

// ---------- logins ----------

// One login added from the app: {username, hash, person, admin}, or undefined.
function getLogin(username) {
  return open().prepare('SELECT username, hash, person, admin FROM logins WHERE username = ?').get(username);
}

// Every login added from the app (without the password hashes).
function listLogins() {
  return open().prepare('SELECT username, person, admin, created_at, created_by FROM logins ORDER BY username').all();
}

// Adds a login. `hash` is already scrambled (auth.hash).
function addLogin(username, hash, person, admin, createdBy) {
  open().prepare('INSERT INTO logins (username, hash, person, admin, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(username, hash, person, admin ? 1 : 0, Date.now(), createdBy || null);
}

// Changes a login's password. Returns true if there was such a login.
function setPassword(username, hash) {
  return open().prepare('UPDATE logins SET hash = ? WHERE username = ?').run(hash, username).changes > 0;
}

// ---------- profiles (the getting-started answers) ----------

// A person's answers ({question id: answer}) and when they were saved, or null.
function getProfile(person) {
  const row = open().prepare('SELECT answers, updated_at FROM profiles WHERE person = ?').get(person);
  return row ? { answers: JSON.parse(row.answers), updated_at: row.updated_at } : null;
}

// Saves a person's answers, replacing what was there.
function saveProfile(person, answers) {
  open().prepare(`INSERT INTO profiles (person, answers, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (person) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at`)
    .run(person, JSON.stringify(answers), Date.now());
}

module.exports = {
  open, transaction, syncMeals, rememberDishes, history, dishes, dishKey, DB_FILE,
  getLogin, listLogins, addLogin, setPassword, getProfile, saveProfile,
};
