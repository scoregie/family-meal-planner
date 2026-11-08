// Turns a person's "Suggested eating times" from plan.json into calendar events.
//   GET /api/calendar/<person>.ics?start=YYYY-MM-DD  -> calendar file (Apple Calendar, Outlook, Google import)
//   GET /api/calendar/<person>.json?start=...        -> the same events as JSON (the page builds Google links from it)
// Times are "floating" (no time zone), so each calendar uses the phone's own time zone.
const fs = require('fs');
const crypto = require('crypto');

const PLAN_FILE = process.env.PLAN_FILE || '/site/plan.json';
const WEEKS = 4;        // how many weeks the repeating events last
const REMIND_MIN = 10;  // reminder, in minutes before each event

// Converts an hour, minutes and "am"/"pm" to minutes after midnight: (6, 30, "pm") gives 1110.
function to24(hour, minutes, amPm) {
  hour = +hour;
  minutes = +(minutes || 0);
  amPm = (amPm || '').toLowerCase();
  if (amPm === 'pm' && hour < 12) hour += 12;
  if (amPm === 'am' && hour === 12) hour = 0;
  return hour * 60 + minutes;
}

// Reads a time from text: "6:30 to 7:30 am (Mon to Fri)", "7:30 am" or "12:00 to 12:30 pm".
// Returns {start, end} in minutes after midnight, or null if there is no time in it.
// A single time becomes a 30-minute event.
function parseWhen(when) {
  // Matches "<h>[:<mm>] [am|pm]", then optionally "to"/"-"/"–" and a second time.
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*(?:to|-|\u2013)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(when || '');
  if (!m) return null;
  const [, startHour, startMin, startAmPm, endHour, endMin, endAmPm] = m;
  // If only one side says am or pm, use it for both ("6:30 to 7:30 am").
  let start = to24(startHour, startMin, startAmPm || endAmPm);
  const end = endHour ? to24(endHour, endMin, endAmPm || startAmPm) : start + 30;
  if (end <= start && endHour) start -= 12 * 60;   // "11:30 to 12:30 pm" means 11:30 am
  if (start < 0 || end > 24 * 60) return null;
  return { start, end };
}

// A short event title from a description: "Morning workout: easy cardio." gives "Morning workout".
function title(what) {
  let t = String(what || '').split(/[.:(]/)[0].split(',')[0].trim();
  if (t.length > 60) t = t.slice(0, 57) + '...';
  return t || 'Plan reminder';
}

// Formatting helpers for calendar files.
const pad = n => String(n).padStart(2, '0');                                       // 7 -> "07"
const ymd = d => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()); // a date -> "20261108"
const hm = minutes => pad(Math.floor(minutes / 60)) + pad(minutes % 60) + '00';      // 390 -> "063000"

// Builds the list of events for one person, starting on `startDate` (YYYY-MM-DD) or tomorrow.
// Returns {name, events} or null if that person has no suggested times.
function events(personKey, startDate) {
  const file = fs.existsSync(PLAN_FILE) ? PLAN_FILE : PLAN_FILE.replace(/plan\.json$/, 'plan.example.json');
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  const person = (plan.people || {})[personKey];
  if (!person || !Array.isArray(person.times) || !person.times.length) return null;

  const base = /^\d{4}-\d{2}-\d{2}$/.test(startDate || '')
    ? new Date(startDate + 'T00:00:00Z')
    : new Date(Date.now() + 864e5);   // tomorrow
  const out = [];
  for (const t of person.times) {
    const time = parseWhen(t.when);
    if (!time) continue;

    // "Mon to Fri" anywhere in the text means weekdays only.
    const weekdays = /\bmon(day)?\s*(to|-|\u2013)\s*fri(day)?\b/i.test(t.when + ' ' + t.what);
    // A weekday event starts on the next weekday (0 = Sunday, 6 = Saturday).
    const first = new Date(base);
    if (weekdays) {
      while ([0, 6].includes(first.getUTCDay())) first.setUTCDate(first.getUTCDate() + 1);
    }
    const until = new Date(base);
    until.setUTCDate(until.getUTCDate() + WEEKS * 7 - 1);

    // RRULE is the calendar-file way of saying how an event repeats.
    const repeat = weekdays ? 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' : 'FREQ=DAILY';
    const rrule = repeat + ';UNTIL=' + ymd(until) + 'T235959';
    const details = String(t.what || '') + (person.timesNote ? '\n\n' + person.timesNote : '');
    out.push({ title: title(t.what), when: t.when, details, date: ymd(first), start: hm(time.start), end: hm(time.end), rrule, weekdays });
  }
  return { name: person.name || personKey, events: out };
}

// Calendar files need \ ; , and new lines written with a backslash in front.
function esc(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

// Calendar file lines can be at most 75 bytes. Longer lines are split, and each
// continuation line starts with a space.
function fold(line) {
  const out = [];
  let current = '';
  for (const ch of line) {
    const limit = out.length ? 74 : 75;   // continuation lines lose one byte to the leading space
    if (Buffer.byteLength(current + ch) > limit) {
      out.push(current);
      current = '';
    }
    current += ch;
  }
  out.push(current);
  return out.join('\r\n ');
}

// Writes the events as a calendar (.ics) file, each with a reminder.
function ics(cal) {
  const now = new Date();
  const stamp = ymd(now) + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//shopping-list-selfhost//meal plan//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + esc(cal.name + "'s eating times"),
  ];
  for (const e of cal.events) {
    // A stable id, so importing the file again updates events instead of doubling them.
    const uid = crypto.createHash('sha1').update(cal.name + e.when + e.title + e.date).digest('hex').slice(0, 16) + '@shopping-list';
    lines.push(
      'BEGIN:VEVENT',
      'UID:' + uid,
      'DTSTAMP:' + stamp,
      'DTSTART:' + e.date + 'T' + e.start,
      'DTEND:' + e.date + 'T' + e.end,
      'RRULE:' + e.rrule,
      'SUMMARY:' + esc(e.title),
      'DESCRIPTION:' + esc(e.details),
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'TRIGGER:-PT' + REMIND_MIN + 'M',
      'DESCRIPTION:' + esc(e.title),
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// Answers /api/calendar/<person>.ics or .json. Returns true if it answered the request.
function handle(req, res, urlPath, url) {
  const m = /^\/api\/calendar\/([a-z0-9_-]+)\.(ics|json)$/.exec(urlPath);
  if (!m || req.method !== 'GET') return false;
  const [, personKey, format] = m;

  let cal;
  try {
    cal = events(personKey, url.searchParams.get('start'));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"could not read plan.json"}');
    return true;
  }
  if (!cal) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"no suggested times for that person"}');
    return true;
  }
  if (format === 'json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(cal));
    return true;
  }
  const fileName = cal.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-eating-times.ics';
  res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'inline; filename="' + fileName + '"', 'Cache-Control': 'no-store' });
  res.end(ics(cal));
  return true;
}

module.exports = { handle, parseWhen, events, ics };
