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

const PLAN_FILE = process.env.PLAN_FILE || '/site/plan.json';
const QUESTIONS_FILE = path.join(path.dirname(PLAN_FILE), 'questions.json');

// Sends a JSON answer with an HTTP status code.
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Reads the JSON the page sent (up to 100 KB).
function body(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (text.length > 1e5) {
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
      const picked = Array.isArray(value) ? q.options.filter(o => value.includes(o)) : [];
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

// Answers the /api/people, /api/profile and /api/password requests. Returns true if it handled one.
async function handle(req, res, urlPath, url, me, ctx) {
  const mine = ['/api/people', '/api/profile', '/api/password'];
  if (!mine.includes(urlPath)) return false;

  // Changes must come from the app itself (a second guard on top of the SameSite cookie).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }

  if (urlPath === '/api/people') {
    if (!me.admin) {
      send(res, 403, { error: 'only an admin can manage people' });
      return true;
    }
    if (req.method === 'GET') {
      send(res, 200, listPeople(ctx));
      return true;
    }
  }

  if (urlPath === '/api/profile') {
    const who = whose(url, me, ctx.people());
    if (who.err) {
      send(res, who.err[0], { error: who.err[1] });
      return true;
    }
    if (req.method === 'GET') {
      const profile = db.getProfile(who.person);
      const ownAppLogin = who.person === me.person && (!!me.accountId || !auth.isEnvLogin(me.user));
      send(res, 200, {
        person: who.person,
        answers: profile ? profile.answers : null,
        updated_at: profile ? profile.updated_at : null,
        canChangePassword: ownAppLogin,
      });
      return true;
    }
    if (req.method === 'PUT') {
      const b = await body(req);
      const answers = cleanAnswers(b.answers);
      db.saveProfile(who.person, answers);
      send(res, 200, { ok: true, answers });
      return true;
    }
  }

  if (urlPath === '/api/password' && req.method === 'POST') {
    const b = await body(req);
    const password = String(b.password || '');
    if (me.accountId) {
      // An email account.
      const account = db.getAccount(me.accountId);
      if (!account || !auth.verify(String(b.current || ''), account.hash)) {
        send(res, 400, { error: 'Your current password is not right.' });
        return true;
      }
      if (password.length < 8 || password.length > 200) {
        send(res, 400, { error: 'The new password needs at least 8 characters.' });
        return true;
      }
      db.updateAccount(me.accountId, { hash: auth.hash(password) });
      res.setHeader('Set-Cookie', auth.loginCookie(req, me.subject));
      send(res, 200, { ok: true });
      return true;
    }
    if (auth.isEnvLogin(me.user)) {
      send(res, 400, { error: 'This login is set in .env on the server, so its password can only be changed there.' });
      return true;
    }
    const login = db.getLogin(me.user);
    if (!login || !auth.verify(String(b.current || ''), login.hash)) {
      send(res, 400, { error: 'Your current password is not right.' });
      return true;
    }
    if (password.length < 8 || password.length > 200) {
      send(res, 400, { error: 'The new password needs at least 8 characters.' });
      return true;
    }
    db.setPassword(me.user, auth.hash(password));
    // Changing the password signs every device out. Log this one back in with a new cookie.
    res.setHeader('Set-Cookie', auth.loginCookie(req, me.subject));
    send(res, 200, { ok: true });
    return true;
  }

  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle, cleanAnswers };
