// Logins, using a cookie. No npm packages.
//
// Logins come from environment variables named LOGIN_<USERNAME>=<hash> (make a hash with
// hash-password.js). Usernames are not case-sensitive. Changing someone's password logs them
// out everywhere, because the password hash is part of what signs their login cookie.
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

// The stored password hash for a username, from .env or the database, or undefined.
function hashFor(user) {
  if (USERS[user]) return USERS[user];
  const row = loginFromDb(user);
  return row ? row.hash : undefined;
}

// Describes a login: {user, admin, person}. Each login ticks as a person in the app, set with
// PERSON_<USERNAME>=alex in .env (by default, the username itself), or chosen when it was added.
function who(user) {
  const row = loginFromDb(user);
  const person = String(process.env['PERSON_' + user.toUpperCase()] || (row && row.person) || user).trim().toLowerCase();
  return { user, admin: ADMINS.includes(user) || !!(row && row.admin), person };
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

// Returns the username if the username and password are right, otherwise null.
function checkLogin(user, password) {
  user = String(user || '').trim().toLowerCase();
  const stored = hashFor(user);
  const passwordOk = verify(password, stored || DUMMY);
  return passwordOk && stored ? user : null;
}

// The signature for a cookie: an HMAC of the text, keyed with SECRET and the person's password hash.
function sign(text, user) {
  return crypto.createHmac('sha256', SECRET).update(text + '|' + hashFor(user)).digest('base64url');
}

// Makes the cookie value for a login: "<user>.<expiry time>.<signature>".
function makeToken(user) {
  const unsigned = user + '.' + (Date.now() + MAX_AGE);
  return unsigned + '.' + sign(unsigned, user);
}

// Checks a cookie value. Returns {user, admin, person, exp} if it is genuine and not expired, or null.
function readToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || !hashFor(parts[0])) return null;
  const [user, expires, signature] = parts;
  const want = Buffer.from(sign(user + '.' + expires, user));
  const got = Buffer.from(signature);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const exp = +expires;
  return exp > Date.now() ? Object.assign(who(user), { exp }) : null;
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

// The Set-Cookie text that logs `user` in, or (with no user) logs out by clearing the cookie.
// HttpOnly: page scripts cannot read it. SameSite=Lax: other websites cannot use it to make changes.
// Secure (on HTTPS only): it is never sent unencrypted.
function cookieFor(req, user) {
  const value = user ? makeToken(user) : '';
  const maxAgeSeconds = user ? MAX_AGE / 1000 : 0;
  return COOKIE + '=' + value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAgeSeconds + (isHttps(req) ? '; Secure' : '');
}

// Renews the cookie once a day while the app is used, so active people never get logged out.
function refresh(req, res, s) {
  if (s && s.exp - Date.now() < MAX_AGE - RENEW_AFTER) res.setHeader('Set-Cookie', cookieFor(req, s.user));
}

// Slows down password guessing: 10 wrong tries per address per 15 minutes.
const fails = new Map();   // address -> times of recent wrong passwords
const WINDOW = 15 * 60e3;
const LIMIT = 10;

// The visitor's IP address (Caddy passes the real one in X-Forwarded-For).
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}

// The wrong-password times for an address in the last 15 minutes (older ones are forgotten).
function recent(address) {
  const now = Date.now();
  const times = (fails.get(address) || []).filter(t => now - t < WINDOW);
  if (times.length) fails.set(address, times);
  else fails.delete(address);
  return times;
}

// Where to go after logging in. Only addresses on this site are allowed, so a link like
// /login?next=https://evil.example cannot send people somewhere else.
function safeNext(next) {
  next = String(next || '');
  const isLocal = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\');
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

// Sends a JSON answer with an HTTP status code.
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
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
    json(res, 401, { error: 'login needed' });
  } else {
    res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(safeNext(uri)), 'Cache-Control': 'no-store' });
    res.end();
  }
}

// POST /auth/login: checks the username and password from the login form.
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
  if (s) json(res, 200, { user: s.user, person: s.person, admin: s.admin });
  else json(res, 401, { error: 'login needed' });
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
    json(res, 404, { error: 'not found' });
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

module.exports = {
  handle, session, refresh, hash, verify, exists, isEnvLogin,
  describe: who,                                   // {user, admin, person} for a username
  loginCookie: (req, user) => cookieFor(req, user), // a fresh login cookie, e.g. after a password change
  users: () => Object.keys(USERS),                 // the .env usernames
};
