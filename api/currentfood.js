// Current food: what the family already has at home, sorted into pantry, fridge, freezer and
// other. Everyone in the family can add to it and remove from it (the Current food page in More).
// The next plan uses this food first and leaves what it covers off the shopping lists.
//
//   GET    /api/food   the lists, and whether the built-in plan builder has meals for each item
//   POST   /api/food   {place, text}  add one item, like {place: "fridge", text: "6 eggs"}
//   DELETE /api/food   {place, text}  remove one item; {place} alone empties that place
//
// The lists are saved as one setting in the database ("current-food"). A family that typed a
// kitchen list on Plan setup before this page existed has it sorted into places the first time
// it is read.
const db = require('./db');
const planbuilder = require('./planbuilder');

// The places food is kept, in the order the page shows them.
const PLACES = ['pantry', 'fridge', 'freezer', 'other'];
const MAX_ITEMS = 100;   // most items in one place
const MAX_TEXT = 80;     // longest item, in characters

// Sends a JSON answer.
function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

// Reads the JSON a page sent, up to about 10 KB. Gives {} if it is empty or can't be read.
function readBody(req) {
  return new Promise(resolve => {
    let text = '';
    req.on('data', chunk => { if (text.length < 1e4) text += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(text) || {}); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// One item as it is saved: no angle brackets, no extra spaces, at most 80 characters.
function tidy(text) {
  return String(text || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

// An empty set of lists: {pantry: [], fridge: [], freezer: [], other: []}.
function empty() {
  return Object.fromEntries(PLACES.map(place => [place, []]));
}

// The saved lists. The first time, an older kitchen list from Plan setup (one list of lines) is
// sorted into places and saved in the new form.
function read() {
  const food = empty();
  let saved = null;
  try { saved = JSON.parse(db.getSetting('current-food') || 'null'); } catch (e) { saved = null; }
  if (saved && typeof saved === 'object') {
    for (const place of PLACES) if (Array.isArray(saved[place])) food[place] = saved[place].map(tidy).filter(Boolean).slice(0, MAX_ITEMS);
    return food;
  }
  let older = [];
  try { older = JSON.parse(db.getSetting('kitchen-list') || '[]'); } catch (e) { older = []; }
  if (!Array.isArray(older) || !older.length) return food;
  for (const line of older.map(tidy).filter(Boolean)) food[planbuilder.kitchenPlace(line)].push(line);
  save(food);
  return food;
}

// Saves the lists.
function save(food) {
  db.setSetting('current-food', JSON.stringify(food));
}

// Everything on the lists as [{text, place}], for the plan builder: where food is kept changes
// how long it keeps (freezer food lasts the whole plan).
function items() {
  const food = read();
  return PLACES.flatMap(place => food[place].map(text => ({ text, place })));
}

// The lists as lines for an AI plan writer: "Fridge: 6 eggs".
function lines() {
  return items().map(item => item.place.charAt(0).toUpperCase() + item.place.slice(1) + ': ' + item.text);
}

// What the page shows: each place's items, each with whether the built-in plan builder has meals
// that use it ("known": true) or not (an AI-written plan can still use it).
function view() {
  const food = read();
  const out = {};
  for (const place of PLACES) {
    out[place] = food[place].map(text => ({ text, known: planbuilder.kitchenStock([text]).unknown.length === 0 }));
  }
  return { food: out, places: PLACES };
}

// Answers the /api/food requests. Returns true if it handled one. Anyone who is logged in can
// read and change the lists: it is the family's shared kitchen.
async function handle(req, res, urlPath) {
  if (urlPath !== '/api/food') return false;
  // Changes must come from the app itself (a second guard on top of the SameSite cookie).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }
  if (req.method === 'GET') {
    send(res, 200, view());
    return true;
  }
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    send(res, 405, { error: 'not allowed' });
    return true;
  }
  const b = await readBody(req);
  const place = String(b.place || '');
  if (!PLACES.includes(place)) {
    send(res, 400, { error: 'Choose pantry, fridge, freezer or other.' });
    return true;
  }
  const food = read();
  const text = tidy(b.text);

  if (req.method === 'POST') {
    if (!text) { send(res, 400, { error: 'Type what the food is, like “rice 2 kg”.' }); return true; }
    if (food[place].length >= MAX_ITEMS) { send(res, 400, { error: 'That list is full. Remove something first.' }); return true; }
    // The same thing twice in one place is left as one.
    if (!food[place].some(x => x.toLowerCase() === text.toLowerCase())) food[place].push(text);
  } else if (b.text === undefined) {
    food[place] = [];                                   // {place} alone: empty that place
  } else {
    food[place] = food[place].filter(x => x !== text);  // remove one item
  }
  save(food);
  send(res, 200, view());
  return true;
}

module.exports = { handle, read, items, lines, PLACES };
