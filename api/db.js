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
//   exercise_log  every exercise session ticked as done, kept like meal_log
//   chats         conversations with the Claude assistant
//   ai_usage      how many assistant messages each person sent each day (for the daily limit)
//   accounts      logins by email address (owner, admins and members of the family)
//   invites       invite links for new family members (only a hash of each link is kept)
//   password_resets  links for setting a new password (also only hashes)
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
  // 3: exercise history, for the progress dashboard
  `
  CREATE TABLE exercise_log (
    person     TEXT NOT NULL,
    plan_id    TEXT NOT NULL,
    round      INTEGER NOT NULL,
    week       INTEGER NOT NULL,
    day        TEXT NOT NULL,     -- "Mon" to "Sun"
    slot       TEXT NOT NULL,     -- "cardio", "strength", "morning", ...
    session    TEXT,              -- what the plan said, like "Strength A (about 50 minutes)"
    done_at    INTEGER NOT NULL,  -- when it was first ticked
    PRIMARY KEY (person, plan_id, round, week, day, slot)
  );
  CREATE INDEX exercise_log_by_person ON exercise_log (person, done_at);
  CREATE INDEX measurements_by_person ON measurements (person, kind, date);
  `,
  // 4: the Claude assistant
  `
  CREATE TABLE chats (
    id         INTEGER PRIMARY KEY,
    person     TEXT NOT NULL,     -- whose chat it is
    user       TEXT NOT NULL,     -- the login that started it
    title      TEXT,
    messages   TEXT NOT NULL,     -- the whole conversation, exactly as sent to Claude, as JSON
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX chats_by_person ON chats (person, updated_at);
  CREATE TABLE ai_usage (
    user          TEXT NOT NULL,
    day           TEXT NOT NULL,  -- YYYY-MM-DD
    messages      INTEGER NOT NULL DEFAULT 0,
    input_tokens  INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user, day)
  );
  ALTER TABLE requests ADD COLUMN chat_id INTEGER;
  ALTER TABLE requests ADD COLUMN user TEXT;
  `,
  // 5: accounts that log in with an email address, invite links and password-reset links
  `
  CREATE TABLE accounts (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    hash          TEXT NOT NULL,     -- the password, scrambled with scrypt
    person        TEXT NOT NULL,     -- the person key they tick as
    role          TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    legacy_user   TEXT UNIQUE,       -- the old username this account replaced, if any (keeps its history)
    token_version INTEGER NOT NULL DEFAULT 0,  -- goes up to log this account out everywhere
    ai_key        TEXT,              -- their own Claude API key, encrypted (never stored as plain text)
    created_at    INTEGER NOT NULL,
    created_by    TEXT
  );
  CREATE TABLE invites (
    id         INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE, -- a hash of the link's secret part (the link itself is not stored)
    email      TEXT,                 -- who it is for, if the admin gave an email
    name       TEXT NOT NULL,
    person     TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    created_by TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    account_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  `,

  // Step 6: when someone said they had finished their About me answers (so the family's plan can
  // be drafted once everyone has), and sign-ups waiting for an admin to approve them.
  `
  ALTER TABLE profiles ADD COLUMN finished_at INTEGER;
  CREATE TABLE signups (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    hash       TEXT NOT NULL,
    created_at INTEGER NOT NULL
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

// Copies one person's exercise ticks ({week: ["Mon-cardio", ...]}) into exercise_log, the same way
// syncMeals does: unticked sessions in this round are removed, earlier rounds and plans are kept.
function syncExercise(person, plan, round, ticks, toKey) {
  if (!plan || !Array.isArray(plan.weeks)) return;
  const planId = String(plan.id || 'default');
  const planKey = planKeyFor(plan, person, toKey);
  const now = Date.now();
  const current = new Map();   // "week|Day|slot" -> {week, day, slot}
  for (const [week, ids] of Object.entries(ticks || {})) {
    for (const id of Array.isArray(ids) ? ids : []) {
      const dash = String(id).indexOf('-');
      if (dash < 1) continue;
      const day = String(id).slice(0, dash);
      const slot = String(id).slice(dash + 1);
      current.set(week + '|' + day + '|' + slot, { week: +week, day, slot });
    }
  }
  transaction(d => {
    const existing = d.prepare('SELECT week, day, slot FROM exercise_log WHERE person = ? AND plan_id = ? AND round = ?').all(person, planId, round);
    const remove = d.prepare('DELETE FROM exercise_log WHERE person = ? AND plan_id = ? AND round = ? AND week = ? AND day = ? AND slot = ?');
    for (const r of existing) {
      if (!current.has(r.week + '|' + r.day + '|' + r.slot)) remove.run(person, planId, round, r.week, r.day, r.slot);
    }
    // "INSERT OR IGNORE" keeps the time a session was first ticked.
    const save = d.prepare('INSERT OR IGNORE INTO exercise_log (person, plan_id, round, week, day, slot, session, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const row of current.values()) {
      const exercise = plan.weeks[row.week] && plan.weeks[row.week].exercise;
      if (!exercise) continue;
      const mine = Array.isArray(exercise.days) ? exercise : exercise[planKey];
      const day = mine && Array.isArray(mine.days) ? mine.days.find(x => x.day === row.day) : null;
      save.run(person, planId, round, row.week, row.day, row.slot, day && day[row.slot] ? String(day[row.slot]) : null, now);
    }
  });
}

// ---------- measurements (weigh-ins, steps, imports) ----------

// Saves one measurement, replacing any with the same person, date, kind and source.
function saveMeasurement(person, date, kind, value, unit, source, note) {
  open().prepare(`INSERT INTO measurements (person, date, kind, value, unit, source, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (person, date, kind, source) DO UPDATE SET value = excluded.value, unit = excluded.unit, note = excluded.note, created_at = excluded.created_at`)
    .run(person, date, kind, value, unit || null, source || 'manual', note || null, Date.now());
}

// Saves many measurements at once ([{date, kind, value, unit}]) from one source, in one transaction.
function saveMeasurements(person, source, rows) {
  transaction(() => {
    for (const r of rows) saveMeasurement(person, r.date, r.kind, r.value, r.unit, source, null);
  });
  return rows.length;
}

// One person's measurements since a date (YYYY-MM-DD), oldest first.
function measurements(person, since) {
  return open().prepare('SELECT id, date, kind, value, unit, source, note FROM measurements WHERE person = ? AND date >= ? ORDER BY date, kind').all(person, since);
}

// Deletes a measurement typed in by hand. Returns true if one was deleted.
function deleteMeasurement(person, id) {
  return open().prepare("DELETE FROM measurements WHERE id = ? AND person = ? AND source = 'manual'").run(id, person).changes > 0;
}

// Meals ticked as eaten since a time, with the macros of each dish (for the dashboard).
function eatenMeals(person, sinceMs) {
  return open().prepare(`
    SELECT m.eaten_at, m.dish, m.score, d.macros
    FROM meal_log m LEFT JOIN dishes d ON d.key = lower(m.dish)
    WHERE m.person = ? AND m.eaten = 1 AND m.eaten_at >= ?`).all(person, sinceMs)
    .map(r => Object.assign({}, r, { macros: r.macros ? JSON.parse(r.macros) : null }));
}

// Ratings given since a time (whether or not the meal was ticked as eaten).
function ratingsSince(person, sinceMs) {
  return open().prepare('SELECT updated_at, score FROM meal_log WHERE person = ? AND score IS NOT NULL AND updated_at >= ?').all(person, sinceMs);
}

// Exercise sessions ticked since a time.
function sessionsSince(person, sinceMs) {
  return open().prepare('SELECT done_at, slot, session FROM exercise_log WHERE person = ? AND done_at >= ?').all(person, sinceMs);
}

// ---------- the Claude assistant: chats, requests for changes, and daily usage ----------

function getChat(id) {
  const row = open().prepare('SELECT * FROM chats WHERE id = ?').get(id);
  return row ? Object.assign({}, row, { messages: JSON.parse(row.messages) }) : null;
}

function listChats(person, limit) {
  return open().prepare('SELECT id, person, user, title, created_at, updated_at FROM chats WHERE person = ? ORDER BY updated_at DESC LIMIT ?').all(person, limit || 30);
}

// Saves a chat's messages. Makes a new chat when `id` is empty. Returns the id.
function saveChat(id, person, user, title, messages) {
  const now = Date.now();
  if (id) {
    open().prepare('UPDATE chats SET messages = ?, title = COALESCE(title, ?), updated_at = ? WHERE id = ?').run(JSON.stringify(messages), title || null, now, id);
    return id;
  }
  return Number(open().prepare('INSERT INTO chats (person, user, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(person, user, title || null, JSON.stringify(messages), now, now).lastInsertRowid);
}

function deleteChat(id) {
  open().prepare('DELETE FROM chats WHERE id = ?').run(id);
}

// A suggested change. status: "draft" (only the person sees it), "open" (sent to the admins),
// "done" (applied to the plan), "declined" or "withdrawn" (taken back by the person).
function addRequest(r) {
  return Number(open().prepare('INSERT INTO requests (person, user, chat_id, created_at, title, details, change, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.person, r.user, r.chatId || null, Date.now(), r.title, r.details || null, JSON.stringify(r.change || null), r.status || 'draft').lastInsertRowid);
}

function readRequest(row) {
  return row ? Object.assign({}, row, { change: row.change ? JSON.parse(row.change) : null }) : null;
}

function getRequest(id) {
  return readRequest(open().prepare('SELECT * FROM requests WHERE id = ?').get(id));
}

// Requests: everyone's for admins (all but drafts), or one person's own.
function listRequests(person) {
  const rows = person
    ? open().prepare('SELECT * FROM requests WHERE person = ? ORDER BY created_at DESC LIMIT 100').all(person)
    : open().prepare("SELECT * FROM requests WHERE status != 'draft' ORDER BY (status = 'open') DESC, created_at DESC LIMIT 200").all();
  return rows.map(readRequest);
}

function setRequestChat(id, chatId) {
  open().prepare('UPDATE requests SET chat_id = ? WHERE id = ? AND chat_id IS NULL').run(chatId, id);
}

function setRequestStatus(id, status, by, reply) {
  const decided = status === 'done' || status === 'declined';
  open().prepare('UPDATE requests SET status = ?, decided_by = ?, decided_at = ?, reply = ? WHERE id = ?')
    .run(status, decided ? by : null, decided ? Date.now() : null, reply || null, id);
}

// Adds one assistant message and its tokens to today's count for a login. Returns today's totals.
function countUsage(user, day, inputTokens, outputTokens, messages) {
  open().prepare(`INSERT INTO ai_usage (user, day, messages, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (user, day) DO UPDATE SET messages = messages + excluded.messages,
      input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`)
    .run(user, day, messages || 0, inputTokens || 0, outputTokens || 0);
  return usage(user, day);
}

function usage(user, day) {
  return open().prepare('SELECT messages, input_tokens, output_tokens FROM ai_usage WHERE user = ? AND day = ?').get(user, day)
    || { messages: 0, input_tokens: 0, output_tokens: 0 };
}

// ---------- settings (small values the app remembers) ----------

function getSetting(key) {
  const row = open().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  open().prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function deleteSetting(key) {
  open().prepare('DELETE FROM settings WHERE key = ?').run(key);
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

// ---------- accounts (email logins) ----------

const ACCOUNT_COLUMNS = 'id, email, hash, person, role, legacy_user, token_version, created_at, created_by, ai_key IS NOT NULL AS has_ai_key';

function getAccount(id) {
  return open().prepare('SELECT ' + ACCOUNT_COLUMNS + ' FROM accounts WHERE id = ?').get(id);
}

function accountByEmail(email) {
  return open().prepare('SELECT ' + ACCOUNT_COLUMNS + ' FROM accounts WHERE email = ?').get(String(email || '').trim());
}

function accountByLegacy(user) {
  return open().prepare('SELECT ' + ACCOUNT_COLUMNS + ' FROM accounts WHERE legacy_user = ?').get(user);
}

// Every account, without password hashes.
function listAccounts() {
  return open().prepare("SELECT id, email, person, role, legacy_user, created_at, created_by FROM accounts ORDER BY role = 'owner' DESC, role = 'admin' DESC, email").all();
}

function countAccounts() {
  return open().prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
}

// Adds an account. Returns its id.
function addAccount(a) {
  return Number(open().prepare('INSERT INTO accounts (email, hash, person, role, legacy_user, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(String(a.email).trim(), a.hash, a.person, a.role, a.legacyUser || null, Date.now(), a.createdBy || null).lastInsertRowid);
}

// Changes some of an account's fields: {email, hash, role, person}. Changing the password also
// logs the account out everywhere (token_version goes up).
function updateAccount(id, fields) {
  const sets = [];
  const values = [];
  for (const key of ['email', 'hash', 'role', 'person']) {
    if (fields[key] !== undefined) {
      sets.push(key + ' = ?');
      values.push(fields[key]);
    }
  }
  if (fields.hash !== undefined || fields.logOutEverywhere) sets.push('token_version = token_version + 1');
  if (!sets.length) return;
  open().prepare('UPDATE accounts SET ' + sets.join(', ') + ' WHERE id = ?').run(...values, id);
}

function deleteAccount(id) {
  transaction(d => {
    d.prepare('DELETE FROM password_resets WHERE account_id = ?').run(id);
    d.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  });
}

// Their own Claude API key, encrypted by the caller. `null` removes it.
function setAiKey(id, encrypted) {
  open().prepare('UPDATE accounts SET ai_key = ? WHERE id = ?').run(encrypted, id);
}

function getAiKey(id) {
  const row = open().prepare('SELECT ai_key FROM accounts WHERE id = ?').get(id);
  return row ? row.ai_key : null;
}

// Removes everything kept about one person: About me answers, weigh-ins, meal and exercise history,
// chats and requests. Used when someone deletes their account and asks for their history to go too.
function forgetPerson(person, user) {
  transaction(d => {
    for (const table of ['profiles', 'measurements', 'meal_log', 'exercise_log', 'chats', 'requests']) {
      d.prepare('DELETE FROM ' + table + ' WHERE person = ?').run(person);
    }
    if (user) d.prepare('DELETE FROM ai_usage WHERE user = ?').run(user);
  });
}

// ---------- invite and password-reset links ----------
// Only a hash of each link's secret is stored, so someone who reads the database can't use the links.

function addInvite(i) {
  return Number(open().prepare('INSERT INTO invites (token_hash, email, name, person, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(i.tokenHash, i.email || null, i.name, i.person, i.role, i.createdBy || null, Date.now(), i.expiresAt).lastInsertRowid);
}

function inviteByToken(tokenHash) {
  return open().prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(tokenHash, Date.now());
}

function listInvites() {
  return open().prepare('SELECT id, email, name, person, role, created_by, created_at, expires_at FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(Date.now());
}

function useInvite(id) {
  return open().prepare('UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL').run(Date.now(), id).changes > 0;
}

function deleteInvite(id) {
  open().prepare('DELETE FROM invites WHERE id = ?').run(id);
}

// Cancels the other invites for someone who has just joined.
function deleteInvitesFor(person) {
  open().prepare('DELETE FROM invites WHERE person = ? AND used_at IS NULL').run(person);
}

function addReset(tokenHash, accountId, expiresAt) {
  // A new link replaces any older unused ones for the same account.
  open().prepare('DELETE FROM password_resets WHERE account_id = ? AND used_at IS NULL').run(accountId);
  open().prepare('INSERT INTO password_resets (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(tokenHash, accountId, Date.now(), expiresAt);
}

function resetByToken(tokenHash) {
  return open().prepare('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(tokenHash, Date.now());
}

function useReset(tokenHash) {
  return open().prepare('UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(Date.now(), tokenHash).changes > 0;
}

// ---------- profiles (the getting-started answers) ----------

// A person's answers ({question id: answer}) and when they were saved, or null.
function getProfile(person) {
  const row = open().prepare('SELECT answers, updated_at, finished_at FROM profiles WHERE person = ?').get(person);
  return row ? { answers: JSON.parse(row.answers), updated_at: row.updated_at, finished_at: row.finished_at || null } : null;
}

// Saves a person's answers, replacing what was there.
function saveProfile(person, answers) {
  open().prepare(`INSERT INTO profiles (person, answers, updated_at) VALUES (?, ?, ?)
    ON CONFLICT (person) DO UPDATE SET answers = excluded.answers, updated_at = excluded.updated_at`)
    .run(person, JSON.stringify(answers), Date.now());
}

// ---------- sign-ups waiting for approval ----------

// Saves a sign-up. If one with the same email is already waiting it is left as it is, so nobody
// else can swap in their own password before an admin approves it. Returns true if it was new.
function addSignup(s) {
  return open().prepare('INSERT INTO signups (name, email, hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO NOTHING')
    .run(s.name, s.email, s.hash, Date.now()).changes > 0;
}

// Waiting sign-ups, oldest first, without their password hashes.
function listSignups() {
  return open().prepare('SELECT id, name, email, created_at FROM signups ORDER BY created_at').all();
}

function getSignup(id) {
  return open().prepare('SELECT * FROM signups WHERE id = ?').get(id) || null;
}

function deleteSignup(id) {
  open().prepare('DELETE FROM signups WHERE id = ?').run(id);
}

function countSignups() {
  return open().prepare('SELECT COUNT(*) AS n FROM signups').get().n;
}

// Marks a person's About me answers as finished (or not).
function setProfileFinished(person, finished) {
  if (!getProfile(person)) saveProfile(person, {});
  open().prepare('UPDATE profiles SET finished_at = ? WHERE person = ?').run(finished ? Date.now() : null, person);
}

module.exports = {
  setProfileFinished, addSignup, listSignups, getSignup, deleteSignup, countSignups,
  open, transaction, syncMeals, syncExercise, rememberDishes, history, dishes, dishKey, DB_FILE,
  saveMeasurement, saveMeasurements, measurements, deleteMeasurement, eatenMeals, ratingsSince, sessionsSince, getSetting, setSetting, deleteSetting, planKeyFor,
  getLogin, listLogins, addLogin, setPassword, getProfile, saveProfile,
  getAccount, accountByEmail, accountByLegacy, listAccounts, countAccounts, addAccount, updateAccount, deleteAccount, setAiKey, getAiKey, forgetPerson,
  addInvite, inviteByToken, listInvites, useInvite, deleteInvite, deleteInvitesFor, addReset, resetByToken, useReset,
  getChat, listChats, saveChat, deleteChat, addRequest, getRequest, listRequests, setRequestChat, setRequestStatus, countUsage, usage,
};
