// Getting the family's plan ready: who has finished their About me questions, and asking Claude
// to draft a whole new 4-week plan from everyone's answers.
//
//   GET  /api/plan/setup     admins: everyone in the plan, how far through About me they are, and
//                            the draft (running, failed, or waiting to be approved)
//   POST /api/plan/draft     admins: start a draft ({note}: anything Claude should know). It runs
//                            in the background and takes several minutes.
//
// A finished draft is saved as a request (like Ask Claude's suggestions) that replaces the plan's
// weeks, people, exercise, macros and food groups. Nothing changes until an admin approves it,
// and approving it backs up the old plan first (see savePlan in server.js). The new plan has a
// new id, so everyone's ticks start fresh.
const fs = require('fs');
const db = require('./db');
const auth = require('./auth');
const assistant = require('./assistant');
const planchange = require('./planchange');
const appearance = require('./appearance');

const QUESTIONS_FILE = process.env.QUESTIONS_FILE || '/site/questions.json';
const EXAMPLE_FILE = process.env.PLAN_EXAMPLE || '/site/plan.example.json';
const DOCS_FILE = '/docs/plan-format.md';
const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
const EXPECTED_CHARS = 110000;   // about how long a full plan is, for the progress bar
const REPLACED = ['id', 'title', 'subtitle', 'weeks', 'people', 'exercise', 'macros', 'groups'];

let Anthropic = null;
try {
  const sdk = require('@anthropic-ai/sdk');
  Anthropic = sdk.Anthropic || sdk.default || sdk;
} catch (e) {
  // assistant.setup() explains what's missing.
}

// The one draft that can run at a time. Kept in memory: a restart loses a draft in progress.
// {state: "running" | "failed", by, started, chars, stage, error}
let job = null;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 20000) reject(new Error('too big'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// How many About me questions there are, for "12 of 40 answered".
function questionCount() {
  const q = readJson(QUESTIONS_FILE);
  return q ? q.sections.reduce((n, s) => n + s.questions.length, 0) : 0;
}

// Everyone in the plan, with how far through About me they are and whether they can log in.
function household(ctx) {
  const plan = ctx.readPlan() || {};
  const accounts = db.listAccounts();
  // Older username logins (from .env or the old Admin page) that haven't become accounts.
  const older = new Set(auth.users().concat(db.listLogins().map(l => l.username))
    .filter(u => !auth.isLinked(u)).map(u => auth.describe(u).person));
  return Object.keys(plan.people || {})
    .filter(key => plan.people[key] && plan.people[key].name)
    .map(key => {
      const p = plan.people[key];
      const person = ctx.toKey(p.name);
      const profile = db.getProfile(person);
      const answers = profile ? profile.answers : {};
      const account = accounts.find(a => a.person === person);
      return {
        key, person, name: p.name, portion: p.portion,
        login: account ? account.role : older.has(person) ? 'username' : null,
        answered: Object.keys(answers).length,
        finished: !!(profile && profile.finished_at),
        updated: profile ? profile.updated_at : null,
        answers,
      };
    });
}

// The newest whole-plan draft that is still waiting for an admin, or null.
function pendingDraft() {
  const r = db.listRequests(null).find(x => x.status === 'open' && x.change && x.change.kind === 'full-plan');
  return r || null;
}

// What the setup page shows about a waiting draft: the weeks, their cost and dinners, and each
// person's snacks and exercise focus, so the admin can see what they are approving.
function draftPreview(r) {
  const plan = r.change.preview || {};
  return {
    id: r.id, title: r.title, details: r.details, created_at: r.created_at, user: r.user,
    weeks: (plan.weeks || []).map(w => ({
      name: w.name, kind: w.kind || null, cost: w.cost,
      dinners: (w.meals || []).map(m => m.day + ': ' + m.dinner),
    })),
    people: Object.entries(plan.people || {}).filter(([, p]) => p && p.name).map(([key, p]) => ({
      key, name: p.name, portion: p.portion,
      snacks: (p.snacks || []).map(s => (s.when ? s.when + ': ' : '') + s.what),
      focus: plan.weeks && plan.weeks.filter(w => w.exercise).map(w => w.exercise[key] && w.exercise[key].focus).filter(Boolean)[0] || null,
    })),
  };
}

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

function systemText() {
  let docs = '';
  try { docs = fs.readFileSync(DOCS_FILE, 'utf8'); } catch (e) { /* the example still shows the shape */ }
  let example = '';
  try { example = fs.readFileSync(EXAMPLE_FILE, 'utf8'); } catch (e) { /* ok */ }
  return `You write complete 4-week meal and exercise plans for a family's self-hosted planner app. The family is in Australia. You reply with one JSON object (the whole plan) and nothing else: no prose, no code fences.

The plan must follow the format guide below exactly, because the app reads it directly. Use the example plan as a model for the shape and the level of detail.

Structure:
- "weeks" has six entries in this order: "Stock-up 1" (kind "stockup": pantry and freezer items for weeks 1 and 2), "Week 1", "Week 2", "Stock-up 2" (for weeks 3 and 4), "Week 3", "Week 4". Each meal week has "meals" (Mon to Sun), full "recipes" (with "items" amounts for the whole household), "shopping" (fresh food for that week; sections named like "Fruit and veg", "Meat and fish", "Dairy and eggs", "Bread and pantry top-ups"), "exercise" (one plan per person key, with "focus", "targets" and "days"), and "cost".
- Shopping prices are estimates in AUD for the family's supermarkets. Each week's "cost" is the sum of its items.
- "people": use exactly the person keys and names given, with "portion" (1.0 is an average adult serve; children smaller), "guide", "tips", and "snacks". Tie snacks to exercise where it makes sense with "exercise": "strength" (e.g. a glass of milk after weights) or "rest". Add "times" (suggested eating times) when the person's routine is known.
- "exercise" at the top level: per person key, "workouts" (named like "Strength A: ..." so the day plan can mention "Strength A"), "notes" and "medical".
- "macros" and "groups": an entry for every dish and snack name used, per average serve (your best estimate).
- "id": a new id like "family-plan-YYYY-MM-DD". "title": "Meal and exercise plan". "subtitle": the fortnightly cost summary.
- Add a top-level "notesForAdmin": two to five short sentences on how the plan fits the family (it is removed before saving).

Food:
- Strictly respect every allergy, intolerance, diet and food someone won't eat. Keep each person's safe foods in their plan. Avoid textures people listed as hard. Fit cooking time, kitchen equipment, packed lunches and budget to their answers.
- Shared family dinners where possible, with a different dish for one person (meals[].people) only when needed. Reuse ingredients across the week to cut waste and cost, and use leftovers for lunches.
- Children: normal growing portions, never weight-loss. No very low energy intakes, crash diets or supplements.

Exercise:
- Fit each adult's goals, time, equipment, current activity and anything they said about injuries or health. Start gently and build over the 4 weeks. Children: play-based, about an hour of activity a day counting school and sport.

Health wording (important):
- Write anything about health as what the person told you, not as fact or instruction: "You said your physio is happy for you to do squats", not "Your physio has cleared squats". Prefer "consider", "may" and "it may be worth checking with" over absolutes like "always", "never" or "must". Put what a doctor, physio or other health professional said, and when to stop and get checked, in exercise.medical for that person. Call it information or considerations, never advice. Their health professional's advice comes first.
- Don't diagnose, and don't comment on anyone's support needs; just fit the plan to them.

Style: plain Australian English, metric units, kilojoules (kJ).

<format_guide>
${docs}
</format_guide>

<example_plan>
${example}
</example_plan>`;
}

function userText(ctx, people, note) {
  const stores = appearance.storesFor(null);
  const names = { coles: 'Coles', woolworths: 'Woolworths', aldi: 'Aldi', iga: 'IGA', foodland: 'Foodland (SA)', spudshed: 'Spudshed (WA)', drakes: 'Drakes' };
  const lines = [
    'Today is ' + new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + '.',
    'The family shops at: ' + (stores.map(k => names[k] || k).join(', ') || 'Coles') + '.',
    '',
    'The people in the plan (use these keys and names exactly):',
  ];
  for (const p of people) {
    lines.push('- key "' + p.key + '", name "' + p.name + '"' + (p.portion ? ', current portion ' + p.portion : '') +
      (p.answered ? '' : ' (no About me answers yet: plan sensibly from what the others said, and keep it simple)'));
  }
  lines.push('', 'Their About me answers:');
  for (const p of people) {
    if (p.answered) lines.push('<person key="' + p.key + '">' + JSON.stringify(p.answers) + '</person>');
  }
  if (note) lines.push('', 'A note from the admin who asked for this plan:', '<note>' + note + '</note>');
  lines.push('', 'Write the whole plan now, as one JSON object.');
  return lines.join('\n');
}

// The plan JSON from Claude's reply: the text from the first "{" to the last "}".
function parsePlan(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Claude didn’t send a plan.');
  return JSON.parse(text.slice(start, end + 1));
}

// Fills in each week's cost from its items, so the totals always add up.
function fixCosts(plan) {
  for (const w of plan.weeks || []) {
    let sum = 0;
    for (const items of Object.values(w.shopping || {})) for (const it of items) sum += Number(it[1]) || 0;
    w.cost = Math.round(sum * 100) / 100;
  }
}

// ---------------------------------------------------------------------------
// Running a draft
// ---------------------------------------------------------------------------

async function runDraft(me, client, ctx, note) {
  const people = household(ctx);
  const known = new Set(people.map(p => p.key));
  let text = '';
  try {
    job.stage = 'Writing the plan';
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 100000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: systemText(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userText(ctx, people, note) }],
    });
    stream.on('text', delta => {
      text += delta;
      job.chars = text.length;
      const weeks = text.match(/"name":\s*"((?:Stock-up|Week) \d)"/g);
      if (weeks) job.stage = 'Writing ' + weeks[weeks.length - 1].replace(/"name":\s*"/, '').replace(/"$/, '');
    });
    const message = await stream.finalMessage();
    if (message.stop_reason === 'max_tokens') throw new Error('The plan was too long and got cut off. Try again, perhaps with a note asking for simpler recipes.');
    if (message.stop_reason === 'refusal') throw new Error('Claude couldn’t write this plan. Check the About me answers and try again.');

    job.stage = 'Checking the plan';
    let plan;
    try {
      plan = parsePlan(text);
    } catch (e) {
      throw new Error('The plan Claude sent couldn’t be read (' + String(e.message).slice(0, 120) + '). Try again.');
    }
    const forAdmin = typeof plan.notesForAdmin === 'string' ? plan.notesForAdmin.slice(0, 2000) : '';
    delete plan.notesForAdmin;
    fixCosts(plan);
    // Only people already in the household, so logins and About me answers stay matched up.
    for (const key of Object.keys(plan.people || {})) if (!known.has(key)) delete plan.people[key];
    for (const p of people) if (!plan.people || !plan.people[p.key]) throw new Error('The plan left out ' + p.name + '. Try again.');
    const problem = ctx.checkPlan(plan);
    if (problem) throw new Error('The plan didn’t pass the app’s checks: ' + problem + ' Try again.');

    // Saved as one request that sets each top-level part of the plan.
    const steps = REPLACED.filter(k => plan[k] !== undefined).map(k => ({ op: 'set', path: [k], value: plan[k] }));
    const current = ctx.readPlan() || { weeks: [] };
    const tried = planchange.apply(current, steps, ctx.checkPlan, { maxValue: planchange.FULL_PLAN_MAX });
    if (tried.error) throw new Error('The plan couldn’t be applied: ' + tried.error);
    const fortnights = [plan.weeks.slice(0, 3), plan.weeks.slice(3, 6)].map(f => f.reduce((n, w) => n + (w.cost || 0), 0));
    const summary = [
      'Replaces the whole plan: 4 weeks of meals, recipes, shopping and exercise for ' + people.map(p => p.name).join(', ') + '.',
      'Shopping: about $' + Math.round(fortnights[0]) + ' for weeks 1 and 2, and $' + Math.round(fortnights[1]) + ' for weeks 3 and 4.',
      'Everyone’s ticks start fresh. The current plan is backed up first.',
    ];
    // Older drafts that were never decided are replaced by this one.
    for (const old of db.listRequests(null).filter(x => x.status === 'open' && x.change && x.change.kind === 'full-plan')) {
      db.setRequestStatus(old.id, 'withdrawn', me.user, 'Replaced by a newer draft.');
    }
    db.addRequest({
      person: me.person, user: me.user, title: 'New 4-week plan for the family', details: forAdmin || null,
      change: { kind: 'full-plan', steps, summary, preview: { weeks: plan.weeks, people: plan.people } },
      status: 'open',
    });
    job = null;
  } catch (err) {
    let message = String(err && err.message || err);
    if (Anthropic && err instanceof Anthropic.AuthenticationError) message = 'The Claude key wasn’t accepted. Check it in Settings.';
    else if (Anthropic && err instanceof Anthropic.RateLimitError) message = 'Claude is busy right now (rate limit). Try again in a few minutes.';
    else if (Anthropic && err instanceof Anthropic.APIError) message = 'Claude couldn’t finish the plan: ' + String(err.message || '').slice(0, 300);
    job = { state: 'failed', by: job && job.by, started: job && job.started, error: message };
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handle(req, res, urlPath, url, me, ctx) {
  if (urlPath !== '/api/plan/setup' && urlPath !== '/api/plan/draft') return false;
  if (!me.admin) {
    send(res, 403, { error: 'Only an admin can set up the family’s plan.' });
    return true;
  }
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'app') {
    send(res, 403, { error: 'bad request' });
    return true;
  }

  if (req.method === 'GET') {
    const ready = assistant.setup(me);
    const pending = pendingDraft();
    send(res, 200, {
      people: household(ctx).map(p => Object.assign({}, p, { answers: undefined })),
      questions: questionCount(),
      claude: { enabled: ready.enabled, own: !!ready.own, reason: ready.reason || null },
      job: job ? { state: job.state, by: job.by, started: job.started, stage: job.stage || '', error: job.error || null,
        progress: job.state === 'running' ? Math.min(0.97, (job.chars || 0) / EXPECTED_CHARS) : null } : null,
      draft: pending ? draftPreview(pending) : null,
      isExample: !(ctx.readPlan() || {}).people || /^example/i.test(String((ctx.readPlan() || {}).id || '')),
    });
    return true;
  }

  if (urlPath === '/api/plan/draft' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { send(res, 400, { error: 'bad request' }); return true; }
    if (job && job.state === 'running') {
      send(res, 409, { error: 'A plan is already being drafted. It takes a few minutes.' });
      return true;
    }
    const ready = assistant.setup(me);
    if (!ready.enabled) {
      send(res, 400, { error: ready.reason || 'Claude isn’t set up.' });
      return true;
    }
    if (!household(ctx).length) {
      send(res, 400, { error: 'Add the people in your family first.' });
      return true;
    }
    job = { state: 'running', by: me.user, started: Date.now(), chars: 0, stage: 'Starting' };
    runDraft(me, ready.client, ctx, String(body.note || '').slice(0, 2000));
    send(res, 202, { ok: true });
    return true;
  }

  send(res, 404, { error: 'not found' });
  return true;
}

module.exports = { handle, household };
