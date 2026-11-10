// Shared bits for the tests: starting a throwaway copy of the server, and talking to it.
//
// startServer() runs api/server.js on a spare port with its own empty data folder and its own copy
// of the site files, in a temporary folder. Your real data/ and site/plan.json are never touched.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');

// Asks the computer for a port number nothing else is using.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

// Starts the server in a temporary folder. Returns {url, dir, request, stop}.
async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhp-test-'));
  const site = path.join(dir, 'site');
  const data = path.join(dir, 'data');
  fs.mkdirSync(site);
  fs.mkdirSync(data);
  for (const f of ['plan.example.json', 'questions.json', 'regions.js', 'guidelines.json']) {
    fs.copyFileSync(path.join(ROOT, 'site', f), path.join(site, f));
  }
  const port = await freePort();
  const env = {
    PATH: process.env.PATH,
    PORT: String(port),
    DATA_DIR: data,
    PLAN_FILE: path.join(site, 'plan.json'),
    PLAN_EXAMPLE: path.join(site, 'plan.example.json'),
    QUESTIONS_FILE: path.join(site, 'questions.json'),
    SESSION_SECRET: 'test-secret-not-for-real-use',
    LIBRARY_UPDATES_URL: 'http://127.0.0.1:9/no-downloads-in-tests',   // nothing is fetched from GitHub
    ...extraEnv,
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'api', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const url = 'http://127.0.0.1:' + port;

  // Waits up to 10 seconds for the server to answer.
  for (let i = 0; ; i++) {
    try { await fetch(url + '/auth/status'); break; } catch (e) {
      if (i > 100 || child.exitCode !== null) throw new Error('The server didn’t start:\n' + log);
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Sends a request like a browser would, keeping the login cookie between calls.
  let cookie = '';
  async function request(method, urlPath, body, headers = {}) {
    const form = body instanceof URLSearchParams;
    const res = await fetch(url + urlPath, {
      method,
      redirect: 'manual',
      headers: {
        ...(body ? { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
        ...(body && !form ? { 'X-Requested-With': 'app' } : {}),   // the pages send this with every change
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body ? (form ? body.toString() : JSON.stringify(body)) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { status: res.status, json, text, location: res.headers.get('location') };
  }

  // Stops the server and deletes the temporary folder.
  async function stop() {
    child.kill();
    await new Promise(r => child.once('exit', r));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { url, dir, request, stop, log: () => log, forgetCookie: () => { cookie = ''; } };
}

module.exports = { startServer, ROOT };
