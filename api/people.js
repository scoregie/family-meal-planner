// People, logins and the "About me" questions.
//
//   GET  /api/people              admins: everyone in the plan, their logins and whether they've answered the questions
//   GET  /api/profile?person=...  your own answers (admins: anyone's)
//   PUT  /api/profile?person=...  save answers
//   POST /api/password            change your own password (email accounts and usernames added from the app)
//
// New people are invited from the Family page (see accounts.js).
//
// Answers include health details, so only the person and admins can see them.
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const db = require('./db');
const { send, readBody } = require('./requests');   // reading what a page sent, and sending JSON back

const PLAN_FILE = process.env.PLAN_FILE || '/site/plan.json';
const QUESTIONS_FILE = path.join(path.dirname(PLAN_FILE), 'questions.json');

// Every question in site/questions.json, by id: {goal: {id, label, type, options, ...}, ...}.
function questionsById() {
  const all = {};
  const file = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
  for (const section of file.sections) {
    for (const q of section.questions) all[q.id] = q;
  }
  return all;
}

// Keeps only answers that fit their question: text up to 2000 characters, numbers within range,
// and choices from the list. Anything else (or an empty answer) is dropped.
function cleanAnswers(answers) {
  const questions = questionsById();
  const out = {};
  if (!answers || typeof answers !== 'object') return out;
  for (const [id, value] of Object.entries(answers)) {
    const q = questions[id];
    if (!q) continue;
    if (q.type === 'text' || q.type === 'long') {
      if (typeof value === 'string' && value.trim()) out[id] = value.slice(0, 2000);
    } else if (q.type === 'number') {
      const n = Number(value);
      const inRange = value !== '' && value !== null && Number.isFinite(n) && (q.min == null || n >= q.min) && (q.max == null || n <= q.max);
      if (inRange) out[id] = n;
    } else if (q.type === 'choice') {
      if (q.options.includes(value)) out[id] = value;
    } else if (q.type === 'multi') {
      // An answer saved before the question allowed several choices is a single string.
      const list = typeof value === 'string' ? [value] : value;
      const picked = Array.isArray(list) ? q.options.filter(o => list.includes(o)) : [];
      if (picked.length) out[id] = picked;
    }
  }
  return out;
}

// Works out whose profile a request is for, and refuses anyone else's unless you are an admin.
function whose(url, me, people) {
  const person = String(url.searchParams.get('person') || me.person || '').toLowerCase();
  if (!people.includes(person)) return { err: [404, 'unknown person'] };
  if (!me.admin && person !== me.person) return { err: [403, 'you can only see your own answers'] };
  return { person };
}

// Everyone in the plan, with their logins and whether they have answered the questions.
// `ctx` gives the server's helpers: readPlan(), toKey().
function listPeople(ctx) {
  const plan = ctx.readPlan() || {};
  const block = plan.people || {};
  const logins = [];
  // Email accounts, then older usernames that haven't been turned into accounts yet.
  for (const a of db.listAccounts()) {
    logins.push({ username: a.legacy_user || a.email, email: a.email, person: a.person, admin: a.role !== 'member', role: a.role, source: 'account', created_at: a.created_at });
  }
  for (const username of auth.users()) {
    if (auth.isLinked(username)) continue;
    const w = auth.describe(username);
    logins.push({ username, person: w.person, admin: w.admin, source: '.env' });
  }
  for (const row of db.listLogins()) {
    if (auth.isLinked(row.username)) continue;
    logins.push({ username: row.username, person: row.person, admin: !!row.admin, source: 'app', created_at: row.created_at });
  }
  const people = Object.keys(block)
    .filter(key => block[key] && typeof block[key] === 'object' && block[key].name)
    .map(key => {
      const person = ctx.toKey(block[key].name);
      const profile = db.getProfile(person);
      return {
        key,
        person,
        name: block[key].name,
        portion: block[key].portion,
        logins: logins.filter(l => l.person === person),
        answered: profile ? profile.updated_at : null,
      };
    });
  const known = new Set(people.map(p => p.person));
  return { people, otherLogins: logins.filter(l => !known.has(l.person)) };
}

// GET /api/profile?person=: a person's About me answers.
function sendProfile(res, me, person) {
  const profile = db.getProfile(person);
  const ownAppLogin = person === me.person && (!!me.accountId || !auth.isEnvLogin(me.user));
  send(res, 200, {
    person,
    answers: profile ? profile.answers : null,
    updated_at: profile ? profile.updated_at : null,
    finished_at: profile ? profile.finished_at : null,
    canChangePassword: ownAppLogin,
  });
}

// PUT /api/profile?person= {answers}: saves a person's About me answers.
async function saveProfile(req, res, person) {
  const b = await readBody(req, 1e5);
  // {finished: true/false} alone marks the answers finished (or not) without changing them.
  if (typeof b.finished === 'boolean' && b.answers === undefined) {
    db.setProfileFinished(person, b.finished);
    return send(res, 200, { ok: true, finished_at: db.getProfile(person).finished_at });
  }
  const answers = cleanAnswers(b.answers);
  db.saveProfile(person, answers);
  send(res, 200, { ok: true, answers });
}

// POST /api/password {current, password}: changes the logged-in person's own password.
async function changePassword(req, res, me) {
  const b = await readBody(req, 1e5);
  const password = String(b.password || '');
  const account = me.accountId ? db.getAccount(me.accountId) : null;   // an email account
  if (!me.accountId && auth.isEnvLogin(me.user)) {
    return send(res, 400, { error: 'This login is set in .env on the server, so its password can only be changed there.' });
  }
  const login = me.accountId ? account : db.getLogin(me.user);
  if (!login || !auth.verify(String(b.current || ''), login.hash)) return send(res, 400, { error: 'Your current password is not right.' });
  if (password.length < 8 || password.length > 200) return send(res, 400, { error: 'The new password needs at least 8 characters.' });
  if (me.accountId) db.updateAccount(me.accountId, { hash: auth.hash(password) });
  else db.setPassword(me.user, auth.hash(password));
  // Changing the password signs every device out. Log this one back in with a new cookie.
  res.setHeader('Set-Cookie', auth.loginCookie(req, me.subject));
  send(res, 200, { ok: true });
}

// Answers the /api/people, /api/profile and /api/password requests. Returns true if it handled one.
async function handle(req, res, urlPath, url, me, ctx) {
  const mine = ['/api/people', '/api/profile', '/api/password'];
  if (!mine.includes(urlPath)) return false;
  const what = req.method + ' ' + urlPath;
  const who = urlPath === '/api/profile' ? whose(url, me, ctx.people()) : {};

  // Changes must come from the app itself (a second guard on top of the SameSite cookie).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') send(res, 403, { error: 'bad request' });
  else if (urlPath === '/api/people' && !me.admin) send(res, 403, { error: 'only an admin can manage people' });
  else if (what === 'GET /api/people') send(res, 200, listPeople(ctx));
  else if (who.err) send(res, who.err[0], { error: who.err[1] });
  else if (what === 'GET /api/profile') sendProfile(res, me, who.person);
  else if (what === 'PUT /api/profile') await saveProfile(req, res, who.person);
  else if (what === 'POST /api/password') await changePassword(req, res, me);
  else send(res, 404, { error: 'not found' });
  return true;
}
module.exports = { handle, cleanAnswers };
