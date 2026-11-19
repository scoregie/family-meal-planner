// Current food: what the family already has at home, sorted into pantry, spices and seasonings,
// fridge, freezer, fruit bowl and bench, and other. Everyone in the family can add to it and remove from it (the Current food page in More).
// The next plan uses this food first and leaves what it covers off the shopping lists.
//
//   GET    /api/food   the lists, and whether the built-in plan builder has meals for each item
//   POST   /api/food   {place, text}  add one item, like {place: "fridge", text: "6 eggs"}.
//                      With {photos: ["2026-11-13 Shelf.jpeg"]} it also notes which of your food
//                      photos (My files > Food photos) the item was read from
//   PUT    /api/food   {place, text, to, toPlace}  change one item's wording to `to`, and move it
//                      to `toPlace` if that is given (for fixing something that was added wrongly)
//   DELETE /api/food   {place, text}  remove one item; {place} alone empties that place;
//                      {photos: true} removes everything that was read from photos, and deletes
//                      those photos (your own, or everyone's for an admin), to start again
//
// The lists are saved as one setting in the database ("current-food"). Which photos an item came
// from is saved beside it ("current-food-photos"), so the lists themselves stay plain text. A family that typed a
// kitchen list on Plan setup before this page existed has it sorted into places the first time
// it is read.
const db = require('./db');
const planbuilder = require('./planbuilder');
const uploads = require('./uploads');
const { send, readBody } = require('./requests');   // reading what a page sent, and sending JSON back
// The list rules (places, limits, tidying, adding and changing an item), which the phone app follows too.
const { FOOD, tidyFood: tidy, emptyFood: empty, addFood, changeFood: change } = require('./sharedrules');

const { PLACES, NAMES, CHOOSE, MAX_ITEMS } = FOOD;
const MAX_PHOTOS = 40;   // most photos noted against one item
const PHOTO_KIND = 'food-photos';   // the My files folder the photos are in (uploads.js)

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

// The name an item's photos are saved under: its place and its wording in lower case.
function linkKey(place, text) {
  return place + '|' + text.toLowerCase();
}

// Which photos each item was read from, like {"pantry|rice 2 kg": ["alex/2026-11-13 Shelf.jpeg"]}
// (the person who uploaded it, then the file name). Items no longer on the lists are left out.
function readLinks(food) {
  let saved = null;
  try { saved = JSON.parse(db.getSetting('current-food-photos') || 'null'); } catch (e) { saved = null; }
  const links = {};
  if (!saved || typeof saved !== 'object') return links;
  for (const place of PLACES) for (const text of food[place]) {
    const photos = saved[linkKey(place, text)];
    if (Array.isArray(photos) && photos.length) links[linkKey(place, text)] = photos.map(String).slice(0, MAX_PHOTOS);
  }
  return links;
}

// The photo notes for items that are still on the lists (a removed item's note is dropped).
function stillListed(links, food) {
  const kept = {};
  for (const place of PLACES) for (const text of food[place]) {
    if (links[linkKey(place, text)]) kept[linkKey(place, text)] = links[linkKey(place, text)];
  }
  return kept;
}

// Saves which photos each item was read from.
function saveLinks(links) {
  db.setSetting('current-food-photos', JSON.stringify(links));
}

// The photo names a request sent, as "person/file name" for the person who is logged in.
// Anything that isn't a plain file name is left out.
function photoList(names, person) {
  if (!Array.isArray(names) || !/^[a-z0-9-]+$/.test(String(person || ''))) return [];
  return names.map(String)
    .filter(name => name && name.length <= 140 && name === name.replace(/[\\/]/g, '') && !name.startsWith('.'))
    .slice(0, MAX_PHOTOS).map(name => person + '/' + name);
}

// Everything on the lists as [{text, place}], for the plan builder: where food is kept changes
// how long it keeps (freezer food lasts the whole plan).
function items() {
  const food = read();
  return PLACES.flatMap(place => food[place].map(text => ({ text, place })));
}

// The lists as lines for an AI plan writer: "Fridge: 6 eggs".
function lines() {
  return items().map(item => NAMES[item.place] + ': ' + item.text);
}

// What the page shows: each place's items, each with whether the built-in plan builder has meals
// that use it ("known": true) or not (an AI-written plan can still use it).
// An item that was read from a photo also has "photo": true, and "fromPhotos" counts those.
function view() {
  const food = read();
  const links = readLinks(food);
  const out = {};
  for (const place of PLACES) {
    out[place] = food[place].map(text => {
      const item = { text, known: planbuilder.kitchenStock([text]).unknown.length === 0 };
      if (links[linkKey(place, text)]) item.photo = true;
      return item;
    });
  }
  return { food: out, places: PLACES, fromPhotos: Object.keys(links).length };
}

// Removes every item that was read from a photo, and deletes those photos from My files: the
// person's own, or everyone's for an admin. Hand-typed items stay. Returns how many items went.
function clearPhotoItems(food, links, me) {
  let removed = 0;
  for (const place of PLACES) {
    const before = food[place].length;
    food[place] = food[place].filter(text => !links[linkKey(place, text)]);
    removed += before - food[place].length;
  }
  const files = new Set(Object.values(links).flat());
  for (const file of files) {
    const cut = file.indexOf('/');
    const person = file.slice(0, cut);
    if (me && (me.admin || me.person === person)) uploads.remove(person, PHOTO_KIND, file.slice(cut + 1));
  }
  return removed;
}

// Answers the /api/food requests. Returns true if it handled one. Anyone who is logged in can
// read and change the lists: it is the family's shared kitchen.
async function handle(req, res, urlPath, me) {
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
  if (req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') {
    send(res, 405, { error: 'not allowed' });
    return true;
  }
  // A request that is too long or isn't JSON is treated as empty, and gets the usual "nothing to add" reply.
  const b = (await readBody(req, 1e4).catch(() => null)) || {};
  if (req.method === 'DELETE' && b.photos === true) {
    const all = read();
    clearPhotoItems(all, readLinks(all), me);
    save(all);
    saveLinks({});
    send(res, 200, view());
    return true;
  }
  const place = String(b.place || '');
  if (!PLACES.includes(place)) {
    send(res, 400, { error: CHOOSE });
    return true;
  }
  const food = read();
  const links = readLinks(food);
  const text = tidy(b.text);

  if (req.method === 'POST') {
    const problem = addFood(food, place, text);
    if (problem) { send(res, 400, { error: problem }); return true; }
    const photos = photoList(b.photos, me && me.person);
    if (photos.length) links[linkKey(place, text)] = photos;
  } else if (req.method === 'PUT') {
    const toPlace = b.toPlace === undefined ? place : String(b.toPlace);
    if (!PLACES.includes(toPlace)) { send(res, 400, { error: CHOOSE }); return true; }
    const problem = change(food, place, text, tidy(b.to), toPlace);
    if (problem) { send(res, 400, { error: problem }); return true; }
    // The photos it was read from stay with it under its new wording and place.
    const photos = links[linkKey(place, text)];
    delete links[linkKey(place, text)];
    const to = linkKey(toPlace, tidy(b.to));
    if (photos && !links[to]) links[to] = photos;
  } else if (b.text === undefined) {
    food[place] = [];                                   // {place} alone: empty that place
  } else {
    food[place] = food[place].filter(x => x !== text);  // remove one item
  }
  save(food);
  saveLinks(stillListed(links, food));
  send(res, 200, view());
  return true;
}

module.exports = { handle, read, items, lines, PLACES };
