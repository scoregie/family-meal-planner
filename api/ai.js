// Which AI the family (and each person) uses, and a small client for the non-Claude ones.
//
// Providers:
//   anthropic  Claude, through Anthropic's SDK (assistant.js and plandraft.js call it directly)
//   openai     OpenAI's API (ChatGPT's maker)
//   gemini     Google Gemini, through its OpenAI-compatible endpoint
//   ollama     a local Ollama server on your network (free; set OLLAMA_URL on the server)
//   none       no AI: Ask AI is off, and Plan setup uses the built-in plan builder
// OpenAI, Gemini and Ollama all accept OpenAI-style chat requests, so one client below covers them
// without any extra packages.
//
// Keys:
//   - Family keys go in .env: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, OLLAMA_URL.
//     Admins pick which of those the family uses (and its model) on Plan setup or in Settings.
//   - Anyone can save their own key in Settings (Claude, OpenAI or Gemini). It is stored encrypted
//     and used for their chats and any plan they draft. Ollama is family-only, so nobody can make
//     the server connect to an address of their choosing.
//
// Chat subscriptions (ChatGPT Plus, Gemini Advanced, Claude Pro) can't be used by other apps:
// each company sells API access separately, paid per use.
const db = require('./db');
const secrets = require('./secrets');

const PROVIDERS = {
  anthropic: { name: 'Claude', company: 'Anthropic', keys: 'https://console.anthropic.com/settings/keys', keyPattern: /^sk-ant-[A-Za-z0-9_-]{20,300}$/, keyStart: 'sk-ant-' },
  openai: { name: 'OpenAI', company: 'OpenAI', keys: 'https://platform.openai.com/api-keys', base: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''), keyPattern: /^sk-[A-Za-z0-9_-]{20,300}$/, keyStart: 'sk-' },
  gemini: { name: 'Gemini', company: 'Google', keys: 'https://aistudio.google.com/apikey', base: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/+$/, ''), keyPattern: /^[A-Za-z0-9_-]{30,100}$/, keyStart: 'AIza' },
  ollama: { name: 'Ollama', company: 'your own computer', familyOnly: true },
};
const DEFAULT_CLAUDE = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
const ENV_KEY = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

function ollamaBase() {
  const u = String(process.env.OLLAMA_URL || '').trim().replace(/\/+$/, '');
  return u ? u + '/v1' : '';
}

// Which providers the server has a family key (or Ollama address) for.
function familyKeys() {
  return {
    anthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    openai: !!process.env.OPENAI_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    ollama: !!ollamaBase(),
  };
}

// The family's choice: {provider, model}. Before anyone chooses, it is Claude if there is a
// Claude key, otherwise the first provider with a key, otherwise none.
function familyChoice() {
  let saved = null;
  try { saved = JSON.parse(db.getSetting('ai-family') || 'null'); } catch (e) { /* use the default */ }
  if (saved && (saved.provider === 'none' || PROVIDERS[saved.provider])) return saved;
  const keys = familyKeys();
  const first = ['anthropic', 'openai', 'gemini', 'ollama'].find(p => keys[p]);
  return first ? { provider: first, model: first === 'anthropic' ? DEFAULT_CLAUDE : (process.env[first.toUpperCase() + '_MODEL'] || '') } : { provider: 'none' };
}

function setFamilyChoice(choice) {
  db.setSetting('ai-family', JSON.stringify(choice));
}

// A person's own saved key: {provider, key, model}, or null. Keys saved before other providers
// were added are plain Claude keys.
function ownChoice(me) {
  if (!me || !me.accountId) return null;
  const sealed = db.getAiKey(me.accountId);
  const text = sealed ? secrets.decrypt(sealed) : null;
  if (!text) return null;
  if (text.startsWith('{')) {
    try {
      const c = JSON.parse(text);
      if (PROVIDERS[c.provider] && c.key) return c;
    } catch (e) { /* fall through */ }
    return null;
  }
  return { provider: 'anthropic', key: text, model: DEFAULT_CLAUDE };
}

function saveOwn(me, choice) {
  db.setAiKey(me.accountId, choice ? secrets.encrypt(JSON.stringify(choice)) : null);
}

// What a person's AI requests use: their own key first, otherwise the family's choice.
// Returns {enabled, provider, name, model, own, key?, base?, reason?}.
function resolve(me) {
  const own = ownChoice(me);
  if (own) {
    const p = PROVIDERS[own.provider];
    return { enabled: true, own: true, provider: own.provider, name: p.name, model: own.model || (own.provider === 'anthropic' ? DEFAULT_CLAUDE : ''), key: own.key, base: p.base };
  }
  const fam = familyChoice();
  if (fam.provider === 'none') {
    return { enabled: false, provider: 'none', name: 'No AI', reason: 'Your family has chosen not to use AI. An admin can change this on Plan setup, or you can add your own AI key in Settings.' };
  }
  const p = PROVIDERS[fam.provider];
  const keys = familyKeys();
  if (!keys[fam.provider]) {
    return { enabled: false, provider: fam.provider, name: p.name, reason: 'The family uses ' + p.name + ', but the server has no key for it (' + (fam.provider === 'ollama' ? 'OLLAMA_URL' : ENV_KEY[fam.provider]) + ' in .env). Add your own AI key in Settings, or ask an admin.' };
  }
  if (fam.provider !== 'anthropic' && !fam.model) {
    return { enabled: false, provider: fam.provider, name: p.name, reason: 'An admin needs to choose which ' + p.name + ' model the family uses, on Plan setup.' };
  }
  return {
    enabled: true, own: false, provider: fam.provider, name: p.name, model: fam.model || DEFAULT_CLAUDE,
    key: fam.provider === 'ollama' ? 'ollama' : process.env[ENV_KEY[fam.provider]],
    base: fam.provider === 'ollama' ? ollamaBase() : p.base,
  };
}

class AIError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A friendly message for a failed request.
function explain(err, ready) {
  const who = ready && ready.name ? ready.name : 'The AI';
  if (err instanceof AIError) {
    if (err.status === 401 || err.status === 403) return ready && ready.own ? who + ' didn’t accept your key. Check it in Settings.' : who + ' didn’t accept the family’s key. An admin needs to check it in .env.';
    if (err.status === 429) return who + ' is busy or your account is out of credit (rate limit). Try again in a minute, or check your account.';
    if (err.status === 404) return who + ' doesn’t have the model “' + (ready && ready.model) + '”. Choose another in Settings or on Plan setup.';
    if (err.status >= 500) return who + '’s servers had a problem. Try again in a moment.';
    return who + ' said: ' + String(err.message || '').slice(0, 300);
  }
  if (err && /fetch failed|ECONNREFUSED|ENOTFOUND|timed? ?out/i.test(String(err.message || err.cause || ''))) {
    return ready && ready.provider === 'ollama' ? 'Couldn’t reach Ollama at OLLAMA_URL. Check it’s running and reachable from the server.' : 'Couldn’t reach ' + who + '. Check the server’s internet connection.';
  }
  return 'Something went wrong talking to ' + who + '. Try again in a moment.';
}

async function request(base, key, path, init) {
  const res = await fetch(base + path, Object.assign({}, init, {
    headers: Object.assign({ Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, init && init.headers),
  }));
  if (!res.ok) {
    let message = res.statusText;
    try {
      const j = await res.json();
      message = (j.error && (j.error.message || j.error)) || j.message || message;
      if (Array.isArray(j) && j[0] && j[0].error) message = j[0].error.message;
    } catch (e) { /* keep the status text */ }
    throw new AIError(res.status, String(message));
  }
  return res;
}

// The chat models a key can use, newest first, with the one we'd suggest first.
async function models(provider, key) {
  if (provider === 'anthropic') {
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.Anthropic || sdk.default || sdk;
    const page = await new Anthropic({ apiKey: key || undefined, maxRetries: 0 }).models.list({ limit: 50 }, { timeout: 15000 });
    const ids = (page.data || []).map(m => m.id);
    return ids.includes(DEFAULT_CLAUDE) ? [DEFAULT_CLAUDE].concat(ids.filter(i => i !== DEFAULT_CLAUDE)) : ids;
  }
  const base = provider === 'ollama' ? ollamaBase() : PROVIDERS[provider].base;
  if (!base) throw new AIError(400, 'OLLAMA_URL isn’t set on the server.');
  const res = await request(base, provider === 'ollama' ? 'ollama' : key, '/models', { signal: AbortSignal.timeout(15000) });
  const j = await res.json();
  let ids = (j.data || []).map(m => String(m.id || '').replace(/^models\//, '')).filter(Boolean);
  if (provider === 'openai') ids = ids.filter(i => /^(gpt-|o\d)/.test(i) && !/audio|realtime|transcribe|tts|image|search|embedding|instruct|codex/.test(i));
  if (provider === 'gemini') ids = ids.filter(i => /^gemini/.test(i) && !/embedding|image|tts|vision|aqa|live|native-audio/.test(i));
  return rank(provider, ids);
}

// Newest and most capable first: bigger version numbers first, full models before mini/flash-lite,
// dated snapshots and previews last.
function rank(provider, ids) {
  const version = id => {
    const m = id.match(/(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };
  const penalty = id => (/preview|exp|-\d{4}-\d{2}-\d{2}|\d{4}$/.test(id) ? 4 : 0) + (/(^|[-.])(nano|lite)\b/.test(id) ? 3 : 0) + (/(^|[-.])(mini|flash)\b/.test(id) ? 1 : 0) + (/latest|chat/.test(id) ? 2 : 0);
  if (provider === 'ollama') return ids;
  return ids.slice().sort((a, b) => (penalty(a) - penalty(b)) || (version(b) - version(a)) || a.localeCompare(b));
}

// Checks a key works. Resolves to {models} or rejects with a friendly message.
async function checkKey(provider, key) {
  try {
    const list = await models(provider, key);
    if (!list.length) throw new AIError(400, 'That key works, but it can’t use any chat models.');
    return { models: list };
  } catch (err) {
    if (err instanceof AIError && err.status === 400 && /chat models|OLLAMA_URL/.test(err.message)) throw new Error(err.message);
    if (err && err.status === 401) throw new Error(PROVIDERS[provider].name + ' didn’t accept that key. Check you copied all of it.');
    if (err && err.status === 403) throw new Error('That key isn’t allowed to list models. Check its permissions.');
    if (err instanceof AIError) throw new Error(PROVIDERS[provider].name + ' said: ' + err.message.slice(0, 200));
    if (err && err.constructor && /Authentication/.test(err.constructor.name)) throw new Error('Anthropic didn’t accept that key. Check you copied all of it.');
    throw new Error('Couldn’t reach ' + PROVIDERS[provider].name + ' to check the key. Try again in a moment.');
  }
}

// ---------------------------------------------------------------------------
// OpenAI-style chat, used for OpenAI, Gemini and Ollama
// ---------------------------------------------------------------------------
// Chats are saved in Claude's message format (so a chat can carry on if the family changes AI),
// and turned into OpenAI's format for each request.

function toOpenAI(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'user') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      for (const b of blocks.filter(x => x.type === 'tool_result')) {
        const content = typeof b.content === 'string' ? b.content : (b.content || []).map(c => c.text || '').join('\n');
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: content || '(empty)' });
      }
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      const calls = blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    }
  }
  return out;
}

const toolsFor = tools => tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

// One streamed request. Calls onText(delta) as text arrives. Resolves to a message in Claude's
// shape: {content: [blocks], stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'refusal', usage}.
async function chat(ready, { system, messages, tools, maxTokens, json, onText, signal }) {
  const body = {
    model: ready.model,
    messages: toOpenAI(system, messages),
    stream: true,
  };
  if (ready.provider === 'openai') {
    body.max_completion_tokens = maxTokens;
    body.stream_options = { include_usage: true };
  } else {
    body.max_tokens = maxTokens;
  }
  if (tools && tools.length) body.tools = toolsFor(tools);
  if (json && ready.provider !== 'gemini') body.response_format = { type: 'json_object' };
  const res = await request(ready.base, ready.key, '/chat/completions', { method: 'POST', body: JSON.stringify(body), signal });

  let text = '';
  const calls = [];   // by index: {id, name, args}
  let finish = null;
  const usage = { input_tokens: 0, output_tokens: 0 };
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let j;
      try { j = JSON.parse(data); } catch (e) { continue; }
      if (j.error) throw new AIError(500, j.error.message || 'stream error');
      if (j.usage) {
        usage.input_tokens = j.usage.prompt_tokens || usage.input_tokens;
        usage.output_tokens = j.usage.completion_tokens || usage.output_tokens;
      }
      const choice = j.choices && j.choices[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (d.content) {
        text += d.content;
        if (onText) onText(d.content);
      }
      for (const tc of d.tool_calls || []) {
        const i = tc.index === undefined ? calls.length : tc.index;
        const c = calls[i] = calls[i] || { id: '', name: '', args: '' };
        if (tc.id) c.id = tc.id;
        if (tc.function && tc.function.name) c.name += tc.function.name;
        if (tc.function && tc.function.arguments) c.args += tc.function.arguments;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  calls.filter(Boolean).forEach((c, n) => {
    let input = {};
    try { input = c.args ? JSON.parse(c.args) : {}; } catch (e) { input = { _unreadable: c.args.slice(0, 200) }; }
    // Claude needs tool ids made of letters, numbers, _ and -.
    const id = (c.id || 'call_' + Date.now().toString(36) + n).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    content.push({ type: 'tool_use', id, name: c.name, input });
  });
  const stop = finish === 'length' ? 'max_tokens' : finish === 'content_filter' ? 'refusal' : content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
  return { content, stop_reason: stop, usage };
}

// Most output tokens to ask for in one reply, by provider (a whole plan is about 30,000 tokens).
function maxOutput(provider) {
  return { openai: 64000, gemini: 60000, ollama: 32000 }[provider] || 32000;
}

module.exports = { PROVIDERS, DEFAULT_CLAUDE, familyKeys, familyChoice, setFamilyChoice, ownChoice, saveOwn, resolve, models, checkKey, chat, explain, maxOutput, AIError };
