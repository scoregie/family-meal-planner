// The page check (run it with tools/page-check.sh, which explains how to use it).
//
// It opens every page of the app in a pretend browser (jsdom) against a throwaway copy of the
// server, presses every button, tick box and fold in turn, and writes down what the page looked
// like after each press. Record the code before and after a change that shouldn't alter what
// the app does (a tidy-up): if the two recordings match, the pages behave the same.
//
// Your family's data is never touched: the server it starts has its own empty data folder in a
// temporary folder, with the example plan and a made-up person.
//
// To make two recordings comparable, nothing is left to chance: the page's clock and the
// server's clock are fixed, timers run on a pretend clock, and "random" numbers repeat.
//
//   node page-check.js record <folder with api/ and site/> <folder to write to> [only pages with this in their name]
//   node page-check.js compare <one recording's folder> <another's>
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const MODE = process.argv[2], REPO = process.argv[3], OUT = process.argv[4], ONLY = process.argv[5] || '';
const API_PORT = 18555, WEB_PORT = 19555;   // only used inside the container
const API = 'http://127.0.0.1:' + API_PORT, WEB = 'http://127.0.0.1:' + WEB_PORT;
const NOW = Date.parse('2026-11-11T01:30:00Z');   // every page believes it is this moment
const sleep = ms => new Promise(r => setTimeout(r, ms));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

let cookie = '';
let current = [];   // errors from the page being visited that nothing caught
process.on('unhandledRejection', e => current.push('UNHANDLED ' + clean(String(e && e.message || e)).slice(0, 200)));
process.on('uncaughtException', e => current.push('UNCAUGHT ' + clean(String(e && e.message || e)).slice(0, 200)));
// Sends a request to the throwaway server, keeping the login cookie.
async function api(method, url, body) {
  const res = await fetch(API + url, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json', 'X-Requested-With': 'app' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  if (res.status >= 400) console.log('  setup: ' + method + ' ' + url + ' -> ' + res.status + ' ' + text.slice(0, 120));
  try { return JSON.parse(text); } catch (e) { return text; }
}

// Starts the server on a copy of the site in a temporary folder, with the example plan as the plan.
async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-check-'));
  const site = path.join(dir, 'site'), data = path.join(dir, 'data');
  fs.cpSync(path.join(REPO, 'site'), site, { recursive: true });
  fs.mkdirSync(data);
  fs.copyFileSync(path.join(site, 'plan.example.json'), path.join(site, 'plan.json'));
  const env = { PATH: process.env.PATH, PORT: String(API_PORT), DATA_DIR: data, PLAN_FILE: path.join(site, 'plan.json'), PLAN_EXAMPLE: path.join(site, 'plan.example.json'), QUESTIONS_FILE: path.join(site, 'questions.json'), SESSION_SECRET: 'page-check-not-for-real-use', LIBRARY_UPDATES_URL: 'http://127.0.0.1:9/none' };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--require', path.join(__dirname, 'page-check-clock.js'), path.join(REPO, 'api', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  for (let i = 0; ; i++) {
    try { await fetch(API + '/auth/status'); break; } catch (e) {
      if (i > 100 || child.exitCode !== null) throw new Error('server did not start:\n' + log);
      await sleep(100);
    }
  }
  return { site, child, log: () => log };
}

// Fills the throwaway server with a family, answers, numbers, food and a draft waiting for review.
async function seed(site) {
  await api('POST', '/auth/register', { email: 'owner@example.com', name: 'Alex Smith', password: 'correct horse battery', country: 'au' });
  await api('PUT', '/api/profile?person=alex-smith', { answers: { age: '41', sex: 'Male', height: '180', weight: '92', allergies: ['Peanuts'], diet: ['None'], injuries: 'Sore left knee', likes: 'curry, eggs', dislikes: 'olives' } });
  for (let i = 0; i < 12; i++) {
    const date = new Date(NOW - i * 86400000).toISOString().slice(0, 10);
    await api('POST', '/api/measurements?person=alex-smith', { weight: 92 - i * 0.2, steps: 6000 + i * 311, date });
  }
  for (const [place, text] of [['pantry', 'rice 2 kg'], ['pantry', 'tinned tomatoes x 3'], ['fridge', '6 eggs'], ['freezer', 'chicken breast 500 g'], ['other', 'dragon fruit'], ['bench', 'bananas']]) await api('POST', '/api/food', { place, text });
  await api('PUT', '/api/steps?person=alex-smith', { food: 'Sweet potato wedges', result: 'liked' });
  const plan = JSON.parse(fs.readFileSync(path.join(site, 'plan.json'), 'utf8'));
  plan.groups = {};
  await api('POST', '/api/plan/handoff', plan);
  // Anything the server starts in the background on first use gets time to finish before the pages are opened.
  // The server looks for new library meals a couple of minutes after starting (it can't reach
  // GitHub from here, so that fails). Doing it now means the page says the same thing all run.
  await api('POST', '/api/library/updates/check', {});
  await api('GET', '/api/plan/setup');
  await sleep(1500);
}

// A small web server like Caddy: the site's files, with /api/ and /auth/ passed to the server as the logged-in owner.
function startWeb(site) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, WEB);
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
          const headers = { ...req.headers, cookie, host: '127.0.0.1:' + API_PORT };
          delete headers.connection; delete headers['content-length'];
          try {
            const r = await fetch(API + req.url, { method: req.method, headers, redirect: 'manual', body: chunks.length ? Buffer.concat(chunks) : undefined });
            const buf = Buffer.from(await r.arrayBuffer());
            res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'text/plain' });
            res.end(buf);
          } catch (e) { res.writeHead(502); res.end(String(e)); }
        });
        return;
      }
      const file = path.join(site, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname));
      if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(WEB_PORT, '127.0.0.1', () => resolve(server));
  });
}

// Things that change from run to run (when an uploaded file was saved, times the server stamped,
// random ids) are blanked before comparing, and so is the text of the page's own scripts, which a
// tidy-up changes on purpose.
function clean(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>').replace(/127\.0\.0\.1:\d+/g, 'HOST').replace(/added \d{1,2} \w+ \d{4}, \d{1,2}:\d{2}(\s?[ap]m)?/gi, 'added WHEN').replace(/\b1[78]\d{11}\b/g, 'STAMP').replace(/\b[0-9a-f]{16,}\b/g, 'HEX');
}

// Opens one page, waits for it to settle, then presses each button in turn. Returns the write-up:
// a line for each press ("-- 3 button \"Done\" -> a fingerprint of the page") followed by the page itself.
// `extra` is an optional function with a page's own steps (see the list of pages below).
async function visit(name, address, extra) {
  const lines = [];
  let busy = 0, last = Date.now();
  let clock = 0, timerId = 0;
  const timers = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/Not implemented|Could not parse CSS/.test(e.message)) lines.push('ERROR ' + clean(String(e.message)).slice(0, 300) + (e.detail && e.detail.stack ? ' | ' + clean(String(e.detail.stack).split('\n').slice(0, 2).join(' ')) : '')); });
  vc.on('error', (...a) => lines.push('console.error ' + clean(a.map(String).join(' ')).slice(0, 300)));
  const dom = await JSDOM.fromURL(WEB + address, {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) {
      const RealDate = window.Date;
      // The page's clock is fixed, so "today" is the same on every run.
      class FixedDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(NOW + clock); } static now() { return NOW + clock; } }
      window.Date = FixedDate;
      // The page's timers run on a pretend clock that the visit moves forward itself, so nothing depends on how fast this computer is.
      window.setTimeout = (fn, ms, ...args) => { timers.push({ id: ++timerId, at: clock + (Number(ms) || 0), fn, args, every: 0 }); return timerId; };
      window.setInterval = (fn, ms, ...args) => { timers.push({ id: ++timerId, at: clock + (Number(ms) || 0), fn, args, every: Math.max(1, Number(ms) || 0) }); return timerId; };
      window.clearTimeout = window.clearInterval = id => { const i = timers.findIndex(x => x.id === id); if (i > -1) timers.splice(i, 1); };
      window.requestAnimationFrame = fn => window.setTimeout(() => fn(NOW + clock), 16);
      window.cancelAnimationFrame = id => window.clearTimeout(id);
      window.navigator.clipboard = { writeText: () => Promise.resolve() };
      let s = 12345;
      window.Math.random = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
      window.fetch = (u, opts) => {
        busy++;
        const full = new URL(String(u), window.location.href).href;
        const done = () => { busy--; last = Date.now(); };
        return fetch(full, opts).then(r => { done(); return r; }, e => { done(); throw e; });
      };
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      window.scrollTo = () => {};
      window.confirm = m => { lines.push('confirm: ' + m); return true; };
      window.alert = m => { lines.push('alert: ' + m); };
      window.prompt = m => { lines.push('prompt: ' + m); return 'typed answer'; };
      window.Element.prototype.scrollIntoView = () => {};
      window.HTMLCanvasElement.prototype.getContext = () => null;
      window.open = u => { lines.push('open: ' + clean(String(u))); return null; };
      // Following a link would leave the page, so it is only written down.
      window.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a[href]'); if (a && !a.getAttribute('href').startsWith('#')) { lines.push('link: ' + clean(a.getAttribute('href'))); e.preventDefault(); } }, true);
    },
  });
  const { window } = dom, { document } = window;
  // Waits until the page has stopped asking the server for things.
  async function quietNow() {
    const start = Date.now();
    for (;;) {
      await sleep(4);
      if (!busy && Date.now() - last >= 70) return true;
      if (Date.now() - start > 8000) { lines.push('(still busy after 8 s)'); return false; }
    }
  }
  // Lets the page finish: waits for its requests, then moves its pretend clock on by `ms`, running each timer as it falls due.
  async function settle(ms) {
    const until = clock + ms;
    await quietNow();
    for (let n = 0; n < 400; n++) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > until) break;
      clock = Math.max(clock, next.at);
      if (next.every) next.at = clock + next.every; else timers.shift();
      try { if (typeof next.fn === 'function') next.fn(...next.args); } catch (e) { lines.push('TIMER THROWN ' + e.message); }
      if (!await quietNow()) break;
    }
    clock = until;
  }
  // A short fingerprint of the page as it is now.
  const look = () => crypto.createHash('sha1').update(clean(document.documentElement.outerHTML)).digest('hex').slice(0, 10);
  // Wait for the page and its script files to finish loading before anything else.
  await Promise.race([new Promise(r => { if (document.readyState === 'complete') r(); else window.addEventListener('load', r); }), sleep(15000)]);
  await sleep(30);
  await settle(3000);
  lines.push('== ' + name + ' loaded ' + look());
  lines.push(clean(document.body.outerHTML));
  const startHref = window.location.href;
  // A page's own extra steps (uploading a file, reading a chart with the keyboard), written down after each one.
  if (extra) {
    const note = async label => { await sleep(700); await settle(2500); lines.push('++ ' + label + ' -> ' + look()); lines.push(clean(document.body.outerHTML)); };
    try { await extra(window, note); } catch (e) { lines.push('EXTRA THROWN ' + e.message); }
  }
  for (let k = 0; k < 150; k++) {
    const all = Array.from(document.querySelectorAll('button, summary, [role=button], input[type=checkbox], input[type=radio], select, a[href^="#"], [onclick], .chip, .tab, li[tabindex], div[tabindex]'));
    if (k >= all.length) break;
    const target = all[k];
    // Buttons that would end the visit (logging out, deleting the account) are left alone.
    if (/log ?out|sign ?out|delete (my |this )?account|remove (my |this )?account|delete everything|erase/i.test(target.textContent || '')) { lines.push('-- ' + k + ' skipped'); continue; }
    const label = target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') + (target.className && typeof target.className === 'string' ? '.' + target.className.split(/\s+/).join('.') : '') + ' "' + (target.textContent || target.value || '').trim().replace(/\s+/g, ' ').slice(0, 40) + '"';
    for (const input of document.querySelectorAll('input[type=text], input:not([type]), textarea, input[type=number]')) if (!input.value) input.value = input.type === 'number' ? '3' : 'apple';
    try {
      if (target.tagName === 'SELECT') { target.selectedIndex = (target.selectedIndex + 1) % Math.max(1, target.options.length); target.dispatchEvent(new window.Event('change', { bubbles: true })); }
      else target.click();
    } catch (e) { lines.push('THROWN ' + e.message); }
    await settle(2500);
    lines.push('-- ' + k + ' ' + clean(label) + ' -> ' + look() + (window.location.href !== startHref ? ' @' + clean(window.location.hash) : ''));
    lines.push(clean(document.body.outerHTML));
  }
  window.close();
  return lines.join('\n') + '\n';
}

// Records every page into the OUT folder, one file per page.
async function record() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const server = await startServer();
  await seed(server.site);
  const web = await startWeb(server.site);
  const pages = [];
  for (const v of ['', '-shop', '-meals', '-macros', '-exercise', '-ratings', '-more']) for (const w of [1, 2]) if (w === 1 || v === '' || v === '-meals') pages.push(['index-week' + w + (v || '-today'), '/index.html#week-' + w + v]);
  for (const f of fs.readdirSync(server.site).filter(f => f.endsWith('.html') && f !== 'index.html').sort()) pages.push([f.replace('.html', ''), '/' + f]);
  pages.push(['profile-alex', '/profile.html?person=alex-smith'], ['progress-alex', '/progress.html?person=alex-smith']);
  // Pages with steps of their own, on top of pressing every button.
  // Reading each chart with the keyboard: focus, left, left, right, Escape, then a tap on week 2.
  pages.push(['progress-keys', '/progress.html?person=alex-smith', async (window, note) => {
    const charts = Array.from(window.document.querySelectorAll('svg[role=img]'));
    for (let i = 0; i < charts.length; i++) {
      charts[i].dispatchEvent(new window.Event('focus'));
      await note('chart ' + i + ' focus');
      for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowRight', 'Escape']) {
        charts[i].dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
        await note('chart ' + i + ' ' + key);
      }
      const hit = charts[i].querySelectorAll('rect.hit')[1];
      if (hit) { hit.dispatchEvent(new window.Event('pointerdown')); await note('chart ' + i + ' tap week 2'); }
      charts[i].dispatchEvent(new window.Event('blur'));
    }
  }]);
  // Uploading: one file of a kind the box takes and one it doesn't, through the first three boxes' pickers.
  // (This comes last, because an uploaded health export changes what the Progress page shows.)
  pages.push(['files-upload', '/files.html', async (window, note) => {
    const inputs = Array.from(window.document.querySelectorAll('input[type=file]'));
    for (const input of inputs.slice(0, 3)) {
      const ext = (input.accept.split(',')[0] || '.pdf');
      const files = [new window.File(['hello from the test'], 'Test scan' + ext, { type: 'application/octet-stream' }), new window.File(['nope'], 'wrong.zzz')];
      Object.defineProperty(input, 'files', { value: files, configurable: true });
      input.dispatchEvent(new window.Event('change', { bubbles: true }));
      await note('picked files for ' + input.id);
    }
  }]);
  for (const [name, address, extra] of pages) {
    if (ONLY && !name.includes(ONLY)) continue;
    let text;
    current = [];
    // Log in again if an earlier page logged the owner out.
    if ((await fetch(API + '/auth/me', { headers: { Cookie: cookie } })).status !== 200) {
      const r = await fetch(API + '/auth/login', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner%40example.com&password=correct+horse+battery&next=%2F' });
      cookie = (r.headers.get('set-cookie') || '').split(';')[0];
      console.log('  (logged in again)');
    }
    try { text = await visit(name, address, extra); } catch (e) { text = 'VISIT FAILED ' + e.stack + '\n'; }
    if (current.length) text += current.join('\n') + '\n';
    fs.writeFileSync(path.join(OUT, name + '.txt'), text);
    const steps = (text.match(/^(--|\+\+) /gm) || []).length, errors = (text.match(/^(ERROR|console\.error|THROWN|VISIT FAILED|UNHANDLED|UNCAUGHT|EXTRA THROWN|TIMER THROWN)/gm) || []).length;
    console.log(name.padEnd(24) + String(steps).padStart(4) + ' presses' + (errors ? '  ' + errors + ' errors written down' : ''));
  }
  web.close();
  server.child.kill();
}

// Splits a recording into its steps: [{label, page}].
function steps(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (/^(==|--|\+\+) /.test(line)) out.push({ label: line.replace(/ -> \w+.*$/, ''), page: '' });
    else if (out.length) out[out.length - 1].page += line + '\n';
  }
  return out;
}

// Compares two recordings page by page. For a page that differs, shows the first press after
// which it differed and the piece of the page that changed. Returns how many pages differ.
function compare(a, b) {
  let different = 0;
  const names = [...new Set([...fs.readdirSync(a), ...fs.readdirSync(b)])].filter(f => f.endsWith('.txt')).sort();
  for (const name of names) {
    const read = dir => (fs.existsSync(path.join(dir, name)) ? fs.readFileSync(path.join(dir, name), 'utf8') : '');
    const one = read(a), two = read(b);
    if (one === two) { console.log('same       ' + name.replace('.txt', '')); continue; }
    different++;
    console.log('DIFFERENT  ' + name.replace('.txt', ''));
    const x = steps(one), y = steps(two);
    const at = x.findIndex((step, i) => !y[i] || step.label !== y[i].label || step.page !== y[i].page);
    if (at < 0 || !y[at]) { console.log('    one recording has more steps than the other (' + x.length + ' and ' + y.length + ')'); continue; }
    console.log('    first differs after: ' + x[at].label.slice(0, 90));
    let k = 0;
    while (k < x[at].page.length && x[at].page[k] === y[at].page[k]) k++;
    const piece = page => page.slice(Math.max(0, k - 80), k + 120).replace(/\s+/g, ' ');
    console.log('    ' + path.basename(a) + ': …' + piece(x[at].page) + '…');
    console.log('    ' + path.basename(b) + ': …' + piece(y[at].page) + '…');
  }
  console.log(different ? different + ' of ' + names.length + ' pages differ.' : 'All ' + names.length + ' pages are the same.');
  return different;
}

if (MODE === 'compare') process.exit(compare(REPO, OUT) ? 1 : 0);
else if (MODE === 'record') record().then(() => process.exit(0), e => { console.error(e); process.exit(1); });
else { console.error('Use tools/page-check.sh (it explains how).'); process.exit(2); }

