// The two small jobs every part of the server shares: reading the JSON a page sent with its
// request, and sending a JSON reply. They live here once so each file doesn't keep its own copy.

// Sends a reply as JSON. `code` is the HTTP status (200 is fine, 400 a bad request and so on).
// `cookie` is optional: a login cookie for the browser to keep.
function send(res, code, obj, cookie) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  res.writeHead(code, headers);
  res.end(JSON.stringify(obj));
}

// Reads the JSON a page sent with its request and turns it into an object ({} if it sent
// nothing). Gives up, with an error, if it is bigger than `limit` bytes or isn't JSON.
// The pieces are joined before being read as text, so a letter like "é" or "민" that arrives
// split across two pieces still comes out right.
function readBody(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('too big'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

module.exports = { send, readBody };
