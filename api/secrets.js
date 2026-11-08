// Encrypts small secrets (like someone's own Claude API key) before they go in the database.
//
// A key can't be "hashed" like a password: the server needs the real key back to use it. So it is
// encrypted with AES-256-GCM using a random key kept in data/encryption-key (readable only by the
// server). Someone who copies just the database can't read the secrets. The encryption key is
// included in the offsite backup (which is itself encrypted), so restoring keeps them working.
// If data/encryption-key is lost, saved API keys stop working and people paste them in again.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const KEY_FILE = path.join(DATA_DIR, 'encryption-key');
let key = null;

function getKey() {
  if (key) return key;
  try {
    const saved = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (saved.length === 32) key = saved;
  } catch (e) {
    // Not made yet.
  }
  if (!key) {
    key = crypto.randomBytes(32);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, key.toString('base64'), { mode: 0o600 });
  }
  return key;
}

// "v1.<iv>.<tag>.<encrypted text>", all base64url.
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

// The original text, or null if it can't be decrypted (wrong key, or changed).
function decrypt(sealed) {
  try {
    const [version, iv, tag, data] = String(sealed || '').split('.');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

module.exports = { encrypt, decrypt };
