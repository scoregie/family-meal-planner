// Checks the two helpers every part of the server shares (api/requests.js): reading the JSON a
// page sent, and sending a JSON reply.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { send, readBody } = require('../api/requests');

// A pretend request that delivers these pieces one after another, like a slow connection does.
function requestOf(pieces) {
  const req = new PassThrough();
  for (const piece of pieces) req.write(piece);
  req.end();
  return req;
}

test('a request with nothing in it reads as an empty object', async () => {
  assert.deepEqual(await readBody(requestOf([])), {});
});

test('a letter split across two pieces of a request still comes out right', async () => {
  const bytes = Buffer.from(JSON.stringify({ name: 'Zoé 민준', note: 'crème fraîche' }), 'utf8');
  // Cut in the middle of "é" (two bytes long), which used to turn it into two broken characters.
  const cut = bytes.indexOf(Buffer.from('é', 'utf8')) + 1;
  const body = await readBody(requestOf([bytes.subarray(0, cut), bytes.subarray(cut)]));
  assert.deepEqual(body, { name: 'Zoé 민준', note: 'crème fraîche' });
});

test('a request that is too big or is not JSON is refused', async () => {
  await assert.rejects(readBody(requestOf([Buffer.alloc(600, 'a')]), 500), /too big/);
  await assert.rejects(readBody(requestOf(['not json'])));
});

test('a reply is sent as JSON that browsers do not keep, with a cookie when one is given', () => {
  const sent = {};
  const res = { writeHead: (code, headers) => { sent.code = code; sent.headers = headers; }, end: text => { sent.text = text; } };
  send(res, 200, { ok: true });
  assert.equal(sent.code, 200);
  assert.equal(sent.headers['Content-Type'], 'application/json');
  assert.equal(sent.headers['Cache-Control'], 'no-store');
  assert.equal('Set-Cookie' in sent.headers, false);
  assert.equal(sent.text, '{"ok":true}');
  send(res, 401, { error: 'login needed' }, 'session=abc');
  assert.equal(sent.headers['Set-Cookie'], 'session=abc');
});
