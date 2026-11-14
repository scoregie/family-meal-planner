// Logins, using a cookie. No npm packages.
//
// There are two kinds of login:
//   - Accounts: an email address and password, kept in the database (data/app.db). The family's
//     owner registers first and invites everyone else (see accounts.js). This is the normal way.
//   - Older usernames: LOGIN_<USERNAME>=<hash> lines in .env, and usernames added from Edit plan
//     before accounts existed. They keep working until the person adds an email address, which
//     turns their username into an account (keeping all their history).
// Usernames and emails are not case-sensitive. Changing a password logs that login out everywhere,
// because the password hash is part of what signs the login cookie.
//
// How a login cookie works:
//   1. The person types their username and password on /login.
//   2. If they are right, the server sends a cookie like "alex.1794101306812.<signature>":
//      the username, when it expires, and a signature only this server can make (with SECRET).
//   3. Every later request carries that cookie. The server re-makes the signature and checks it
//      matches, so nobody can change the username or expiry without being caught.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { send } = require('./requests');   // sending JSON back

const DATA_DIR = process.env.DATA_DIR || '/data';
const COOKIE = 'sl_session';
const ONE_DAY = 864e5;                  // milliseconds in a day (86,400,000)
// Stay logged in for 400 days (the most browsers allow), renewed each day the app is opened,
// so people stay logged in unless they log out or do not open the app for over a year.
const MAX_AGE = 400 * ONE_DAY;
const RENEW_AFTER = ONE_DAY;
// Settings for scrypt, a deliberately slow way to hash passwords so guessing them takes ages.
const SCRYPT = { N: 16384, r: 8, p: 1 };

// Every login from .env: {alex: "scrypt.<salt>.<hash>", ...}. Logins added from the app's
// People tab are kept in the database instead (see loginFromDb below).
const USERS = {};
for (const [name, value] of Object.entries(process.env)) {
  const match = name.match(/^LOGIN_([A-Za-z0-9_]+)$/);
  if (match && value && value.trim()) {
    // Allow the hash to be wrapped in single quotes in .env.
    USERS[match[1].toLowerCase()] = value.trim().replace(/^'(.*)'$/, '$1');
  }
}

// Roles: ADMIN_USERS=admin,... can see and edit everyone's meal and exercise ticks.
const ADMINS = String(process.env.ADMIN_USERS || '')
  .split(',')
  .map(x => x.trim().toLowerCase())
  .filter(Boolean);

// A login added from the app ({username, hash, person, admin}), or undefined.
// The database is loaded only when needed, so a problem with it never stops .env logins working.
function loginFromDb(user) {
  if (USERS[user]) return undefined;   // .env logins always win
  try {
    return require('./db').getLogin(user);
  } catch (e) {
    return undefined;
  }
}

// The database, loaded only when needed.
function database() {
  return require('./db');
}

// An account by its id, or undefined (also if the database can't be read).
function accountById(id) {
  try {
    return database().getAccount(id);
  } catch (e) {
    return undefined;
  }
}

// The account that replaced an old username, if it has been replaced.
function linkedAccount(user) {
  try {
    return database().accountByLegacy(user);
  } catch (e) {
    return undefined;
  }
}

// Cookies name who they are for: "acct-12" for account 12, or an old username like "alex".
// Usernames can't contain "-", so the two never clash.
function accountIdOf(subject) {
  const m = /^acct-(\d+)$/.exec(String(subject || ''));
  return m ? Number(m[1]) : null;
}

// Describes an account the way the rest of the server expects: {user, person, admin, ...}.
// `user` is the old username for a replaced login, so its chats and usage carry on.
function describeAccount(a) {
  return {
    user: a.legacy_user || 'acct-' + a.id,
    subject: 'acct-' + a.id,
    accountId: a.id,
    email: a.email,
    person: a.person,
    role: a.role,
    admin: a.role === 'owner' || a.role === 'admin',
    needsEmail: false,
  };
}

// The stored password hash for an old username, from .env or the database, or undefined.
function hashFor(user) {
  if (USERS[user]) return USERS[user];
  const row = loginFromDb(user);
  return row ? row.hash : undefined;
}

// Describes a login: {user, admin, person}. Each login ticks as a person in the app, set with
// PERSON_<USERNAME>=alex in .env (by default, the username itself), or chosen when it was added.
function who(user) {
  const id = accountIdOf(user);
  if (id) {
    const a = accountById(id);
    return a ? describeAccount(a) : null;
  }
  const linked = linkedAccount(user);
  if (linked) return describeAccount(linked);
  const row = loginFromDb(user);
  const person = String(process.env['PERSON_' + user.toUpperCase()] || (row && row.person) || user).trim().toLowerCase();
  const admin = ADMINS.includes(user) || !!(row && row.admin);
  return { user, subject: user, person, admin, role: admin ? 'admin' : 'member', needsEmail: true };
}

// The secret key that signs login cookies. It is made once at random and kept in
// data/session-secret. Deleting that file logs everyone out.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  } catch (e) {
    // No secret yet. Make one below.
  }
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });   // 0o600: only the owner can read it
  return secret;
}
const SECRET = loadSecret();

// Turns a password into "scrypt.<salt>.<hash>" for .env. The random salt means two people with
// the same password still get different hashes.
function hash(password) {
  const salt = crypto.randomBytes(16);
  const hashed = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return 'scrypt.' + salt.toString('base64url') + '.' + hashed.toString('base64url');
}

// Checks a typed password against a stored hash. True if it matches.
function verify(password, stored) {
  const parts = String(stored || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const want = Buffer.from(parts[2], 'base64url');
  if (!want.length) return false;
  const got = crypto.scryptSync(String(password), Buffer.from(parts[1], 'base64url'), want.length, SCRYPT);
  // timingSafeEqual takes the same time whether the first or last byte differs,
  // so an attacker cannot learn anything from how long the check takes.
  return crypto.timingSafeEqual(got, want);
}

// A hash of a random password, checked when the username does not exist. That way a wrong
// username takes just as long as a wrong password, and does not reveal which usernames exist.
const DUMMY = hash(crypto.randomBytes(12).toString('hex'));

// Checks an email (or old username) and password. Returns who to log in as ("acct-12" or the
// username) if they are right, otherwise null.
function checkLogin(login, password) {
  login = String(login || '').trim().toLowerCase();
  let stored;
  let subject;
  if (login.includes('@')) {
    let a;
    try {
      a = database().accountByEmail(login);
    } catch (e) {
      a = undefined;
    }
    if (a) [stored, subject] = [a.hash, 'acct-' + a.id];
  } else {
    // An old username that has become an account uses the account's password from then on.
    // A child's account can use a username instead of an email (stored in the email column).
    const linked = linkedAccount(login);
    let named;
    try {
      named = database().accountByEmail(login);
    } catch (e) {
      named = undefined;
    }
    if (linked) [stored, subject] = [linked.hash, 'acct-' + linked.id];
    else if (named) [stored, subject] = [named.hash, 'acct-' + named.id];
    else if (hashFor(login)) [stored, subject] = [hashFor(login), login];
  }
  const passwordOk = verify(password, stored || DUMMY);
  return passwordOk && stored ? subject : null;
}

// What goes into a cookie's signature besides the text: the password hash (and, for accounts, a
// counter that goes up to log out everywhere). Null if the login no longer exists, or is an old
// username that has been replaced by an account (so its old cookies stop working).
function signingKeyFor(subject) {
  const id = accountIdOf(subject);
  if (id) {
    const a = accountById(id);
    return a ? a.hash + '|' + a.token_version : null;
  }
  if (linkedAccount(subject)) return null;
  return hashFor(subject) || null;
}

// The signature for a cookie: an HMAC of the text, keyed with SECRET and the login's signing key.
function sign(text, subject) {
  return crypto.createHmac('sha256', SECRET).update(text + '|' + signingKeyFor(subject)).digest('base64url');
}

// Makes the cookie value for a login: "<who>.<expiry time>.<signature>".
function makeToken(subject) {
  const unsigned = subject + '.' + (Date.now() + MAX_AGE);
  return unsigned + '.' + sign(unsigned, subject);
}

// Checks a cookie value. Returns {user, subject, admin, person, role, exp, ...} if it is genuine and
// not expired, or null.
function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !signingKeyFor(parts[0])) return null;
  const [user, expires, signature] = parts;
  const want = Buffer.from(sign(user + '.' + expires, user));
  const got = Buffer.from(signature);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const exp = +expires;
  const described = exp > Date.now() ? who(user) : null;
  return described ? Object.assign(described, { exp }) : null;
}

// Reads the request's cookies into an object: {sl_session: "...", ...}.
function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(cookie => {
    const equals = cookie.indexOf('=');
    if (equals > 0) out[cookie.slice(0, equals).trim()] = cookie.slice(equals + 1).trim();
  });
  return out;
}

// Who is making this request, or null if they are not logged in.
function session(req) {
  return readToken(cookies(req)[COOKIE]);
}

// True if the visitor reached us over HTTPS (Caddy or a proxy tells us in X-Forwarded-Proto).
function isHttps(req) {
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

// The Set-Cookie text that logs `subject` ("acct-12" or an old username) in, or (with no user) logs out by clearing the cookie.
// HttpOnly: page scripts cannot read it. SameSite=Lax: other websites cannot use it to make changes.
// Secure (on HTTPS only): it is never sent unencrypted.
function cookieFor(req, subject) {
  const value = subject ? makeToken(subject) : '';
  const maxAgeSeconds = subject ? MAX_AGE / 1000 : 0;
  return COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSeconds + (isHttps(req) ? '; Secure' : '');
}

// Renews the cookie once a day while the app is used, so active people never get logged out.
function refresh(req, res, s) {
  if (s && s.exp - Date.now() < MAX_AGE - RENEW_AFTER) res.setHeader('Set-Cookie', cookieFor(req, s.subject));
}

// Slows down password guessing: 10 wrong tries per address per 15 minutes.
const fails = new Map();   // address -> times of recent wrong passwords
const WINDOW = 15 * 60e3;
const LIMIT = 10;

// The visitor's IP address. Caddy works it out (skipping trusted proxies, see the Caddyfile)
// and sends it as X-Real-IP, replacing anything the visitor sent. X-Forwarded-For isn't used:
// its first entry is whatever the visitor put there.
function clientIp(req) {
  return String(req.headers['x-real-ip'] || '').trim().slice(0, 64) || req.socket.remoteAddress || '?';
}

// The wrong-password times for an address in the last 15 minutes (older ones are forgotten).
function recent(address) {
  const now = Date.now();
  const times = (fails.get(address) || []).filter(t => now - t < WINDOW);
  if (times.length) fails.set(address, times);
  else fails.delete(address);
  // Now and then, forget addresses whose wrong passwords are all old, so the list can't grow forever.
  if (fails.size > 1000) for (const [a, t] of fails) if (!t.some(x => now - x < WINDOW)) fails.delete(a);
  return times;
}

// Where to go after logging in. Only addresses on this site are allowed, so a link like
// /login?next=https://evil.example cannot send people somewhere else.
function safeNext(next) {
  next = String(next || '');
  // Browsers ignore tabs and line breaks in addresses and treat a backslash like "/", so "/<tab>/evil.example"
  // would leave the site: any of those characters means "go home" instead.
  const isLocal = next.startsWith('/') && !next.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(next);
  if (!isLocal || /^\/(login|auth)\b/.test(next)) return '/';
  return next;
}

// Reads a submitted login form (username=...&password=...). Gives up past 4 KB.
function readForm(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (text.length > 4096) {
        reject(new Error('big'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(new URLSearchParams(text)));
  });
}

// Sends the browser to another address, optionally setting a cookie on the way.
function redirect(res, location, cookie) {
  const headers = { Location: location, 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(303, headers);
  res.end();
}

// GET /auth/check: Caddy asks this before serving any protected file.
// Logged in: 200 (Caddy serves the file). Not logged in: send them to the login page.
function authCheck(req, res) {
  const s = session(req);
  if (s) {
    res.writeHead(200, { 'X-Auth-User': s.user, 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }
  const uri = String(req.headers['x-forwarded-uri'] || '/');
  if (uri.startsWith('/api/')) {
    send(res, 401, { error: 'login needed' });
  } else {
    res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(safeNext(uri)), 'Cache-Control': 'no-store' });
    res.end();
  }
}

// POST /auth/login: checks the email (or old username) and password from the login form.
async function login(req, res) {
  const form = await readForm(req);
  const next = safeNext(form.get('next'));
  const keepNext = '&next=' + encodeURIComponent(next);
  const ip = clientIp(req);
  if (recent(ip).length >= LIMIT) return redirect(res, '/login?e=locked' + keepNext);
  const user = checkLogin(form.get('username'), form.get('password') || '');
  if (!user) {
    fails.set(ip, recent(ip).concat(Date.now()));
    return redirect(res, '/login?e=1' + keepNext);
  }
  fails.delete(ip);
  redirect(res, next, cookieFor(req, user));
}

// GET /auth/me: tells the page who is logged in.
function me(req, res) {
  const s = session(req);
  refresh(req, res, s);
  if (s) send(res, 200, { user: s.user, person: s.person, admin: s.admin, role: s.role, email: s.email || null, needsEmail: !!s.needsEmail });
  else send(res, 401, { error: 'login needed' });
}

// Handles /auth/*. Returns true if it answered the request.
async function handle(req, res, urlPath) {
  if (urlPath === '/auth/check') {
    authCheck(req, res);
    return true;
  }
  if (urlPath === '/auth/login' && req.method === 'POST') {
    await login(req, res);
    return true;
  }
  if (urlPath === '/auth/logout') {
    redirect(res, '/login?out=1', cookieFor(req, null));
    return true;
  }
  if (urlPath === '/auth/me') {
    me(req, res);
    return true;
  }
  if (urlPath.startsWith('/auth/')) {
    send(res, 404, { error: 'not found' });
    return true;
  }
  return false;
}

// True if a username is already taken (in .env or the database).
function exists(user) {
  return !!hashFor(String(user || '').toLowerCase());
}

// True if a login comes from .env (its password can only be changed there).
function isEnvLogin(user) {
  return !!USERS[user];
}

// True if an old username has been replaced by an account.
function isLinked(user) {
  return !!linkedAccount(user);
}

module.exports = {
  handle, session, refresh, hash, verify, exists, isEnvLogin, isLinked, checkLogin, hashFor,
  clientIp, recent, fails, LIMIT,
  describe: who,                                         // {user, admin, person, ...} for a username or "acct-12"
  loginCookie: (req, subject) => cookieFor(req, subject), // a fresh login cookie, e.g. after a password change
  logoutCookie: req => cookieFor(req, null),
  users: () => Object.keys(USERS),                       // the .env usernames
};
