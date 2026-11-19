// The rules the web server and the phone app both follow, kept in one file so the two can't drift
// apart. The server loads it with require(). The phone app (family-health-planner-app) copies
// this same file and its local-api.js loads it, the way it loads planbuilder.js and cardio.js.
// So it uses nothing else: no database, no files, no other code.
//
//   People and dishes   toKey, dishKey
//   Current food        FOOD (the places and limits), tidyFood, emptyFood, addFood, changeFood
//   Planned meals       planKeyFor, plannedDish
//   Exercise swaps      matchExercise, swapExercise
//
// The functions that change something (addFood, changeFood, swapExercise) give back an error
// message for the page, or '' (or the new line) when it worked. Saving is left to the caller.

// ---------------------------------------------------------------------------
// People and dishes
// ---------------------------------------------------------------------------

// Turns a name into a simple key: "Alex Smith" becomes "alex-smith". Everything about a person
// (answers, ticks, files) is saved under it. A name with no a-z or 0-9 at all (like "ゆき" or
// "민준") gets "p-" and a short code made from it, the same every time.
// site/appearance.js (personKey) does the same in the browser; tests/names.test.js checks they agree.
function toKey(name) {
  const key = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (/[a-z0-9]/.test(key) || !/[\p{L}\p{N}]/u.test(String(name || ''))) return key;
  let h = 0x811c9dc5;   // FNV-1a over the name's UTF-16 code units
  const s = String(name).trim();
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return 'p-' + h.toString(16).padStart(8, '0');
}

// The name a dish is filed under: lower case, without a "(packed)" ending.
function dishKey(name) {
  return String(name || '').replace(/\s*\(packed\)\s*$/i, '').trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Current food (the food the family already has, by where it is kept)
// ---------------------------------------------------------------------------

const FOOD = {
  PLACES: ['pantry', 'spices', 'fridge', 'freezer', 'bench', 'other'],   // in the order the page shows them
  NAMES: { pantry: 'Pantry', spices: 'Spices and seasonings', fridge: 'Fridge', freezer: 'Freezer', bench: 'Fruit bowl and bench', other: 'Other' },
  CHOOSE: 'Choose pantry, spices and seasonings, fridge, freezer, fruit bowl and bench, or other.',
  MAX_ITEMS: 100,   // most items in one place
  MAX_TEXT: 80,     // longest item, in characters
};

// One item as it is saved: no angle brackets, no extra spaces, at most 80 characters.
function tidyFood(text) {
  return String(text || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, FOOD.MAX_TEXT);
}

// An empty set of lists: {pantry: [], spices: [], fridge: [], freezer: [], bench: [], other: []}.
function emptyFood() {
  return Object.fromEntries(FOOD.PLACES.map(place => [place, []]));
}

// Adds `text` (already tidied) to `place`. The same thing twice in one place is left as one.
function addFood(food, place, text) {
  if (!text) return 'Type what the food is, like “rice 2 kg”.';
  if (food[place].length >= FOOD.MAX_ITEMS) return 'That list is full. Remove something first.';
  if (!food[place].some(x => x.toLowerCase() === text.toLowerCase())) food[place].push(text);
  return '';
}

// Changes one item: `text` in `place` becomes `to`, in `toPlace` (both already checked). It keeps
// its spot in the list, and if the new wording is already on that list, the two become one.
function changeFood(food, place, text, to, toPlace) {
  const at = food[place].indexOf(text);
  if (at < 0) return 'That isn’t on the list any more. Someone may have changed it.';
  if (!to) return 'Type what the food is, like “rice 2 kg”.';
  const same = x => x.toLowerCase() === to.toLowerCase();
  if (toPlace === place) {
    if (food[place].some((x, i) => i !== at && same(x))) food[place].splice(at, 1);
    else food[place][at] = to;
    return '';
  }
  if (!food[toPlace].some(same) && food[toPlace].length >= FOOD.MAX_ITEMS) return 'That list is full. Remove something first.';
  food[place].splice(at, 1);
  if (!food[toPlace].some(same)) food[toPlace].push(to);
  return '';
}

// ---------------------------------------------------------------------------
// Planned meals
// ---------------------------------------------------------------------------

// The key a person has in the plan's "people" block (it can differ from their own key), or null.
function planKeyFor(plan, person) {
  const block = (plan && plan.people) || {};
  return Object.keys(block).find(k => block[k] && block[k].name && toKey(block[k].name) === person) || null;
}

// What someone was planned to eat in a meal slot ("Breakfast", "Lunch", "Dinner" or
// "School snack"), following the same rules as the Meals tab: their own breakfast, a packed
// school lunch or snack, or a meal an admin set just for them. `planKey` is from planKeyFor.
function plannedDish(plan, weekIndex, dayName, slot, planKey) {
  const week = plan.weeks[weekIndex];
  const day = week && (week.meals || []).find(d => d.day === dayName);
  if (!day) return null;
  const person = planKey ? (plan.people || {})[planKey] : null;
  const school = person && person.weekday && person.weekday[dayName];
  let dish = slot === 'School snack' ? null : day[slot.toLowerCase()];
  if (slot === 'Breakfast' && person && person.breakfast) dish = person.breakfast;
  if (slot === 'Lunch' && school && school.lunch) dish = school.lunch;
  if (slot === 'School snack' && school) dish = school.snack;
  const own = planKey && day.people && day.people[planKey];
  if (own && own[slot.toLowerCase()]) dish = own[slot.toLowerCase()];
  return dish || null;
}

// ---------------------------------------------------------------------------
// Exercise swaps (the Swap button on a workout line)
// ---------------------------------------------------------------------------

const WARM_COOL = /^(warm-up|cool-down)\s*:\s*/i;   // a "Warm-up: " or "Cool-down: " start

// The library exercise a workout line is about ("Warm-up: March on the spot (5 minutes): ..." or
// "Goblet squat: hold one dumbbell...") or null. `exercises` is the exercise library.
function matchExercise(exercises, line) {
  const name = String(line || '').replace(WARM_COOL, '').split(/\s*[(:]/)[0].trim().toLowerCase();
  if (!name) return null;
  return exercises.find(e => e.name.toLowerCase() === name)
    || exercises.find(e => name.startsWith(e.name.toLowerCase()) || e.name.toLowerCase().startsWith(name)) || null;
}

// Swaps one line of a workout for another exercise from the library, changing `target` in place.
//   target     the workouts being changed: the plan's shared exercise block, or one person's
//   body       what the page sent: {workout: its name, item: the line's position, to: exercise id}
//   exercises  the exercise library
//   suits      the ids of the exercises that suit this person (About me and their leave-out
//              list), or null for shared workouts, which aren't checked against one person
// Gives back {line, old} (the new line, and the exercise it replaced), or {code, error}.
function swapExercise(target, body, exercises, suits) {
  const to = exercises.find(e => e.id === body.to);
  if (!to) return { code: 400, error: 'unknown exercise' };
  const workout = target && Array.isArray(target.workouts) ? target.workouts.find(w => w && w.name === body.workout) : null;
  const index = Number(body.item);
  if (!workout || !Array.isArray(workout.items) || !Number.isInteger(index) || index < 0 || index >= workout.items.length) {
    return { code: 409, error: 'That workout has changed. Reload the page and try again.' };
  }
  const old = matchExercise(exercises, workout.items[index]);
  if (!old) return { code: 400, error: 'That line isn’t an exercise from the library, so it can’t be swapped here.' };
  const near = { lunge: 'squat', squat: 'lunge' };   // close enough to swap for each other
  if (old.type !== to.type && near[old.type] !== to.type) return { code: 400, error: 'Pick an exercise of the same kind.' };
  if (suits && !suits.includes(to.id)) {
    return { code: 400, error: 'That exercise doesn’t suit their About me answers (equipment, injuries or health), or it’s on their leave-out list. Pick another.' };
  }
  const start = (WARM_COOL.exec(workout.items[index]) || [''])[0];
  workout.items[index] = start + to.name + ' (' + to.dose + '): ' + to.how;
  return { line: workout.items[index], old };
}

const SharedRules = { toKey, dishKey, FOOD, tidyFood, emptyFood, addFood, changeFood, planKeyFor, plannedDish, matchExercise, swapExercise };
if (typeof module === 'object' && module.exports) module.exports = SharedRules;
else window.SharedRules = SharedRules;
