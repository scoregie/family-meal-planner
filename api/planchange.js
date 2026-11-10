// Small, checked changes to plan.json, written as a list of steps. The Claude assistant suggests
// changes in this form, and an admin approves them before anything is saved.
//
// Each step names a place in the plan by its "path": the keys and list positions to follow from
// the top. ["weeks", 2, "meals", 0, "dinner"] is the dinner on the first day of the third week.
//
//   { "op": "set",    "path": [...], "value": ... }   put a value there (replacing what was there)
//   { "op": "insert", "path": [..., 3], "value": ... } add to a list at position 3 ("end" adds to the end)
//   { "op": "remove", "path": [...] }                 delete a key, or an item from a list
//
// The steps are tried on a copy of the plan, then the whole plan is checked, so a bad step changes nothing.

const MAX_STEPS = 60;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// True for a plain object like {a: 1} (not a list and not null).
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Follows a path to the object or list that holds the last key. Returns {parent, key} or {error}.
function locate(root, path) {
  if (!Array.isArray(path) || !path.length || path.length > 12) return { error: 'the path must be a list of 1 to 12 keys' };
  let here = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    if (BAD_KEYS.has(String(key))) return { error: 'that key is not allowed' };
    const next = Array.isArray(here) ? here[Number(key)] : isObj(here) ? here[key] : undefined;
    if (next === undefined || next === null || typeof next !== 'object') {
      return { error: 'nothing at ' + describePath(root, path.slice(0, i + 1)) };
    }
    here = next;
  }
  const key = path[path.length - 1];
  if (BAD_KEYS.has(String(key))) return { error: 'that key is not allowed' };
  return { parent: here, key };
}

// A readable name for a place in the plan: ["weeks", 2, "meals", 0, "dinner"] -> "Week 2 › Mon › dinner".
function describePath(plan, path) {
  const parts = [];
  let here = plan;
  for (const key of path) {
    const next = here && typeof here === 'object' ? here[key] : undefined;
    if (Array.isArray(here) && next && typeof next === 'object') {
      parts.push(next.name || next.day || next.title || ('#' + (Number(key) + 1)));
    } else if (Array.isArray(here)) {
      parts.push('#' + (key === 'end' ? 'end' : Number(key) + 1));
    } else if (key !== 'weeks' && key !== 'meals' && key !== 'recipes' && key !== 'days') {
      parts.push(String(key));
    }
    here = next;
  }
  return parts.join(' › ') || 'the plan';
}

// A short preview of a value for the summary: strings in quotes, objects by their name.
function preview(value) {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') return '“' + (value.length > 80 ? value.slice(0, 77) + '…' : value) + '”';
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && typeof value[1] === 'number') return '“' + value[0] + '” ($' + value[1].toFixed(2) + ')';
    return 'a list of ' + value.length;
  }
  if (isObj(value)) return value.name ? '“' + value.name + '”' : '{' + Object.keys(value).slice(0, 4).join(', ') + (Object.keys(value).length > 4 ? ', …' : '') + '}';
  return String(value);
}

// Tries the steps on a copy of `plan`. Returns {plan, summary: [lines]} or {error}.
// `check(plan)` is the server's plan check: it returns a problem as text, or nothing.
// `opts.maxValue` raises the size limit for one value; only whole-plan drafts the server wrote
// itself (plandraft.js) use it. Changes Claude suggests in a chat keep the normal limit.
function apply(plan, steps, check, opts) {
  const maxValue = (opts && opts.maxValue) || 50000;
  if (!Array.isArray(steps) || !steps.length) return { error: 'there are no changes' };
  if (steps.length > MAX_STEPS) return { error: 'too many changes at once (up to ' + MAX_STEPS + ')' };
  const copy = JSON.parse(JSON.stringify(plan));
  const summary = [];
  for (let n = 0; n < steps.length; n++) {
    const step = steps[n] || {};
    const where = 'Change ' + (n + 1) + ': ';
    const found = locate(copy, step.path);
    if (found.error) return { error: where + found.error };
    const { parent, key } = found;
    const place = describePath(copy, step.path);
    if (JSON.stringify(step.value === undefined ? null : step.value).length > maxValue) return { error: where + 'the value is too big' };

    if (step.op === 'set') {
      if (step.value === undefined) return { error: where + '"set" needs a value' };
      if (Array.isArray(parent)) {
        const i = Number(key);
        if (!Number.isInteger(i) || i < 0 || i >= parent.length) return { error: where + 'no item ' + key + ' in ' + place };
        summary.push(place + ': ' + preview(parent[i]) + ' → ' + preview(step.value));
        parent[i] = step.value;
      } else {
        summary.push(place + ': ' + preview(parent[key]) + ' → ' + preview(step.value));
        parent[key] = step.value;
      }
    } else if (step.op === 'insert') {
      if (!Array.isArray(parent)) return { error: where + '"insert" only works on a list' };
      if (step.value === undefined) return { error: where + '"insert" needs a value' };
      const i = key === 'end' || key === '-' ? parent.length : Number(key);
      if (!Number.isInteger(i) || i < 0 || i > parent.length) return { error: where + 'position ' + key + ' is outside the list' };
      parent.splice(i, 0, step.value);
      summary.push('Add to ' + describePath(copy, step.path.slice(0, -1)) + ': ' + preview(step.value));
    } else if (step.op === 'remove') {
      if (Array.isArray(parent)) {
        const i = Number(key);
        if (!Number.isInteger(i) || i < 0 || i >= parent.length) return { error: where + 'no item ' + key + ' in ' + place };
        summary.push('Remove from ' + describePath(copy, step.path.slice(0, -1)) + ': ' + preview(parent[i]));
        parent.splice(i, 1);
      } else {
        if (!(key in parent)) return { error: where + 'nothing at ' + place };
        summary.push('Remove ' + place + ' (' + preview(parent[key]) + ')');
        delete parent[key];
      }
    } else {
      return { error: where + 'op must be "set", "insert" or "remove"' };
    }
  }
  const problem = check ? check(copy) : null;
  if (problem) return { error: 'After these changes the plan would not be valid: ' + problem };
  return { plan: copy, summary };
}

// The size limit for one part of a whole-plan draft (a full plan is usually 100 to 200 KB).
const FULL_PLAN_MAX = 2000000;

module.exports = { apply, describePath, FULL_PLAN_MAX };
