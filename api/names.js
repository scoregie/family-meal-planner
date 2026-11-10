// People's keys. Everything about a person (answers, ticks, files) is saved under a key made
// from their name. It lives in its own file so the tests can check it without starting the server.

// Turns a name into a simple key: "Alex Smith" becomes "alex-smith". A name with no a-z or 0-9 at
// all (like "ゆき" or "민준") gets "p-" and a short code made from it, the same every time.
// site/appearance.js (personKey) does the same in the browser.
function toKey(name) {
  const key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (/[a-z0-9]/.test(key) || !/[\p{L}\p{N}]/u.test(String(name || ''))) return key;
  let h = 0x811c9dc5;   // FNV-1a over the name's UTF-16 code units
  const s = String(name).trim();
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return 'p-' + h.toString(16).padStart(8, '0');
}

module.exports = { toKey };
