// Cardio levels: how fit someone already is for cardio, and how hard their cardio should be.
//
// Each person has a level from 0 (getting started) to 5 (very fit). It starts from their About me
// answer to "Which is closest to what you can do now?" (cardio_level). After each cardio session
// they can say how it felt: two "too easy" in a row moves them up a level, and one "too hard"
// moves them down. The plan builder uses the level to choose what the cardio is, and the main
// app shows "At your level: ..." under each cardio session.
//
// Some people are kept to a steady level (see cardioLimit in planbuilder.js): a heart condition
// or pregnancy (no higher than level 2), or a sore knee, ankle or hip (no jogging). Low energy or
// chronic pain starts no higher than level 2 (`steady`), and steps up from there only after
// three "too easy" in a row, one level at a time.

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
// `guess` is a starting level from somewhere else (an Apple Watch cardio fitness reading, see
// levelFromVo2), used only when they haven't picked an About me answer.
// `steady` (if given) is the highest level they start at; "too easy" can still step them past it.
function levelNow(answer, saved, limit, guess, steady) {
  const base = startLevel(answer);
  let start = base != null ? base : guess != null ? guess : 1;   // "Not sure": building up, like the old plans
  if (steady != null) start = Math.min(start, steady);
  const offset = saved && saved.base === answer ? Number(saved.offset) || 0 : 0;
  return clamp(start + offset, limit);
}

// How many "too easy" in a row step someone up: two, or three once they're at or past their
// `steady` level (low energy or chronic pain).
function easyNeeded(level, steady) {
  return steady != null && level >= steady ? 3 : 2;
}

// How many more "too easy" in a row would step someone up now (0 at the top, or at a limit).
function easyToGo(answer, saved, level, limit, steady) {
  if (level >= clamp(TOP, limit)) return 0;
  const feels = saved && saved.base === answer && Array.isArray(saved.feels) ? saved.feels : [];
  return Math.max(1, easyNeeded(level, steady) - unusedEasyRun(feels).length);
}

// A rough starting level from an Apple Watch cardio fitness reading (VO2 max, in mL/kg/min).
// The steps between levels are for a 30-year-old (lower for women) and come down about 3.5
// a decade after 30, roughly following published fitness tables. It's only a starting point:
// "Too easy" and "Too hard" correct it.
const VO2_STEPS = { Male: [30, 36, 42, 47, 52], Female: [26, 31, 36, 41, 46] };
function levelFromVo2(vo2, age, sex) {
  if (!Number.isFinite(vo2)) return null;
  const steps = VO2_STEPS[sex] || VO2_STEPS.Male.map((m, i) => (m + VO2_STEPS.Female[i]) / 2);
  const older = Math.max(0, (Number(age) || 30) - 30) * 0.35;
  return steps.filter(s => vo2 >= s - older).length;
}

// What to show for a level: {level, name, walk, other, how}.
function describe(level) {
  return Object.assign({ level }, LEVELS[clamp(level)]);
}

// Records how a session felt ("easy", "right" or "hard") and works out the new level.
// `saved` is {base, offset, feels: [{id, feel, used}]}: `id` is the session ("2|Mon-cardio"), so
// saying again for the same session replaces the first answer. `used` marks answers that have
// already counted towards a step, so each session counts once: tapping "Too easy" again on the
// same sessions can't keep stepping up. (Older records marked only the answer that moved the
// level, with `moved`; that counts as used too.) Changing a counted "Too easy" to "Too hard"
// does step back, as a correction. Gives back the new saved record, `moved` (+1 stepped up,
// -1 stepped back, or 0) and the new level.
function feelAfter(answer, saved, id, feel, limit, guess, steady) {
  const same = saved && saved.base === answer;   // a changed About me answer starts again
  const before = levelNow(answer, saved, limit, guess, steady);
  const need = easyNeeded(before, steady);
  const old = same && Array.isArray(saved.feels) ? saved.feels : [];
  const prev = old.find(f => f.id === id);
  const prevUsed = !!(prev && isUsed(prev));
  const feels = old.filter(f => f.id !== id).map(f => (isUsed(f) ? { id: f.id, feel: f.feel, used: true } : { id: f.id, feel: f.feel }));
  const entry = prevUsed ? { id, feel, used: true } : { id, feel };
  feels.push(entry);
  let moved = 0;
  if (feel === 'hard' && before > 0 && (!prevUsed || prev.feel === 'easy')) {
    moved = -1;
    entry.used = true;
  } else if (feel === 'easy' && !prevUsed && before < clamp(TOP, limit)) {
    const run = unusedEasyRun(feels);
    if (run.length >= need) {
      moved = 1;
      run.forEach(f => { f.used = true; });
    }
  }
  const offset = (same ? Number(saved.offset) || 0 : 0) + moved;
  return { saved: { base: answer, offset, feels: feels.slice(-30) }, moved, level: clamp(before + moved, limit) };
}

// True if an answer has already counted towards a step (see feelAfter).
function isUsed(f) {
  return !!(f.used || f.moved);
}

// The newest answers that are "too easy" and haven't counted towards a step yet, newest last.
// The run stops at an "about right", a "too hard" or an answer that already counted.
function unusedEasyRun(feels) {
  const run = [];
  for (let i = feels.length - 1; i >= 0 && feels[i].feel === 'easy' && !isUsed(feels[i]); i--) run.unshift(feels[i]);
  return run;
}

const Cardio = { START, LEVELS, TOP, startLevel, levelNow, describe, feelAfter, clamp, session, levelFromVo2, easyToGo };
if (typeof module === 'object' && module.exports) module.exports = Cardio;
else window.Cardio = Cardio;
