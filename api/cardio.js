// Cardio levels: how fit someone already is for cardio, and how hard their cardio should be.
//
// Each person has a level from 0 (getting started) to 5 (very fit). It starts from their About me
// answer to "Which is closest to what you can do now?" (cardio_level). After each cardio session
// they can say how it felt: two "too easy" in a row moves them up a level, and one "too hard"
// moves them down. The plan builder uses the level to choose what the cardio is, and the main
// app shows "At your level: ..." under each cardio session.
//
// Some people are kept to a steady level (see limitFor in planbuilder.js): a heart condition,
// pregnancy, low energy or chronic pain, or a sore knee, ankle or hip (no jogging).

// The About me answers, in order, and the level each starts at.
const START = [
  'A 20-minute walk leaves me puffed',
  'I can walk for 30 minutes at an easy pace',
  'I can walk briskly for 30 minutes or more',
  'I can jog for 10 minutes or more',
  'I can jog or run for 30 minutes',
  'I run, ride or swim hard 3 or more times a week',
];

// Each level: `walk` is the session for people whose cardio is walking, with `walkDetail` after
// the minutes ("Walk-jog 30 minutes: jog 1 minute, walk 3, and repeat"). `other` goes after the
// minutes of any other cardio ("Swim at the pool 30 minutes: steady pace"). `how` says how hard
// it should feel.
const LEVELS = [
  { name: 'Getting started', walk: 'Easy walk', walkDetail: '', other: 'easy pace', how: 'Easy: you could chat, or even sing.' },
  { name: 'Building up', walk: 'Brisk walk', walkDetail: '', other: 'easy pace', how: 'Breathing faster, but you can still talk in full sentences.' },
  { name: 'Comfortable', walk: 'Brisk walk', walkDetail: 'add hills or stairs', other: 'steady pace', how: 'Breathing harder on the hills, but you can still talk.' },
  { name: 'Fit', walk: 'Walk-jog', walkDetail: 'jog 1 minute, walk 3, and repeat', other: 'steady, with 1 faster minute in every 4', how: 'On the jogs or faster minutes, you can say a sentence at a time.' },
  { name: 'Fitter', walk: 'Jog', walkDetail: 'walk breaks when you need them', other: 'steady, with 2 faster minutes in every 5', how: 'You can say a few words, but not chat.' },
  { name: 'Very fit', walk: 'Run', walkDetail: 'add a few faster minutes', other: 'steady, with hard 1-minute bursts', how: 'On the faster minutes, only a word or two.' },
];

// One cardio session at a level, such as "Brisk walk 30 minutes: add hills or stairs".
// `kind` is "Walk" or the other cardio ("Swim at the pool", "Ride"); `walkCap` keeps walks at or
// below that level (a sore knee: no jogging).
function session(kind, level, minutes, walkCap) {
  const time = ' ' + minutes + ' minutes';
  if (kind === 'Walk') {
    const at = describe(walkCap == null ? level : Math.min(level, walkCap));
    return at.walk + time + (at.walkDetail ? ': ' + at.walkDetail : '');
  }
  return kind + time + ': ' + describe(level).other;
}
const TOP = LEVELS.length - 1;

// The level an About me answer starts at, or null for "Not sure" or no answer.
function startLevel(answer) {
  const at = START.indexOf(String(answer || ''));
  return at < 0 ? null : at;
}

// A level kept between 0 and `limit` (the highest level that suits the person).
function clamp(level, limit) {
  return Math.max(0, Math.min(limit == null ? TOP : limit, level));
}

// The person's level now: their About me start plus any steps from how sessions felt.
// `saved` is what feelAfter() last returned ({base, offset}); a changed About me answer starts again.
function levelNow(answer, saved, limit) {
  const base = startLevel(answer);
  const start = base == null ? 1 : base;   // "Not sure": treat as building up, like the old plans
  const offset = saved && saved.base === answer ? Number(saved.offset) || 0 : 0;
  return clamp(start + offset, limit);
}

// What to show for a level: {level, name, walk, other, how}.
function describe(level) {
  return Object.assign({ level }, LEVELS[clamp(level)]);
}

// Records how a session felt ("easy", "right" or "hard") and works out the new level.
// `saved` is {base, offset, feels: [{id, feel, moved}]}: `id` is the session ("2|Mon-cardio"), so
// saying again for the same session replaces the first answer, and `moved` marks the answer that
// changed the level. Gives back the new saved record, `moved` (+1 stepped up, -1 stepped back,
// or 0) and the new level.
function feelAfter(answer, saved, id, feel, limit) {
  const same = saved && saved.base === answer;   // a changed About me answer starts again
  const before = levelNow(answer, saved, limit);
  const feels = (same && Array.isArray(saved.feels) ? saved.feels : []).filter(f => f.id !== id);
  // Only answers since the level last changed count, so each step needs two more "too easy".
  let lastMove = -1;
  feels.forEach((f, i) => { if (f.moved) lastMove = i; });
  const since = feels.slice(lastMove + 1).map(f => f.feel).concat(feel);
  let moved = 0;
  if (feel === 'hard' && before > 0) moved = -1;
  else if (since.length >= 2 && since.slice(-2).every(f => f === 'easy') && before < clamp(TOP, limit)) moved = 1;
  const entry = moved ? { id, feel, moved: true } : { id, feel };
  const offset = (same ? Number(saved.offset) || 0 : 0) + moved;
  return { saved: { base: answer, offset, feels: feels.concat(entry).slice(-30) }, moved, level: clamp(before + moved, limit) };
}

const Cardio = { START, LEVELS, TOP, startLevel, levelNow, describe, feelAfter, clamp, session };
if (typeof module === 'object' && module.exports) module.exports = Cardio;
else window.Cardio = Cardio;
