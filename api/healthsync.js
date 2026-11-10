// Health sync: an iPhone Shortcut sends the day's numbers from Apple Health (steps, Move energy,
// weight, and food totals, which Lose It can write into Apple Health) to the Progress page.
//
// Shortcuts can't log in with a cookie, so each person makes a personal sync key on the Health
// sync page. Only a hash of the key is stored. The key only lets someone add these numbers for
// that one person: it can't read anything or log in.
//
//   POST /auth/health-sync              public (under /auth/, so Caddy lets it through without a
//                                       login cookie). Header "Authorization: Bearer <key>".
//                                       Body: {date: "2026-11-08", steps, active_energy, weight,
//                                       energy_unit: "kJ" | "kcal", food_energy, protein, carbs, fat}
//   GET    /api/health/key?person=      logged in: whether there is a key, and the last sync
//   POST   /api/health/key?person=      make a new key (shown once; replaces the old one)
//   DELETE /api/health/key?person=      turn sync off
//   GET    /api/health/shortcut?origin= the Health sync shortcut file, unsigned (see shortcutfile.js)
//   GET    /api/health/shortcut/signed  the signed file, to install (POST uploads it, DELETE removes it: admins)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const { sensible } = require('./progress');
const shortcutfile = require('./shortcutfile');

const KJ_PER_KCAL = 4.184;
const NAMES = { steps: 'steps', active_energy: 'Move', weight: 'weight', energy_in: 'food', protein_in: 'protein', carbs_in: 'carbs', fat_in: 'fat' };
const PER_HOUR = 30;              // syncs per key per hour
const recentSyncs = new Map();    // key hash -> [times]

// Sends an answer back to the page: a status code (200 means OK, 400 means a problem with what
// was sent) and an object, turned into JSON text.
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Reads what the page sent with its request (JSON text) and turns it into an object. Stops early
// if it is far bigger than expected.
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', chunk => {
      text += chunk;
      if (text.length > limit) {
        reject(new Error('too big'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(text ? JSON.parse(text) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const sha = text => crypto.createHash('sha256').update(String(text)).digest('hex');

// A number from what a Shortcut sends: 8123, "8123", "8,123" or "103.2 kg". Null if there isn't one.
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// True if an energy value is in kcal: the unit says so, or the text has "kcal" or "Cal" in it.
function isKcal(unit, value) {
  return /kcal|cal/i.test(String(unit || '')) && !/kj/i.test(String(unit || '')) || (typeof value === 'string' && /kcal|\bcal\b/i.test(value));
}

// ---------------------------------------------------------------------------
// The sync itself (public)
// ---------------------------------------------------------------------------

async function sync(req, res) {
  const ip = auth.clientIp(req);
  if (auth.recent(ip).length >= auth.LIMIT) return send(res, 429, { error: 'Too many wrong keys from here. Wait 15 minutes.' });
  const header = String(req.headers.authorization || '');
  const key = header.replace(/^Bearer\s+/i, '').trim();
  const hash = key ? sha(key) : '';
  const person = hash ? db.getSetting('healthsync:' + hash) : null;
  if (!person) {
    auth.fails.set(ip, auth.recent(ip).concat(Date.now()));
    return send(res, 401, { error: 'That sync key isn’t right. Make a new one on the Health sync page and paste it into the shortcut.' });
  }
  const times = (recentSyncs.get(hash) || []).filter(t => t > Date.now() - 3600e3);
  if (times.length >= PER_HOUR) return send(res, 429, { error: 'That’s a lot of syncs this hour. Try again later.' });
  recentSyncs.set(hash, times.concat(Date.now()));

  let b;
  try {
    b = await readBody(req, 20000);
  } catch (e) {
    return send(res, 400, { error: 'The shortcut didn’t send JSON. Set “Request Body” to JSON in Get Contents of URL.' });
  }
  // {test: true} checks the key and the shortcut without saving anything.
  if (b.test) return send(res, 200, { ok: true, saved: [], message: 'Your sync key works. Nothing was saved (this was a test).' });
  const date = String(b.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: 'The date should look like 2026-11-08. In Format Date, choose Custom and type yyyy-MM-dd.' });

  const rows = [];
  const skipped = [];   // values that came but couldn't be used, like 'Move ("abc")', so the person can see why
  const add = (kind, value, unit, raw, day) => {
    if (value !== null && sensible(kind, value, day || date)) rows.push({ date: day || date, kind, value: Math.round(value * 100) / 100, unit });
    else if (raw !== undefined && raw !== null && String(raw).trim() !== '') skipped.push(NAMES[kind] + ' ("' + String(raw).slice(0, 40) + '")');
  };
  const toKj = (v, raw) => (v === null ? null : isKcal(b.energy_unit, raw) ? v * KJ_PER_KCAL : v);
  add('steps', num(b.steps), 'steps', b.steps);
  add('active_energy', toKj(num(b.active_energy), b.active_energy), 'kJ', b.active_energy);
  const weightDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.weight_date || '')) ? b.weight_date : date;
  add('weight', num(b.weight), 'kg', b.weight, weightDate);
  add('energy_in', toKj(num(b.food_energy), b.food_energy), 'kJ', b.food_energy);
  add('protein_in', num(b.protein), 'g', b.protein);
  add('carbs_in', num(b.carbs), 'g', b.carbs);
  add('fat_in', num(b.fat), 'g', b.fat);
  const notSaved = skipped.length ? ' Couldn’t read: ' + skipped.join(', ') + '.' : '';
  if (!rows.length) {
    db.setSetting('healthsync-last:' + person, JSON.stringify({ at: Date.now(), date, kinds: [], skipped }));
    return send(res, 200, { ok: true, saved: [], skipped, message: 'Nothing to save yet for ' + date + '.' + notSaved });
  }

  db.saveMeasurements(person, 'apple-shortcut', rows);
  db.setSetting('healthsync-last:' + person, JSON.stringify({ at: Date.now(), date, kinds: rows.map(r => r.kind), skipped }));
  return send(res, 200, { ok: true, saved: rows.map(r => r.kind), skipped, message: 'Synced ' + rows.map(r => NAMES[r.kind]).join(', ') + ' for ' + date + '.' + notSaved });
}

// The phone sending health numbers (POST /auth/health-sync). This needs no login: the phone
// proves who it is with the person's sync key instead.
function handlePublic(req, res, urlPath) {
  if (urlPath !== '/auth/health-sync') return false;
  if (req.method !== 'POST') {
    send(res, 405, { error: 'Use POST.' });
    return true;
  }
  sync(req, res).catch(() => send(res, 500, { error: 'Something went wrong saving that.' }));
  return true;
}

// ---------------------------------------------------------------------------
// Managing the key (logged in)
// ---------------------------------------------------------------------------

// The shortcut file to sign on a Mac, with this server's sync address in it. ?origin= is the
// address the page was opened at (what the iPhone will use), checked to be a plain web origin.
function shortcutFile(req, res, url) {
  const origin = String(url.searchParams.get('origin') || '');
  if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) return send(res, 400, { error: 'bad origin' });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': 'attachment; filename="Health sync (unsigned).shortcut"',
    'Cache-Control': 'no-store',
  });
  res.end(shortcutfile.build(origin + '/auth/health-sync'));
}

// The signed shortcut (made on a Mac from the file above), uploaded by an admin, for everyone to
// install with one tap. Kept in the data folder, next to the database.
const SIGNED = path.join(process.env.DATA_DIR || '/data', 'health-sync.shortcut');

// Reads a file the page sent (raw bytes, not JSON), up to a size limit.
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('too big')); req.destroy(); return; }
      parts.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// The signed one-tap install file for the Shortcut: download it (GET), or an admin uploads a new one.
async function signedFile(req, res, me) {
  if (req.method === 'GET') {
    if (!fs.existsSync(SIGNED)) return send(res, 404, { error: 'No install file yet.' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="Health sync.shortcut"', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(SIGNED));
  }
  if (req.headers['x-requested-with'] !== 'app') return send(res, 403, { error: 'bad request' });
  if (!me.admin) return send(res, 403, { error: 'Only an admin can change the install file.' });
  if (req.method === 'DELETE') {
    fs.rmSync(SIGNED, { force: true });
    return send(res, 200, { ok: true, signed: false });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'not allowed' });
  let file;
  try { file = await readRaw(req, 2e6); } catch (e) { return send(res, 413, { error: 'That file is too big for a shortcut.' }); }
  // Signed shortcuts are Apple Encrypted Archives, which start with "AEA1".
  if (file.subarray(0, 4).toString('latin1') !== 'AEA1') {
    return send(res, 400, { error: 'That isn’t a signed shortcut. Upload the “Health sync.shortcut” file the shortcuts sign command made, not the unsigned one.' });
  }
  fs.writeFileSync(SIGNED + '.tmp', file);
  fs.renameSync(SIGNED + '.tmp', SIGNED);
  db.setSetting('healthsync-signed-at', Date.now());
  return send(res, 200, { ok: true, signed: true, signedAt: Date.now() });
}

// Answers the requests this file looks after. server.js offers every /api/ request to each
// file in turn: this returns true if it answered, or false to let the next file try.
function handle(req, res, urlPath, url, me, ctx) {
  if (urlPath === '/api/health/shortcut' && req.method === 'GET') {
    shortcutFile(req, res, url);
    return true;
  }
  if (urlPath === '/api/health/shortcut/signed') {
    signedFile(req, res, me).catch(() => send(res, 500, { error: 'Something went wrong with the install file.' }));
    return true;
  }
  if (urlPath !== '/api/health/key') return false;
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }
  const person = String(url.searchParams.get('person') || me.person || '').toLowerCase();
  if (!ctx.people().includes(person)) {
    send(res, 404, { error: 'unknown person' });
    return true;
  }
  if (person !== me.person && !me.admin) {
    send(res, 403, { error: 'You can only manage your own sync key.' });
    return true;
  }
  const oldHash = db.getSetting('healthsync-person:' + person);
  const last = (() => { try { return JSON.parse(db.getSetting('healthsync-last:' + person)); } catch (e) { return null; } })();
  const install = { installFile: fs.existsSync(SIGNED) ? Number(db.getSetting('healthsync-signed-at')) || true : null, admin: !!me.admin };

  if (req.method === 'GET') {
    send(res, 200, { person, hasKey: !!oldHash, made: Number(db.getSetting('healthsync-made:' + person)) || null, last, ...install });
  } else if (req.method === 'POST') {
    if (oldHash) db.deleteSetting('healthsync:' + oldHash);
    const key = 'fhp_' + crypto.randomBytes(24).toString('base64url');
    const hash = sha(key);
    db.setSetting('healthsync:' + hash, person);
    db.setSetting('healthsync-person:' + person, hash);
    db.setSetting('healthsync-made:' + person, Date.now());
    send(res, 200, { person, key, hasKey: true, made: Date.now(), last, ...install });
  } else if (req.method === 'DELETE') {
    if (oldHash) db.deleteSetting('healthsync:' + oldHash);
    db.deleteSetting('healthsync-person:' + person);
    db.deleteSetting('healthsync-made:' + person);
    send(res, 200, { person, hasKey: false, last, ...install });
  } else {
    send(res, 405, { error: 'not allowed' });
  }
  return true;
}

module.exports = { handle, handlePublic, num };
