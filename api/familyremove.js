// "Remove from the family" and "Bring back", on the Family page (admins).
//
// Removing someone takes them out of the plan (their portion, snacks, exercise and their own meal
// changes) and out of the app's records (About me answers, weigh-ins, ticks, chats, requests,
// settings and uploaded files), so a new plan can be drafted without them. Nothing is lost: first,
// everything is saved to a folder in data/archived-people/, and "Bring back" puts it all back.
//
// Someone with a login (or a waiting invite) has to have it removed first, on the same page, so
// nobody can still log in as a person who isn't in the plan.
//
//   POST /api/family/person/<person>/remove   admins: save everything about them, then remove them
//   POST /api/family/removed/<id>/restore     admins: put a removed person back
//   (the list of removed people comes with GET /api/family, from list() below)
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const db = require('./db');
const uploads = require('./uploads');
const { send } = require('./requests');

const DATA_DIR = process.env.DATA_DIR || '/data';
const ARCHIVE_ROOT = path.join(DATA_DIR, 'archived-people');
const TABLES = ['profiles', 'measurements', 'meal_log', 'exercise_log', 'chats', 'requests'];   // each has a "person" column

// ---------------------------------------------------------------------------
// Finding someone's things
// ---------------------------------------------------------------------------

// The plan's key for a person ("sister" for Shannon), or null if they aren't in the plan.
function planKeyOf(plan, person, ctx) {
  return Object.keys((plan && plan.people) || {}).find(k => plan.people[k] && plan.people[k].name && ctx.toKey(plan.people[k].name) === person) || null;
}

// Whether a settings key belongs to this person, like "cardio-feel:sam" or "import:sam:lose-it".
function settingIsTheirs(key, value, person) {
  if (key.endsWith(':' + person)) return true;
  if (key.startsWith('import:' + person + ':')) return true;
  return key.startsWith('healthsync:') && value === person;   // their Health sync key points at them
}

// Every settings row that belongs to this person.
function theirSettings(person) {
  return db.open().prepare('SELECT key, value FROM settings').all().filter(r => settingIsTheirs(r.key, r.value, person));
}

// Why someone can't be removed yet ("Remove their login first"), or "" if they can be.
function blockedBecause(person, name, me, plan) {
  if (person === me.person) return 'You can’t remove yourself here. To leave, use Delete my account on the Account page.';
  if (db.listAccounts().some(a => a.person === person)) return name + ' has a login. Remove it under Logins first, then remove them from the family.';
  const older = auth.users().concat(db.listLogins().map(l => l.username)).some(u => auth.describe(u).person === person);
  if (older) return name + ' still has an older username login. Remove it on the Edit plan page first.';
  if (db.listInvites().some(i => i.person === person)) return name + ' has an invite waiting. Cancel it first.';
  if (Object.keys(plan.people || {}).length <= 1) return name + ' is the only person in the plan.';
  return '';
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

// Takes one person out of a plan (in place) and gives back what was taken, so it can be put back.
// They're in: people, the plan's exercise block, each week's exercise, and each day's own meals.
function takeOutOfPlan(plan, key) {
  const taken = { key, person: plan.people[key], exercise: undefined, weeks: {} };
  delete plan.people[key];
  if (plan.exercise && plan.exercise[key] !== undefined) {
    taken.exercise = plan.exercise[key];
    delete plan.exercise[key];
  }
  (plan.weeks || []).forEach((week, w) => {
    const mine = { exercise: undefined, days: {} };
    if (week.exercise && week.exercise[key] !== undefined) {
      mine.exercise = week.exercise[key];
      delete week.exercise[key];
    }
    (week.meals || []).forEach((day, d) => {
      if (day.people && day.people[key] !== undefined) {
        mine.days[d] = day.people[key];
        delete day.people[key];
        if (!Object.keys(day.people).length) delete day.people;
      }
    });
    if (mine.exercise !== undefined || Object.keys(mine.days).length) taken.weeks[w] = mine;
  });
  return taken;
}

// Puts back what takeOutOfPlan took. Their portion, snacks and tips always go back. Their exercise
// and their own meals only go back into the same plan they came from (`samePlan`): a newer plan's
// weeks are different, so drafting a new plan gives them those.
function putBackInPlan(plan, taken, samePlan) {
  plan.people = plan.people || {};
  let key = taken.key;
  let n = 2;
  while (plan.people[key]) key = taken.key + '-' + n++;
  plan.people[key] = taken.person;
  if (!samePlan) return;
  if (taken.exercise !== undefined) plan.exercise = Object.assign(plan.exercise || {}, { [key]: taken.exercise });
  for (const [w, mine] of Object.entries(taken.weeks || {})) {
    const week = (plan.weeks || [])[w];
    if (!week) continue;
    if (mine.exercise !== undefined) week.exercise = Object.assign(week.exercise || {}, { [key]: mine.exercise });
    for (const [d, meals] of Object.entries(mine.days || {})) {
      const day = (week.meals || [])[d];
      if (day) day.people = Object.assign(day.people || {}, { [key]: meals });
    }
  }
}

// ---------------------------------------------------------------------------
// Removing and bringing back
// ---------------------------------------------------------------------------

// A folder name for one removal, like "2026-11-23-shannon".
function archiveId(person) {
  let id = new Date().toISOString().slice(0, 10) + '-' + person;
  let n = 2;
  while (fs.existsSync(path.join(ARCHIVE_ROOT, id))) id = new Date().toISOString().slice(0, 10) + '-' + person + '-' + n++;
  return id;
}

// Saves everything about one person to data/archived-people/<id>/, then removes them from the
// plan and the records. Gives back the archive's id.
function remove(person, me, ctx) {
  const plan = ctx.readPlan();
  const key = planKeyOf(plan, person, ctx);
  const id = archiveId(person);
  const dir = path.join(ARCHIVE_ROOT, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // 1. Save: their records, their settings, their part of the plan, and their uploaded files.
  const rows = {};
  for (const table of TABLES) rows[table] = db.open().prepare('SELECT * FROM ' + table + ' WHERE person = ?').all(person);
  const settings = theirSettings(person);
  const taken = takeOutOfPlan(plan, key);
  const files = path.join(uploads.ROOT, person);
  const hasFiles = fs.existsSync(files);
  if (hasFiles) fs.cpSync(files, path.join(dir, 'uploads'), { recursive: true });
  const archive = { id, person, name: taken.person.name, removedAt: Date.now(), removedBy: me.user, planId: plan.id || null, plan: taken, rows, settings, hasFiles };
  fs.writeFileSync(path.join(dir, 'archive.json'), JSON.stringify(archive, null, 1), { mode: 0o600 });

  // 2. Remove: only once the copy is safely written.
  ctx.savePlan(plan);   // keeps a dated copy of the old plan in data/plan-backups too
  db.transaction(d => { for (const s of settings) d.prepare('DELETE FROM settings WHERE key = ?').run(s.key); });
  db.forgetPerson(person);
  uploads.forget(person);
  return id;
}

// Reads one removal's saved copy, or null if there isn't one with that id.
function readArchive(id) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+$/.test(String(id || ''))) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(ARCHIVE_ROOT, id, 'archive.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

// Puts one saved row back into its table.
function putRowBack(d, table, row) {
  const cols = Object.keys(row);
  d.prepare('INSERT OR REPLACE INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')').run(...cols.map(c => row[c]));
}

// Puts a removed person back: into the plan, their records and files. Their saved copy is then
// deleted, as it's all back in the app.
function restore(archive, ctx) {
  const plan = ctx.readPlan();
  putBackInPlan(plan, archive.plan, (plan.id || null) === archive.planId);
  ctx.savePlan(plan);
  db.transaction(d => {
    for (const [table, rows] of Object.entries(archive.rows || {})) if (TABLES.includes(table)) for (const row of rows) putRowBack(d, table, row);
    for (const s of archive.settings || []) putRowBack(d, 'settings', s);
  });
  const dir = path.join(ARCHIVE_ROOT, archive.id);
  if (archive.hasFiles && fs.existsSync(path.join(dir, 'uploads'))) fs.cpSync(path.join(dir, 'uploads'), path.join(uploads.ROOT, archive.person), { recursive: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

// Everyone who has been removed, newest first: [{id, person, name, removedAt}], for the Family page.
function list() {
  let ids = [];
  try { ids = fs.readdirSync(ARCHIVE_ROOT); } catch (e) { return []; }
  return ids.map(readArchive).filter(Boolean)
    .map(a => ({ id: a.id, person: a.person, name: a.name, removedAt: a.removedAt }))
    .sort((a, b) => b.removedAt - a.removedAt);
}

// ---------------------------------------------------------------------------
// Requests (accounts.js has already checked the person asking is an admin)
// ---------------------------------------------------------------------------

// Answers the two requests above. Returns true if it handled the request.
function handle(req, res, urlPath, me, ctx) {
  const rm = urlPath.match(/^\/api\/family\/person\/([a-z0-9-]+)\/remove$/);
  if (rm && req.method === 'POST') {
    const person = rm[1];
    const plan = ctx.readPlan();
    const key = plan && planKeyOf(plan, person, ctx);
    if (!key) { send(res, 404, { error: 'That person isn’t in the plan.' }); return true; }
    const why = blockedBecause(person, plan.people[key].name, me, plan);
    if (why) { send(res, 409, { error: why }); return true; }
    send(res, 200, { ok: true, id: remove(person, me, ctx) });
    return true;
  }
  const rs = urlPath.match(/^\/api\/family\/removed\/([a-z0-9-]+)\/restore$/);
  if (rs && req.method === 'POST') {
    const archive = readArchive(rs[1]);
    if (!archive) { send(res, 404, { error: 'That saved copy wasn’t found.' }); return true; }
    if (ctx.people().includes(archive.person)) { send(res, 409, { error: 'Someone called ' + archive.name + ' is already in the family.' }); return true; }
    restore(archive, ctx);
    send(res, 200, { ok: true });
    return true;
  }
  return false;
}

module.exports = { handle, list, takeOutOfPlan, putBackInPlan, ARCHIVE_ROOT };
