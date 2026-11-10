// Accounts: logging in with an email address, for one family per server.
//
// How it works:
//   1. On a new server, the first visitor registers as the family's owner (the login page shows
//      "Create your family's account"). Registering closes after that.
//   2. The owner and admins invite people from the Family page. Each invite is a link, valid for
//      7 days, that they share themselves (or that is emailed, if email is set up; see mailer.js).
//   3. The invited person opens the link, chooses a password, and is logged in.
//   4. Forgotten passwords: an admin makes a reset link from the Family page (or, with email set
//      up, "Forgot password?" on the login page emails one).
// Older usernames (.env and Edit plan) keep working until the person adds their email, which turns
// the username into an account and keeps all their history.
//
// Roles: the owner (one, can't be removed), admins (edit the plan, manage members) and members.
// Only the owner can make or remove admins, or hand over ownership.
//
// Public (no login needed):
//   GET  /auth/status              does this server still need its first account? is email set up?
//   POST /auth/register            {email, password, name}: the first account (the owner)
//   GET  /auth/invite?t=           what an invite link is for
//   POST /auth/join                {t, password, email?}: accept an invite
//   POST /auth/forgot              {email}: email a reset link (only if email is set up)
//   GET  /auth/reset?t=            is a reset link still valid?
//   POST /auth/reset               {t, password}: set a new password
// Logged in:
//   GET  /api/account              your account
//   POST /api/account/email        {email, password}: add or change your email
//   POST /api/account/logout-everywhere
//   POST /api/account/delete       {password, history}: delete your account (and, if asked, your history)
//   PUT  /api/account/ai-key       {key}: save your own Claude API key (checked, then stored encrypted)
//   DELETE /api/account/ai-key     remove it
//   GET  /api/family               admins: everyone's logins, and invites waiting to be used
//   POST /api/family/invite        admins: {name, email?, role, person?, portion?} -> {link}
//   DELETE /api/family/invite?id=  admins: cancel an invite
//   POST /api/family/member/<id>   {role}: change a role ("owner" hands over ownership)
//   POST /api/family/member/<id>/reset   admins: make a password-reset link for someone
//   DELETE /api/family/member/<id> admins: remove someone's login
const crypto = require('crypto');
const auth = require('./auth');
const db = require('./db');
const mailer = require('./mailer');
const secrets = require('./secrets');
const uploads = require('./uploads');

const DAY = 864e5;
const INVITE_DAYS = 7;
const RESET_HOURS_EMAILED = 1;
const RESET_HOURS_SHARED = 24;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;

function send(res, code, obj, cookie) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (text.length > 1e4) {
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

// A new random link secret, and the hash that is stored instead of it.
function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return EMAIL.test(e) && e.length <= 200 ? e : '';
}

// True if a name has at least one letter or number (so it makes a usable person key).
function goodName(name) {
  return /[a-z0-9]/i.test(String(name || ''));
}

function passwordProblem(password) {
  const p = String(password || '');
  if (p.length < 8) return 'The password needs at least 8 characters.';
  if (p.length > 200) return 'That password is too long.';
  return '';
}

// Slows down guessing on the public routes: the same 10 tries per address per 15 minutes as logging in.
function tooMany(req) {
  return auth.recent(auth.clientIp(req)).length >= auth.LIMIT;
}

function countTry(req) {
  const ip = auth.clientIp(req);
  auth.fails.set(ip, auth.recent(ip).concat(Date.now()));
}

// True on a brand-new server: no accounts and no older usernames yet.
function needsSetup() {
  return db.countAccounts() === 0 && auth.users().length === 0 && db.listLogins().length === 0;
}

function hasOwner() {
  return db.listAccounts().some(a => a.role === 'owner');
}

// Makes sure a person is in the plan's "people" block (adding them with a normal serve if not).
// Returns their person key ("sam").
function ensurePerson(name, portion, ctx) {
  const person = ctx.toKey(name);
  if (!person) return '';
  const plan = ctx.readPlan();
  if (!plan) return person;
  plan.people = plan.people && typeof plan.people === 'object' ? plan.people : {};
  const already = Object.keys(plan.people).some(k => plan.people[k] && plan.people[k].name && ctx.toKey(plan.people[k].name) === person);
  if (!already) {
    let key = person;
    let n = 2;
    while (plan.people[key]) key = person + '-' + n++;
    plan.people[key] = { name, portion: Number.isFinite(portion) ? portion : 1 };
    ctx.savePlan(plan);
  }
  return person;
}

// The person's name from the plan, for invites and emails.
function nameOf(person, ctx) {
  const plan = ctx.readPlan() || {};
  const found = Object.values(plan.people || {}).find(p => p && p.name && ctx.toKey(p.name) === person);
  return found ? found.name : person;
}

// ---------------------------------------------------------------------------
// Public routes
// ---------------------------------------------------------------------------

async function register(req, res, ctx) {
  if (!needsSetup()) return send(res, 403, { error: 'This family already has an account. Ask its owner for an invite.' });
  if (tooMany(req)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes, then try again.' });
  const b = await body(req);
  const email = cleanEmail(b.email);
  const name = String(b.name || '').trim().slice(0, 40);
  if (!email) return send(res, 400, { error: 'Enter a valid email address.' });
  if (!goodName(name)) return send(res, 400, { error: 'Enter your name (with at least one letter or number).' });
  const bad = passwordProblem(b.password);
  if (bad) return send(res, 400, { error: bad });
  const person = ensurePerson(name, 1, ctx);
  if (!person) return send(res, 400, { error: 'Enter a name with at least one letter or number.' });
  // Check again just before saving, in case two people registered at the same moment.
  if (!needsSetup()) return send(res, 403, { error: 'This family already has an account.' });
  const id = db.addAccount({ email, hash: auth.hash(b.password), person, role: 'owner', createdBy: 'register' });
  // The household's country, chosen on the first-account form (it can be changed on Plan setup).
  require('./appearance').setCountry(String(b.country || ''));
  return send(res, 200, { ok: true }, auth.loginCookie(req, 'acct-' + id));
}

// Signing up without an invite. On a brand-new server that makes the owner (like register).
// Otherwise the sign-up waits for an admin to approve it on the Family page, so someone who
// finds the address can't just let themselves in.
async function signup(req, res, ctx) {
  if (needsSetup()) return register(req, res, ctx);
  if (tooMany(req)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes, then try again.' });
  countTry(req);   // every sign-up counts towards the limit, so it can't be used to flood the list
  const b = await body(req);
  const email = cleanEmail(b.email);
  const name = String(b.name || '').trim().slice(0, 40);
  if (!goodName(name)) return send(res, 400, { error: 'Enter your name (with at least one letter or number).' });
  if (!email) return send(res, 400, { error: 'Enter a valid email address.' });
  const bad = passwordProblem(b.password);
  if (bad) return send(res, 400, { error: bad });
  if (db.accountByEmail(email)) return send(res, 409, { error: 'There’s already an account with that email. Log in instead.' });
  if (db.countSignups() >= 20) return send(res, 429, { error: 'There are too many sign-ups waiting. Ask someone in your family for an invite link.' });
  // Already waiting: answer the same way (so this can't be used to see who signed up), change nothing.
  if (!db.addSignup({ name, email, hash: auth.hash(b.password) })) return send(res, 200, { ok: true, pending: true });
  if (mailer.configured()) {
    const admins = db.listAccounts().filter(a => a.role !== 'member');
    for (const a of admins) {
      await mailer.send(a.email, name + ' would like to join the Family Health Planner',
        name + ' (' + email + ') signed up to join your family’s planner.\n\nIf you know them, approve them on the Family page:\n' + mailer.link('/family.html') +
        '\n\nIf you don’t, decline it there and nothing else happens.');
    }
  }
  return send(res, 200, { ok: true, pending: true });
}

// An admin approving or declining a sign-up.
async function decideSignup(req, res, me, ctx, id) {
  const b = await body(req);
  const s = db.getSignup(id);
  if (!s) return send(res, 404, { error: 'That sign-up has already been dealt with.' });
  if (b.action === 'decline') {
    db.deleteSignup(id);
    return send(res, 200, { ok: true });
  }
  if (b.action !== 'approve') return send(res, 400, { error: 'bad request' });
  const role = b.role === 'admin' ? 'admin' : 'member';
  if (role === 'admin' && me.role !== 'owner') return send(res, 403, { error: 'Only the owner can make admins.' });
  if (db.accountByEmail(s.email)) {
    db.deleteSignup(id);
    return send(res, 409, { error: 'There’s already an account with that email.' });
  }
  const person = ctx.toKey(s.name);
  if (db.listAccounts().some(a => a.person === person)) {
    return send(res, 409, { error: 'Someone called ' + s.name + ' already has a login. Decline this one and send them an invite with a different name (like “' + s.name + ' B”).' });
  }
  ensurePerson(s.name, 1, ctx);
  db.addAccount({ email: s.email, hash: s.hash, person, role, createdBy: me.user });
  db.deleteSignup(id);
  db.deleteInvitesFor(person);
  if (mailer.configured()) {
    await mailer.send(s.email, 'You’re in: Family Health Planner',
      'Your family has approved your sign-up. Log in with this email and the password you chose:\n' + mailer.link('/login'));
  }
  return send(res, 200, { ok: true });
}

// True if a username is free: not an account's email or username, an older login, or a sign-up.
function usernameFree(username) {
  return !db.accountByEmail(username) && !auth.users().includes(username) && !db.getLogin(username) &&
    !db.listSignups().some(x => x.email === username);
}

async function addPersonNoEmail(req, res, me, ctx) {
  const b = await body(req);
  const name = String(b.name || '').trim().slice(0, 40);
  const portion = b.portion === undefined || b.portion === '' ? 1 : Number(b.portion);
  const username = String(b.username || '').trim().toLowerCase();
  if (!goodName(name)) return send(res, 400, { error: 'Enter their name (with at least one letter or number).' });
  if (!Number.isFinite(portion) || portion < 0.3 || portion > 2.5) return send(res, 400, { error: 'The portion should be between 0.3 and 2.5 (1.0 is an average serve).' });
  // Each person's name is unique in the family: their answers, ticks and login are matched by it.
  if (ctx.people().includes(ctx.toKey(name))) return send(res, 409, { error: 'Someone called ' + name + ' is already in the family. Use a different name, like “' + name + ' B”.' });
  if (username) {
    if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(username)) return send(res, 400, { error: 'Usernames are 2 to 30 letters, numbers, dots, dashes or underscores, with no spaces.' });
    if (!usernameFree(username)) return send(res, 409, { error: 'The username “' + username + '” is already taken. Try another, like “' + username + '2”.' });
    const bad = passwordProblem(b.password);
    if (bad) return send(res, 400, { error: bad });
  }
  const person = ensurePerson(name, portion, ctx);
  if (!person) return send(res, 400, { error: 'Enter a name with at least one letter or number.' });
  if (username) db.addAccount({ email: username, hash: auth.hash(b.password), person, role: 'member', createdBy: me.user });
  return send(res, 200, { ok: true, person, username: username || null });
}

function inviteInfo(res, url, ctx) {
  const invite = db.inviteByToken(hashToken(url.searchParams.get('t')));
  if (!invite) return send(res, 404, { error: 'This invite link has expired or has already been used. Ask for a new one.' });
  return send(res, 200, { name: invite.name, email: invite.email, role: invite.role, expires_at: invite.expires_at });
}

async function join(req, res, ctx) {
  if (tooMany(req)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes, then try again.' });
  const b = await body(req);
  const invite = db.inviteByToken(hashToken(b.t));
  if (!invite) {
    countTry(req);
    return send(res, 404, { error: 'This invite link has expired or has already been used. Ask for a new one.' });
  }
  const email = invite.email || cleanEmail(b.email);
  if (!email) return send(res, 400, { error: 'Enter a valid email address.' });
  if (db.accountByEmail(email)) return send(res, 409, { error: 'There is already an account with that email. Log in instead.' });
  const bad = passwordProblem(b.password);
  if (bad) return send(res, 400, { error: bad });
  if (!db.useInvite(invite.id)) return send(res, 409, { error: 'This invite has just been used.' });
  ensurePerson(invite.name, 1, ctx);
  db.deleteInvitesFor(invite.person);
  const id = db.addAccount({ email, hash: auth.hash(b.password), person: invite.person, role: invite.role, createdBy: invite.created_by });
  return send(res, 200, { ok: true }, auth.loginCookie(req, 'acct-' + id));
}

async function forgot(req, res, ctx) {
  if (tooMany(req)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes, then try again.' });
  const b = await body(req);
  countTry(req);
  // The answer is the same whether or not the email has an account, so this can't be used to
  // find out who has one.
  if (!mailer.configured()) return send(res, 200, { ok: true, mail: false });
  const account = db.accountByEmail(cleanEmail(b.email));
  if (account) {
    const { token, hash } = newToken();
    db.addReset(hash, account.id, Date.now() + RESET_HOURS_EMAILED * 3600e3);
    mailer.send(account.email, 'Reset your Family Health Planner password',
      'Someone (hopefully you) asked to reset your password.\n\nSet a new one here (the link works for 1 hour):\n' +
      mailer.link('/login?reset=' + token) + '\n\nIf it wasn’t you, ignore this email: your password hasn’t changed.\n');
  }
  return send(res, 200, { ok: true, mail: true });
}

async function reset(req, res) {
  if (req.method === 'GET') return send(res, 200, { ok: true });
  if (tooMany(req)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes, then try again.' });
  const b = await body(req);
  const found = db.resetByToken(hashToken(b.t));
  if (!found) {
    countTry(req);
    return send(res, 404, { error: 'This reset link has expired or has already been used. Ask for a new one.' });
  }
  const bad = passwordProblem(b.password);
  if (bad) return send(res, 400, { error: bad });
  if (!db.useReset(hashToken(b.t))) return send(res, 409, { error: 'This link has just been used.' });
  db.updateAccount(found.account_id, { hash: auth.hash(b.password) });   // also logs out everywhere else
  return send(res, 200, { ok: true }, auth.loginCookie(req, 'acct-' + found.account_id));
}

function resetInfo(res, url) {
  const found = db.resetByToken(hashToken(url.searchParams.get('t')));
  if (!found) return send(res, 404, { error: 'This reset link has expired or has already been used. Ask for a new one.' });
  const account = db.getAccount(found.account_id);
  return send(res, 200, { email: account ? account.email : '' });
}

// ---------------------------------------------------------------------------
// Your own account
// ---------------------------------------------------------------------------

// Adds an email to an older username (making it an account), or changes an account's email.
async function setEmail(req, res, me) {
  const b = await body(req);
  const email = cleanEmail(b.email);
  if (!email) return send(res, 400, { error: 'Enter a valid email address.' });
  const taken = db.accountByEmail(email);
  if (taken && taken.id !== me.accountId) return send(res, 409, { error: 'Another account already uses that email.' });

  if (me.accountId) {
    const account = db.getAccount(me.accountId);
    if (!account || !auth.verify(String(b.password || ''), account.hash)) return send(res, 400, { error: 'Your password is not right.' });
    db.updateAccount(me.accountId, { email });
    return send(res, 200, { ok: true, email });
  }
  // An older username: check its password, then make the account with the same password.
  if (!auth.checkLogin(me.user, String(b.password || ''))) return send(res, 400, { error: 'Your password is not right.' });
  const role = me.admin ? (hasOwner() ? 'admin' : 'owner') : 'member';
  const id = db.addAccount({ email, hash: auth.hashFor(me.user), person: me.person, role, legacyUser: me.user, createdBy: me.user });
  // The old cookie stops working once the username is an account, so log in again with the new one.
  return send(res, 200, { ok: true, email, role }, auth.loginCookie(req, 'acct-' + id));
}

async function deleteMine(req, res, me) {
  const b = await body(req);
  if (!me.accountId) return send(res, 400, { error: 'Add your email first (older usernames are removed by an admin on the server).' });
  const account = db.getAccount(me.accountId);
  if (!account || !auth.verify(String(b.password || ''), account.hash)) return send(res, 400, { error: 'Your password is not right.' });
  if (account.role === 'owner' && db.listAccounts().length > 1) {
    return send(res, 409, { error: 'You’re the family’s owner. Hand ownership to someone else on the Family page first.' });
  }
  // With no accounts left the server would ask the next visitor to set it up, and they would get
  // the family's data. Starting over is done on the server instead (see the README).
  if (db.listAccounts().length <= 1) {
    return send(res, 409, { error: 'You’re the only login, so your account can’t be deleted here: the next person to open the site would take over the family’s data. To start over, delete the data folder on the server.' });
  }
  db.deleteAccount(account.id);
  // The Health sync key stops working with the account.
  const syncHash = db.getSetting('healthsync-person:' + account.person);
  if (syncHash) db.deleteSetting('healthsync:' + syncHash);
  db.deleteSetting('healthsync-person:' + account.person);
  db.deleteSetting('healthsync-made:' + account.person);
  if (b.history) {
    db.forgetPerson(account.person, me.user);
    db.deleteSetting('healthsync-last:' + account.person);
    uploads.forget(account.person);
  }
  return send(res, 200, { ok: true }, auth.logoutCookie(req));
}

// The person's own AI key, for showing in Settings: {provider, name, model, hint} (the last 4
// characters, so they can tell which key it is). The whole key is never sent back to the browser.
function aiKeyInfo(me) {
  const own = require('./ai').ownChoice(me);
  if (!own) return null;
  const ai = require('./ai');
  return { provider: own.provider, name: ai.PROVIDERS[own.provider].name, model: own.model || null, hint: '…' + String(own.key).slice(-4) };
}

// PUT {provider, key, model?}: check and save a key (the model defaults to the best one it can use).
// PUT {provider, model} with no key: change the model for the key already saved. DELETE: remove it.
async function aiKey(req, res, me) {
  const ai = require('./ai');
  if (!me.accountId) return send(res, 400, { error: 'Add your email on the Account page first.' });
  if (req.method === 'DELETE') {
    ai.saveOwn(me, null);
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'PUT') return send(res, 404, { error: 'not found' });
  const b = await body(req);
  const provider = String(b.provider || 'anthropic');
  const p = ai.PROVIDERS[provider];
  if (!p || p.familyOnly) return send(res, 400, { error: 'Choose Claude, OpenAI or Gemini.' });
  const model = String(b.model || '').slice(0, 100);
  let key = String(b.key || '').trim();
  if (!key) {
    const own = ai.ownChoice(me);
    if (!own || own.provider !== provider) return send(res, 400, { error: 'Paste your ' + p.name + ' API key first.' });
    key = own.key;
  } else if (!p.keyPattern.test(key)) {
    return send(res, 400, { error: 'That doesn’t look like ' + (provider === 'openai' ? 'an ' : 'a ') + p.name + ' API key. They start with “' + p.keyStart + '”.' });
  }
  let models;
  try {
    models = (await ai.checkKey(provider, key)).models;
  } catch (e) {
    return send(res, 400, { error: String(e.message || e) });
  }
  const chosen = model && models.includes(model) ? model : models[0];
  ai.saveOwn(me, { provider, key, model: chosen });
  return send(res, 200, { ok: true, info: aiKeyInfo(me), models });
}

// ---------------------------------------------------------------------------
// The family (admins)
// ---------------------------------------------------------------------------

function family(res, me, ctx) {
  const accounts = db.listAccounts().map(a => Object.assign({}, a, { name: nameOf(a.person, ctx) }));
  const linked = new Set(accounts.map(a => a.legacy_user).filter(Boolean));
  const older = auth.users().map(u => ({ username: u, source: '.env' }))
    .concat(db.listLogins().map(l => ({ username: l.username, source: 'app' })))
    .filter(l => !linked.has(l.username))
    .map(l => Object.assign(l, { person: auth.describe(l.username).person, name: nameOf(auth.describe(l.username).person, ctx) }));
  const plan = ctx.readPlan() || {};
  const people = Object.values(plan.people || {}).filter(p => p && p.name).map(p => ({ person: ctx.toKey(p.name), name: p.name }));
  send(res, 200, { me: { accountId: me.accountId || null, role: me.role }, accounts, older, invites: db.listInvites(), signups: db.listSignups(), people, mail: mailer.configured() });
}

async function invite(req, res, me, ctx) {
  const b = await body(req);
  const name = String(b.name || '').trim().slice(0, 40);
  const email = b.email ? cleanEmail(b.email) : '';
  const role = b.role === 'admin' ? 'admin' : 'member';
  if (!goodName(name)) return send(res, 400, { error: 'Enter their name (with at least one letter or number).' });
  if (b.email && !email) return send(res, 400, { error: 'That email address doesn’t look right.' });
  if (email && db.accountByEmail(email)) return send(res, 409, { error: 'There is already an account with that email.' });
  if (role === 'admin' && me.role !== 'owner') return send(res, 403, { error: 'Only the owner can invite admins.' });
  const portion = b.portion === undefined || b.portion === '' ? 1 : Number(b.portion);
  if (!Number.isFinite(portion) || portion < 0.3 || portion > 2.5) return send(res, 400, { error: 'The portion should be between 0.3 and 2.5 (1.0 is an average serve).' });
  const person = ensurePerson(name, portion, ctx);
  if (!person) return send(res, 400, { error: 'Enter a name with at least one letter or number.' });
  if (db.listAccounts().some(a => a.person === person)) return send(res, 409, { error: name + ' already has a login.' });
  const { token, hash } = newToken();
  db.addInvite({ tokenHash: hash, email, name, person, role, createdBy: me.user, expiresAt: Date.now() + INVITE_DAYS * DAY });
  const path = '/login?join=' + token;
  let emailed = false;
  if (email && mailer.configured()) {
    emailed = await mailer.send(email, 'You’re invited to the Family Health Planner',
      'You’ve been invited to join your family’s meal, shopping and exercise planner.\n\nChoose a password here (the link works for ' + INVITE_DAYS + ' days):\n' +
      mailer.link(path) + '\n');
  }
  return send(res, 200, { ok: true, path, emailed, person });
}

async function memberAction(req, res, me, id, action, ctx) {
  const target = db.getAccount(id);
  if (!target) return send(res, 404, { error: 'That login was not found.' });
  const isOwner = me.role === 'owner';

  if (action === 'reset') {
    if (target.role !== 'member' && !isOwner && target.id !== me.accountId) return send(res, 403, { error: 'Only the owner can reset an admin’s password.' });
    const { token, hash } = newToken();
    db.addReset(hash, target.id, Date.now() + RESET_HOURS_SHARED * 3600e3);
    return send(res, 200, { ok: true, path: '/login?reset=' + token, hours: RESET_HOURS_SHARED });
  }

  if (action === 'delete') {
    if (target.role === 'owner') return send(res, 403, { error: 'The owner can’t be removed. They can hand over ownership first.' });
    if (target.role === 'admin' && !isOwner) return send(res, 403, { error: 'Only the owner can remove an admin.' });
    if (target.id === me.accountId) return send(res, 400, { error: 'To remove your own login, use Delete my account on the Account page.' });
    db.deleteAccount(target.id);
    return send(res, 200, { ok: true });
  }

  // Changing a role.
  const b = await body(req);
  const role = b.role;
  if (!['owner', 'admin', 'member'].includes(role)) return send(res, 400, { error: 'Unknown role.' });
  if (!isOwner) return send(res, 403, { error: 'Only the owner can change roles.' });
  if (target.id === me.accountId) return send(res, 400, { error: 'Hand ownership to someone else instead.' });
  if (role === 'owner') {
    // Hand over ownership: they become the owner, you become an admin.
    db.transaction(() => {
      db.updateAccount(me.accountId, { role: 'admin' });
      db.updateAccount(target.id, { role: 'owner' });
    });
  } else {
    db.updateAccount(target.id, { role });
  }
  return send(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Public routes under /auth/. Changes need the X-Requested-With header (sent by the pages).
async function handlePublic(req, res, urlPath, url, ctx) {
  const routes = ['/auth/status', '/auth/register', '/auth/signup', '/auth/invite', '/auth/join', '/auth/forgot', '/auth/reset'];
  if (!routes.includes(urlPath)) return false;
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }
  if (urlPath === '/auth/status' && req.method === 'GET') send(res, 200, { setup: needsSetup(), mail: mailer.configured() });
  else if (urlPath === '/auth/register' && req.method === 'POST') await register(req, res, ctx);
  else if (urlPath === '/auth/signup' && req.method === 'POST') await signup(req, res, ctx);
  else if (urlPath === '/auth/invite' && req.method === 'GET') inviteInfo(res, url, ctx);
  else if (urlPath === '/auth/join' && req.method === 'POST') await join(req, res, ctx);
  else if (urlPath === '/auth/forgot' && req.method === 'POST') await forgot(req, res, ctx);
  else if (urlPath === '/auth/reset' && req.method === 'GET') resetInfo(res, url);
  else if (urlPath === '/auth/reset' && req.method === 'POST') await reset(req, res);
  else send(res, 404, { error: 'not found' });
  return true;
}

async function handle(req, res, urlPath, url, me, ctx) {
  if (!urlPath.startsWith('/api/account') && !urlPath.startsWith('/api/family')) return false;
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }

  if (urlPath === '/api/account' && req.method === 'GET') {
    const account = me.accountId ? db.getAccount(me.accountId) : null;
    send(res, 200, {
      email: account ? account.email : null, role: me.role, person: me.person, name: nameOf(me.person, ctx),
      needsEmail: !!me.needsEmail, username: me.needsEmail ? me.user : account && account.legacy_user,
      hasAiKey: !!(account && account.has_ai_key), aiKey: aiKeyInfo(me), aiKeyHint: (aiKeyInfo(me) || {}).hint || null, mail: mailer.configured(),
    });
    return true;
  }
  if (urlPath === '/api/account/email' && req.method === 'POST') {
    await setEmail(req, res, me);
    return true;
  }
  if (urlPath === '/api/account/logout-everywhere' && req.method === 'POST') {
    if (!me.accountId) send(res, 400, { error: 'Add your email first.' });
    else {
      db.updateAccount(me.accountId, { logOutEverywhere: true });
      send(res, 200, { ok: true }, auth.loginCookie(req, me.subject));
    }
    return true;
  }
  if (urlPath === '/api/account/ai-key') {
    await aiKey(req, res, me);
    return true;
  }
  if (urlPath === '/api/account/delete' && req.method === 'POST') {
    await deleteMine(req, res, me);
    return true;
  }

  // The family: admins only.
  if (!me.admin) {
    send(res, 403, { error: 'Only an admin can manage the family’s logins.' });
    return true;
  }
  if (urlPath === '/api/family' && req.method === 'GET') {
    family(res, me, ctx);
    return true;
  }
  if (urlPath === '/api/family/invite' && req.method === 'POST') {
    await invite(req, res, me, ctx);
    return true;
  }
  const sm = urlPath.match(/^\/api\/family\/signup\/(\d+)$/);
  if (sm && req.method === 'POST') {
    await decideSignup(req, res, me, ctx, Number(sm[1]));
    return true;
  }
  // Someone without an email (a child, say). Optionally with a username and password the adult
  // chooses, so they can log in themselves; otherwise an admin answers About me for them.
  if (urlPath === '/api/family/person' && req.method === 'POST') {
    await addPersonNoEmail(req, res, me, ctx);
    return true;
  }
  if (urlPath === '/api/family/invite' && req.method === 'DELETE') {
    db.deleteInvite(Number(url.searchParams.get('id')));
    send(res, 200, { ok: true });
    return true;
  }
  const m = urlPath.match(/^\/api\/family\/member\/(\d+)(\/reset)?$/);
  if (m) {
    const action = m[2] ? (req.method === 'POST' ? 'reset' : null) : req.method === 'DELETE' ? 'delete' : req.method === 'POST' ? 'role' : null;
    if (action) {
      await memberAction(req, res, me, Number(m[1]), action, ctx);
      return true;
    }
  }
  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle, handlePublic, needsSetup };
