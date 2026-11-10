// Per-person file uploads for the "My files" page (Lose It exports, Apple Health, blood tests, photos).
// No npm packages.
//
// Files are kept in plain folders so they are easy to find on the server:
//   data/uploads/<person>/<category>/<YYYY-MM-DD> <original name>
//   e.g. data/uploads/alex/blood-tests/2026-11-08 Blood results.pdf
//
// Everyone sees only their own files. Admins can see, add and delete anyone's.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const ROOT = path.join(DATA_DIR, 'uploads');
const MAX = 2 * 1024 * 1024 * 1024;   // 2 GB: Apple Health exports can be large

// Each kind of file: its folder name (id), the label on the page, a hint, and the file types it accepts.
const CATEGORIES = [
  { id: 'lose-it', label: 'Lose It', hint: 'Exports from Lose It (Settings → Export data), usually CSV or zip.', ext: ['csv', 'zip', 'xlsx', 'txt', 'pdf'] },
  { id: 'apple-health', label: 'Apple Health', hint: 'Health app → your picture → Export All Health Data (a zip), or a summary.', ext: ['zip', 'xml', 'csv', 'pdf', 'json', 'txt'] },
  { id: 'blood-tests', label: 'Blood tests', hint: 'Pathology results as a PDF or a photo.', ext: ['pdf', 'jpg', 'jpeg', 'png', 'heic', 'txt'] },
  { id: 'photos', label: 'Photos', hint: 'Progress photos, meals or food labels.', ext: ['jpg', 'jpeg', 'png', 'heic', 'webp'] },
  { id: 'other', label: 'Other', hint: 'Anything else that helps with the plan.', ext: ['pdf', 'csv', 'zip', 'xlsx', 'txt', 'json', 'xml', 'jpg', 'jpeg', 'png', 'heic', 'webp', 'docx'] },
];

// The same list, but looked up by id: CATEGORY_BY_ID['photos'] gives the photos entry.
const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

// File types the browser may show directly (in a tab). Everything else downloads as a file,
// so an uploaded file can never run as a web page.
const INLINE = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
};

// Written to data/uploads/README.txt, for anyone looking at the folders on the server.
const README = `Uploaded files, one folder per person, then one per type:

  uploads/<person>/<type>/<date uploaded> <original file name>

  e.g. uploads/alex/blood-tests/2026-11-08 Blood results.pdf

Types:
${CATEGORIES.map(c => '  ' + c.id.padEnd(13) + c.label + ': ' + c.hint).join('\n')}

People upload these from the app (account menu → My files). Each person sees
only their own files there; admins can see everyone's. Files can also be added
or removed here directly. The app just lists what is in these folders.
`;

// Makes every person's folders up front, so the layout is easy to see on the server.
// It only does the work again when the list of people changes.
let foldersMadeFor = '';
// Makes the uploads folder and a folder for each person (once per list of people), with a README.
function ensureRoot(people) {
  const key = people.join(',');
  if (foldersMadeFor === key) return;
  fs.mkdirSync(ROOT, { recursive: true });
  const readme = path.join(ROOT, 'README.txt');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
  for (const person of people) {
    for (const c of CATEGORIES) fs.mkdirSync(path.join(ROOT, person, c.id), { recursive: true });
  }
  foldersMadeFor = key;
}

// Sends a JSON answer with an HTTP status code.
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// The file type from a name, lower case and without the dot: "Results.PDF" gives "pdf".
function ext(name) {
  return (path.extname(name).slice(1) || '').toLowerCase();
}

// Keeps the original name readable but safe: no folders, no hidden files, no odd characters,
// and at most 120 characters (keeping the ".pdf" on the end).
function cleanName(name) {
  // Only the last part of a path like "C:\Users\me\results.pdf".
  let n = path.basename(String(name || '').replace(/\\/g, '/')).normalize('NFC');
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*\/]/g, '');   // characters that are unsafe in file names
  n = n.replace(/\s+/g, ' ').trim();
  n = n.replace(/^\.+/, '');                              // a leading dot would hide the file
  if (n.length > 120) {
    const extension = path.extname(n);
    n = n.slice(0, 120 - extension.length).trim() + extension;
  }
  return n;
}

// Today's date as YYYY-MM-DD, in the server's time zone.
function today() {
  const d = new Date();
  const twoDigits = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + twoDigits(d.getMonth() + 1) + '-' + twoDigits(d.getDate());
}

// Picks a name that is not taken yet: "2026-11-08 Blood results.pdf",
// then "2026-11-08 Blood results (2).pdf", "(3)" and so on.
function freeName(dir, name) {
  const extension = path.extname(name);
  const base = name.slice(0, name.length - extension.length);
  let candidate = today() + ' ' + name;
  let number = 2;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = today() + ' ' + base + ' (' + number + ')' + extension;
    number++;
  }
  return candidate;
}

// True if a path is inside the uploads folder (a safety check against "../" tricks).
function inside(p) {
  const resolved = path.resolve(p);
  return resolved.startsWith(path.resolve(ROOT) + path.sep);
}

// Works out whose files a request is for (?person=..., or your own), and refuses anything not allowed.
// Returns {person} or {err: [status code, message]}.
function target(url, me, people) {
  const person = String(url.searchParams.get('person') || me.person || '').toLowerCase();
  if (!people.includes(person)) return { err: [404, 'unknown person'] };
  if (!me.admin && person !== me.person) return { err: [403, 'you can only see your own files'] };
  return { person };
}

// Works out which existing file a request means (?category=...&name=...).
// Returns {c: category, name, f: full path} or {err: [status code, message]}.
function fileTarget(url, who) {
  const c = CATEGORY_BY_ID[url.searchParams.get('category')];
  if (!c) return { err: [400, 'unknown category'] };
  const name = String(url.searchParams.get('name') || '');
  const isPlainName = name && name === path.basename(name) && !name.startsWith('.');
  if (!isPlainName) return { err: [400, 'bad file name'] };
  const f = path.join(ROOT, who.person, c.id, name);
  if (!inside(f)) return { err: [400, 'bad file name'] };
  return { c, name, f };
}

// Lists one person's files, grouped by category, newest first.
function list(person) {
  return CATEGORIES.map(c => {
    const dir = path.join(ROOT, person, c.id);
    let files = [];
    try {
      files = fs.readdirSync(dir)
        .filter(n => !n.startsWith('.') && !n.endsWith('.part'))   // skip hidden files and unfinished uploads
        .map(n => {
          const info = fs.statSync(path.join(dir, n));
          return info.isFile() ? { name: n, size: info.size, at: info.mtimeMs } : null;
        })
        .filter(Boolean);
    } catch (e) {
      // The folder does not exist yet, so there are no files.
    }
    files.sort((a, b) => b.name.localeCompare(a.name));   // names start with the date, so this is newest first
    return { id: c.id, label: c.label, hint: c.hint, accept: c.ext.map(e => '.' + e).join(','), files };
  });
}

// Streams the upload straight to disk, so even a 2 GB file never has to fit in memory.
// It is saved as a hidden ".<name>.part" file and only renamed to its real name once complete.
function save(req, res, dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const finalName = freeName(dir, name);
  const tempFile = path.join(dir, '.' + finalName + '.part');
  const out = fs.createWriteStream(tempFile, { flags: 'wx' });   // 'wx' = fail if it already exists
  let size = 0;
  let failed = false;

  // Stops the upload, removes the partial file and tells the page why (only once).
  const fail = (code, message) => {
    if (failed) return;
    failed = true;
    out.destroy();
    fs.rm(tempFile, { force: true }, () => {});
    if (!res.headersSent) send(res, code, { error: message });
    // Stop the upload only once the answer has gone out, so the page sees the message
    // instead of a dropped connection.
    if (res.writableFinished) req.destroy();
    else res.on('finish', () => req.destroy());
  };

  req.on('data', chunk => {
    size += chunk.length;
    if (size > MAX) fail(413, 'That file is over 2 GB.');
  });
  req.on('aborted', () => fail(400, 'The upload was cancelled.'));
  out.on('error', e => fail(500, 'Could not save the file: ' + e.message));

  // Called when everything has been written to the temporary file.
  out.on('finish', () => {
    if (failed) return;
    if (!size) {
      fs.rm(tempFile, { force: true }, () => {});
      return send(res, 400, { error: 'The file is empty.' });
    }
    fs.rename(tempFile, path.join(dir, finalName), err => {
      if (err) send(res, 500, { error: 'Could not save the file.' });
      else send(res, 200, { ok: true, name: finalName, size });
    });
  });

  req.pipe(out);   // copy the request body into the file as it arrives
}

// POST /api/uploads?category=...&name=...: checks the upload is allowed, then saves it.
function upload(req, res, url, who) {
  const c = CATEGORY_BY_ID[url.searchParams.get('category')];
  if (!c) return send(res, 400, { error: 'Pick what kind of file this is.' });
  const name = cleanName(url.searchParams.get('name'));
  if (!name || !ext(name)) return send(res, 400, { error: 'The file needs a name with a type, like results.pdf.' });
  if (!c.ext.includes(ext(name))) return send(res, 400, { error: c.label + ' takes ' + c.ext.join(', ') + ' files.' });
  if (+req.headers['content-length'] > MAX) return send(res, 413, { error: 'That file is over 2 GB.' });
  save(req, res, path.join(ROOT, who.person, c.id), name);
}

// GET /api/uploads/file: sends a file back, either to view in the browser or (?download=1) to save.
function download(res, url, file) {
  let info;
  try {
    info = fs.statSync(file.f);
  } catch (e) {
    return send(res, 404, { error: 'not found' });
  }
  const type = INLINE[ext(file.name)];
  const asDownload = url.searchParams.get('download') === '1' || !type;
  res.writeHead(200, {
    'Content-Type': type || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': (asDownload ? 'attachment' : 'inline') + "; filename*=UTF-8''" + encodeURIComponent(file.name),
    // Even if a file is opened in the browser, it cannot run scripts or load anything else.
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
  });
  // If the file can't be read after all (deleted a moment ago, say), end this download quietly:
  // an unhandled stream error would stop the whole server.
  const stream = fs.createReadStream(file.f);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// Answers every /api/uploads... request. Returns true if it handled the request.
async function handle(req, res, urlPath, url, me, people) {
  if (!urlPath.startsWith('/api/uploads')) return false;
  ensureRoot(people);

  const who = target(url, me, people);
  if (who.err) {
    send(res, who.err[0], { error: who.err[1] });
    return true;
  }

  // Changes must come from the app itself (a second guard on top of the SameSite login cookie).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'files') {
    send(res, 403, { error: 'bad request' });
    return true;
  }

  if (urlPath === '/api/uploads' && req.method === 'GET') {
    send(res, 200, { person: who.person, people: me.admin ? people : [me.person], categories: list(who.person) });
    return true;
  }
  if (urlPath === '/api/uploads' && req.method === 'POST') {
    upload(req, res, url, who);
    return true;
  }
  if (urlPath === '/api/uploads/file') {
    const file = fileTarget(url, who);
    if (file.err) {
      send(res, file.err[0], { error: file.err[1] });
      return true;
    }
    if (req.method === 'GET') {
      download(res, url, file);
      return true;
    }
    if (req.method === 'DELETE') {
      fs.rm(file.f, { force: true }, err => {
        if (err) send(res, 500, { error: 'Could not delete it.' });
        else send(res, 200, { ok: true });
      });
      return true;
    }
  }

  send(res, 404, { error: 'not found' });
  return true;
}

// Deletes everything a person uploaded (when they delete their account and history).
function forget(person) {
  // Keys can start with "-" (a name like "Émile" gives "-mile"), but never contain anything else.
  if (!/^[a-z0-9-]+$/.test(String(person || '')) || !/[a-z0-9]/.test(person)) return;
  const dir = path.join(ROOT, person);
  if (path.dirname(dir) !== ROOT) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { handle, CATEGORIES, ROOT, forget };
