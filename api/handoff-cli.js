// Lets a Claude Code session write the family's plan, for families without an AI API key.
// Run through tools/claude-code-plan.sh (it runs this inside the api container):
//
//   prompt ["note"]   writes data/claude-code/prompt.md: the same instructions and About me answers
//                     the app's AI would get. Health details are in it, so it stays in data/.
//   submit [file]     sends the plan (default data/claude-code/plan.json) to the app. It is checked
//                     like an AI-written plan and waits on Plan setup for an admin to approve.
//
// It talks to the running server as the family's owner, using a login cookie made here.
const fs = require('fs');
const path = require('path');
const auth = require('./auth');
const db = require('./db');

const DIR = '/data/claude-code';
const BASE = 'http://127.0.0.1:' + (process.env.PORT || 3000);

function cookie() {
  const owner = db.listAccounts().find(a => a.role === 'owner') || db.listAccounts().find(a => a.role === 'admin');
  if (!owner) throw new Error('No owner account yet. Create the family\'s first account in the app first.');
  return auth.loginCookie({ headers: {} }, 'acct-' + owner.id).split(';')[0];
}

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { Cookie: cookie(), 'X-Requested-With': 'app', 'Content-Type': 'application/json' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'The server said ' + res.status);
  return data;
}

async function main() {
  const [what, arg] = process.argv.slice(2);
  fs.mkdirSync(DIR, { recursive: true });
  if (what === 'prompt') {
    const d = await call('GET', '/api/plan/handoff?note=' + encodeURIComponent(arg || ''));
    const file = path.join(DIR, 'prompt.md');
    fs.writeFileSync(file, '# Instructions\n\n' + d.system + '\n\n# The family\n\n' + d.user + '\n\n# Where to put it\n\nSave the plan as one JSON object in data/claude-code/plan.json (include "notesForAdmin"), then run: tools/claude-code-plan.sh submit\n');
    console.log('Wrote data/claude-code/prompt.md (' + Math.round(fs.statSync(file).size / 1024) + ' KB).');
    return;
  }
  if (what === 'submit') {
    const file = arg ? path.resolve('/data', path.relative('data', arg)) : path.join(DIR, 'plan.json');
    if (!file.startsWith('/data/')) throw new Error('The plan file must be inside the data folder.');
    const text = fs.readFileSync(file, 'utf8');
    JSON.parse(text);   // a clear error here beats one from the server
    await call('POST', '/api/plan/handoff', text);
    console.log('Sent. It is waiting on Plan setup for an admin to approve.');
    return;
  }
  console.log('Usage: tools/claude-code-plan.sh prompt ["a note for the plan"]\n       tools/claude-code-plan.sh submit [data/claude-code/plan.json]');
  process.exitCode = 1;
}

main().catch(e => {
  console.error('Error: ' + e.message);
  process.exitCode = 1;
});
