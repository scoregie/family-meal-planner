// Reads files out of a .zip without unpacking it to disk. No npm packages: Node's zlib does the
// decompressing. Used to import Lose It and Apple Health exports from the uploads folder.
//
// Uploaded zips are treated as untrusted: nothing is written to disk, only files we ask for by name
// are read, and every read has a size limit, so a "zip bomb" can't fill the memory.
//
// A zip file ends with a "central directory": a list of every file inside, with where it starts.
// We read that list first, then jump straight to the file we want.
const fs = require('fs');
const zlib = require('zlib');

// Lists the files in a zip: [{name, method, compressedSize, size, offset}].
function list(zipPath) {
  const fd = fs.openSync(zipPath, 'r');
  try {
    const fileSize = fs.fstatSync(fd).size;
    // The "end of central directory" record is in the last 64 KB (it can be followed by a comment).
    const tailSize = Math.min(fileSize, 65557);
    const tail = Buffer.alloc(tailSize);
    fs.readSync(fd, tail, 0, tailSize, fileSize - tailSize);
    let end = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('not a zip file');
    const count = tail.readUInt16LE(end + 10);
    const dirSize = tail.readUInt32LE(end + 12);
    const dirOffset = tail.readUInt32LE(end + 16);
    if (dirOffset === 0xffffffff || count === 0xffff) throw new Error('this zip is too large to read (zip64)');

    const dir = Buffer.alloc(dirSize);
    fs.readSync(fd, dir, 0, dirSize, dirOffset);
    const entries = [];
    let at = 0;
    for (let n = 0; n < count && at + 46 <= dir.length; n++) {
      if (dir.readUInt32LE(at) !== 0x02014b50) break;
      const nameLength = dir.readUInt16LE(at + 28);
      const extraLength = dir.readUInt16LE(at + 30);
      const commentLength = dir.readUInt16LE(at + 32);
      entries.push({
        name: dir.toString('utf8', at + 46, at + 46 + nameLength),
        method: dir.readUInt16LE(at + 10),          // 0 = stored, 8 = deflated
        compressedSize: dir.readUInt32LE(at + 20),
        size: dir.readUInt32LE(at + 24),
        offset: dir.readUInt32LE(at + 42),           // where its "local header" starts
      });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}

// A readable stream of one file's contents, decompressed. Stops with an error after `maxBytes`.
function stream(zipPath, entry, maxBytes) {
  // The local header repeats the name and has its own "extra" field, so read its length first.
  const fd = fs.openSync(zipPath, 'r');
  const header = Buffer.alloc(30);
  fs.readSync(fd, header, 0, 30, entry.offset);
  fs.closeSync(fd);
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('damaged zip file');
  const dataStart = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  const raw = fs.createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });

  let out;
  if (entry.method === 0) out = raw;
  else if (entry.method === 8) out = raw.pipe(zlib.createInflateRaw());
  else throw new Error('unsupported zip compression in ' + entry.name);

  let total = 0;
  out.on('data', chunk => {
    total += chunk.length;
    if (total > maxBytes) out.destroy(new Error(entry.name + ' is larger than expected'));
  });
  return out;
}

// Reads a whole (small) file from a zip as text.
function readText(zipPath, entry, maxBytes = 50e6) {
  return new Promise((resolve, reject) => {
    const parts = [];
    const s = stream(zipPath, entry, maxBytes);
    s.on('data', chunk => parts.push(chunk));
    s.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    s.on('error', reject);
  });
}

// Calls onLine(line) for each line of a (possibly huge) file in a zip, without loading it all.
function eachLine(zipPath, entry, onLine, maxBytes = 4e9) {
  return new Promise((resolve, reject) => {
    let rest = '';
    const s = stream(zipPath, entry, maxBytes);
    s.setEncoding('utf8');
    s.on('data', chunk => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const line of lines) onLine(line);
    });
    s.on('end', () => {
      if (rest) onLine(rest);
      resolve();
    });
    s.on('error', reject);
  });
}

module.exports = { list, readText, eachLine };
