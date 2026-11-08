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
const crypto = require('crypto');
const db = require('./db');
const auth = require('./auth');
const { sensible } = require('./progress');

const KJ_PER_KCAL = 4.184;
const PER_HOUR = 30;              // syncs per key per hour
const recentSyncs = new Map();    // key hash -> [times]

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

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
  const add = (kind, value, unit, day) => {
    if (value !== null && sensible(kind, value, day || date)) rows.push({ date: day || date, kind, value: Math.round(value * 100) / 100, unit });
  };
  const toKj = (v, raw) => (v === null ? null : isKcal(b.energy_unit, raw) ? v * KJ_PER_KCAL : v);
  add('steps', num(b.steps), 'steps');
  add('active_energy', toKj(num(b.active_energy), b.active_energy), 'kJ');
  const weightDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.weight_date || '')) ? b.weight_date : date;
  add('weight', num(b.weight), 'kg', weightDate);
  add('energy_in', toKj(num(b.food_energy), b.food_energy), 'kJ');
  add('protein_in', num(b.protein), 'g');
  add('carbs_in', num(b.carbs), 'g');
  add('fat_in', num(b.fat), 'g');
  if (!rows.length) return send(res, 200, { ok: true, saved: [], message: 'Nothing to save yet for ' + date + '.' });

  db.saveMeasurements(person, 'apple-shortcut', rows);
  db.setSetting('healthsync-last:' + person, JSON.stringify({ at: Date.now(), date, kinds: rows.map(r => r.kind) }));
  const names = { steps: 'steps', active_energy: 'Move', weight: 'weight', energy_in: 'food', protein_in: 'protein', carbs_in: 'carbs', fat_in: 'fat' };
  return send(res, 200, { ok: true, saved: rows.map(r => r.kind), message: 'Synced ' + rows.map(r => names[r.kind]).join(', ') + ' for ' + date + '.' });
}

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

function handle(req, res, urlPath, url, me, ctx) {
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

  if (req.method === 'GET') {
    send(res, 200, { person, hasKey: !!oldHash, made: Number(db.getSetting('healthsync-made:' + person)) || null, last });
  } else if (req.method === 'POST') {
    if (oldHash) db.deleteSetting('healthsync:' + oldHash);
    const key = 'fhp_' + crypto.randomBytes(24).toString('base64url');
    const hash = sha(key);
    db.setSetting('healthsync:' + hash, person);
    db.setSetting('healthsync-person:' + person, hash);
    db.setSetting('healthsync-made:' + person, Date.now());
    send(res, 200, { person, key, hasKey: true, made: Date.now(), last });
  } else if (req.method === 'DELETE') {
    if (oldHash) db.deleteSetting('healthsync:' + oldHash);
    db.deleteSetting('healthsync-person:' + person);
    db.deleteSetting('healthsync-made:' + person);
    send(res, 200, { person, hasKey: false, last });
  } else {
    send(res, 405, { error: 'not allowed' });
  }
  return true;
}

module.exports = { handle, handlePublic, num };
