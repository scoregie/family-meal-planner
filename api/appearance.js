// The household's look (set by admins on the Settings page) and the app's home-screen icon.
//
//   GET /api/appearance         the household's colour, font and text size
//   PUT /api/appearance         admins: save them {colour, font, size}
//   PUT /api/appearance/energy  {energy: "kJ" | "kcal" | "", scope: "me" or "house"}: energy units
//   PUT /api/appearance/stores  {stores: [...], scope: "me" or "house"}: where you shop (admins
//                               can also set the household's choice, used by anyone without their own)
//   PUT /api/appearance/icon    admins: a new icon, drawn in the browser {icon512, icon192, icon180}
//                               (each a "data:image/png;base64,..." picture), or {reset: true}
//                               to go back to the icon the app came with
//
// Each person can also choose their own look on their own device; that is kept in their browser.
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SITE_DIR = path.dirname(process.env.PLAN_FILE || '/site/plan.json');
const DATA_DIR = process.env.DATA_DIR || '/data';
const ICON_BACKUPS = path.join(DATA_DIR, 'icon-backups');
const KEEP_BACKUPS = 10;

// The same choices as site/appearance.js.
const CHOICES = {
  colour: ['green', 'teal', 'blue', 'purple', 'berry', 'orange', 'olive', 'slate'],
  font: ['atkinson', 'lexend', 'nunito', 'literata', 'system'],
  size: ['small', 'normal', 'large', 'larger', 'largest'],
};

// Grocery stores (the same list as site/appearance.js).
const STORES = ['coles', 'woolworths', 'aldi', 'iga', 'foodland', 'spudshed', 'drakes'];

function readStores(key) {
  try {
    const list = JSON.parse(db.getSetting(key) || '[]');
    return Array.isArray(list) ? list.filter(s => STORES.includes(s)) : [];
  } catch (e) {
    return [];
  }
}

// {house: [...], mine: [...]} for a person.
function stores(person) {
  return { house: readStores('stores'), mine: readStores('stores:' + person) };
}

// The stores a person shops at (their own choice, else the household's, else Coles), for the assistant.
function storesFor(person) {
  const s = stores(person);
  return s.mine.length ? s.mine : s.house.length ? s.house : ['coles'];
}

// Energy units: "kJ" (kilojoules) or "kcal" (Calories). Each person's choice, else the
// household's, else kilojoules. The plan and database always use kJ; this only changes what's shown.
const ENERGY = ['kJ', 'kcal'];
function energy(person) {
  const read = key => (ENERGY.includes(db.getSetting(key)) ? db.getSetting(key) : '');
  return { house: read('energy'), mine: read('energy:' + person) };
}
function energyFor(person) {
  const e = energy(person);
  return e.mine || e.house || 'kJ';
}

// The icon files, and the size each must be.
const ICONS = { icon512: ['icon-512.png', 512], icon192: ['icon-192.png', 192], icon180: ['apple-touch-icon.png', 180] };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function body(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too big'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
  });
}

function house() {
  try {
    const saved = JSON.parse(db.getSetting('appearance') || '{}');
    const out = {};
    for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(saved[k])) out[k] = saved[k];
    return out;
  } catch (e) {
    return {};
  }
}

// Turns a "data:image/png;base64,..." picture into bytes, checking it really is a PNG of the
// right size. Returns the bytes, or an error message.
function readPng(dataUrl, size) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return 'not a PNG picture';
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > 1024 * 1024) return 'too big';
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(signature) || bytes.toString('latin1', 12, 16) !== 'IHDR') return 'not a PNG picture';
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width !== size || height !== size) return 'should be ' + size + '×' + size + ' but is ' + width + '×' + height;
  return bytes;
}

// Copies the current icons into data/icon-backups/<time>/ (and, the first time, into
// data/icon-backups/original/ so "Back to the original" always works). Keeps the newest few.
function backUpIcons() {
  const original = path.join(ICON_BACKUPS, 'original');
  const stamp = path.join(ICON_BACKUPS, new Date().toISOString().replace(/[:.]/g, '-'));
  for (const dir of [original, stamp]) {
    if (dir === original && fs.existsSync(original)) continue;
    fs.mkdirSync(dir, { recursive: true });
    for (const [file] of Object.values(ICONS)) {
      const from = path.join(SITE_DIR, file);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, file));
    }
  }
  // Only the dated backups are tidied away; 'original' and anything named by hand are kept.
  const old = fs.readdirSync(ICON_BACKUPS).filter(d => /^\d{4}-\d\d-\d\dT[\d-]+Z$/.test(d)).sort();
  old.slice(0, Math.max(0, old.length - KEEP_BACKUPS)).forEach(d => fs.rmSync(path.join(ICON_BACKUPS, d), { recursive: true, force: true }));
}

// Writes a file by writing a temporary copy first, so a half-written icon is never served.
function writeFile(file, bytes) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, file);
}

async function handle(req, res, urlPath, url, me) {
  if (!['/api/appearance', '/api/appearance/icon', '/api/appearance/stores', '/api/appearance/energy'].includes(urlPath)) return false;
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }

  if (urlPath === '/api/appearance' && req.method === 'GET') {
    send(res, 200, { house: house(), admin: !!me.admin, stores: stores(me.person), energy: energy(me.person) });
    return true;
  }
  if (req.method !== 'PUT') {
    send(res, 404, { error: 'not found' });
    return true;
  }
  if (urlPath === '/api/appearance/energy') {
    const b = await body(req, 2000);
    const value = ENERGY.includes(b.energy) ? b.energy : '';   // '' = use the household's
    const key = b.scope === 'house' ? 'energy' : 'energy:' + me.person;
    if (b.scope === 'house' && !me.admin) {
      send(res, 403, { error: 'Only an admin can change the household’s units.' });
      return true;
    }
    if (value) db.setSetting(key, value);
    else db.deleteSetting(key);
    send(res, 200, { ok: true, energy: energy(me.person) });
    return true;
  }
  if (urlPath === '/api/appearance/stores') {
    const b = await body(req, 2000);
    const list = Array.isArray(b.stores) ? [...new Set(b.stores.filter(s => STORES.includes(s)))] : [];
    if (b.scope === 'house') {
      if (!me.admin) {
        send(res, 403, { error: 'Only an admin can change the household’s stores.' });
        return true;
      }
      db.setSetting('stores', JSON.stringify(list));
    } else {
      db.setSetting('stores:' + me.person, JSON.stringify(list));
    }
    send(res, 200, { ok: true, stores: stores(me.person) });
    return true;
  }
  if (!me.admin) {
    send(res, 403, { error: 'Only an admin can change the look for everyone.' });
    return true;
  }

  if (urlPath === '/api/appearance') {
    const b = await body(req, 2000);
    const choice = {};
    for (const k of Object.keys(CHOICES)) {
      if (b[k] === undefined || b[k] === null || b[k] === '') continue;
      if (!CHOICES[k].includes(b[k])) {
        send(res, 400, { error: 'Unknown ' + k + ': ' + b[k] });
        return true;
      }
      choice[k] = b[k];
    }
    db.setSetting('appearance', JSON.stringify(choice));
    send(res, 200, { ok: true, house: house() });
    return true;
  }

  // A new icon.
  const b = await body(req, 4 * 1024 * 1024);
  if (b.reset) {
    const original = path.join(ICON_BACKUPS, 'original');
    if (!fs.existsSync(original)) {
      send(res, 200, { ok: true, note: 'The icon has not been changed, so it is already the original.' });
      return true;
    }
    backUpIcons();
    for (const [file] of Object.values(ICONS)) {
      const from = path.join(original, file);
      if (fs.existsSync(from)) writeFile(path.join(SITE_DIR, file), fs.readFileSync(from));
    }
    send(res, 200, { ok: true });
    return true;
  }
  const pictures = {};
  for (const [key, [file, size]] of Object.entries(ICONS)) {
    const bytes = readPng(b[key], size);
    if (typeof bytes === 'string') {
      send(res, 400, { error: file + ': ' + bytes });
      return true;
    }
    pictures[file] = bytes;
  }
  backUpIcons();
  for (const [file, bytes] of Object.entries(pictures)) writeFile(path.join(SITE_DIR, file), bytes);
  send(res, 200, { ok: true });
  return true;
}

module.exports = { handle, CHOICES, STORES, storesFor, energyFor };
