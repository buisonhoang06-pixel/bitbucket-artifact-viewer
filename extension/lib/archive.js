// Unpacks a .tar.gz (or a plain .tar) in memory. Nothing is written to disk.
//
// Bitbucket Pipelines wraps every artifact in a .tar.gz. The tar flavour is not documented, so all three ways of
// storing a name longer than 100 characters are read: the ustar prefix field, pax extended headers and GNU long-name
// entries.

const BLOCK = 512;
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
// A pax header holds a few short records. A larger one is refused rather than read.
const PAX_MAX_BYTES = 1024 * 1024;
// Headers of every kind count (files, folders, links and the tar's own records). A few MB of compressed tar can
// otherwise hold a million empty entries, and the viewer would build a row for each.
export const MAX_ENTRIES = 50000;
// A real path is far shorter. A long-name entry is refused before its body is read, whatever its size.
export const MAX_NAME_BYTES = 4096;

export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

// Returns a Map from a normalized path to the file's bytes, for regular files only.
export async function openArchive(input, { maxBytes = DEFAULT_MAX_BYTES, maxEntries = MAX_ENTRIES } = {}) {
  const data = toBytes(input);
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    let bytes;
    try {
      bytes = await gunzip(data, maxBytes);
    } catch (error) {
      // Some writers leave bytes after the gzip stream, which stops decompression with what it has. That is harmless
      // when the tar inside already reached its end marker, so a complete tar is kept. Only that error qualifies: a
      // checksum or truncation error means the data itself is wrong.
      const files = error.trailingData && error.partial?.length ? readTar(error.partial, { requireEnd: true, maxEntries }) : null;
      if (files) return files;
      throw error;
    }
    return readTar(bytes, { maxEntries });
  }
  if (looksLikeTar(data)) {
    if (data.length > maxBytes) throw tooLarge(maxBytes);
    return readTar(data, { maxEntries });
  }
  throw new ArchiveError(describeUnknown(data));
}

export async function gunzip(data, maxBytes = DEFAULT_MAX_BYTES) {
  // The bytes go in as one chunk of a stream made here, not through a Blob, which would copy them into the browser's
  // blob storage (and to disk when that is full).
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    const failure = new ArchiveError(`The archive could not be decompressed: it is damaged or incomplete (${error.message}).`);
    failure.partial = concat(chunks, total);
    // Chrome says "Junk found after end of compressed data", Node "Trailing junk found after the end of the
    // compressed stream"; a checksum or truncation error says neither.
    failure.trailingData = /junk/i.test(String(error?.message ?? ''));
    throw failure;
  }
  return concat(chunks, total);
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// With requireEnd, returns null instead of the files when the data stops before the tar's end marker, or is damaged.
export function readTar(data, { requireEnd = false, maxEntries = MAX_ENTRIES } = {}) {
  // Even an empty tar is two zero blocks long, so anything shorter than one header is something else.
  if (data.length < BLOCK) {
    if (requireEnd) return null;
    throw new ArchiveError(data.length === 0 ? 'The archive is empty.' : 'The archive does not contain a tar file.');
  }
  try {
    const { files, ended } = walkTar(data, maxEntries);
    return requireEnd && !ended ? null : files;
  } catch (error) {
    if (requireEnd && error instanceof ArchiveError) return null;
    throw error;
  }
}

function walkTar(data, maxEntries) {
  const files = new Map();
  let pending = {};
  let offset = 0;
  let ended = false;
  let entries = 0;
  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) {
      ended = true;
      break;
    }
    entries += 1;
    if (entries > maxEntries) {
      throw new ArchiveError(`The archive has more than ${maxEntries.toLocaleString('en-US')} entries, so it was not opened.`);
    }
    if (!checksumMatches(header)) {
      throw new ArchiveError(offset === 0
        ? 'The archive does not contain a tar file.'
        : `The archive is damaged: bad header checksum at byte ${offset}.`);
    }
    const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
    const isMeta = type === 'x' || type === 'g' || type === 'L' || type === 'K';
    const size = isMeta ? readSize(header, offset) : (pending.size ?? readSize(header, offset));
    const start = offset + BLOCK;
    const end = start + size;
    if (end > data.length) {
      throw new ArchiveError(`The archive is truncated: the entry at byte ${offset} runs past its end.`);
    }
    const body = data.subarray(start, end);
    const headerAt = offset;
    offset = start + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x') {
      pending = { ...pending, ...parsePax(body, headerAt) };
      continue;
    }
    if (type === 'L') {
      if (size > MAX_NAME_BYTES) throw longName();
      pending = { ...pending, path: readString(body, 0, body.length) };
      continue;
    }
    if (type === 'g' || type === 'K') continue;

    const name = pending.path ?? headerName(header);
    pending = {};
    if (name.length > MAX_NAME_BYTES) throw longName();
    // '0' (or NUL) and '7' are regular files. Directories ('5'), links ('1', '2'), devices, FIFOs and GNU extras
    // are skipped.
    if ((type === '0' || type === '7') && !name.endsWith('/')) {
      const path = normalizeEntryPath(name);
      if (path) files.set(path, body);
    }
  }
  return { files, ended };
}

function longName() {
  return new ArchiveError(`The archive has an entry whose name is longer than ${MAX_NAME_BYTES.toLocaleString('en-US')} characters, so it was not opened.`);
}

// Drops "." segments, a leading "./" or "/", and repeated slashes. Returns null for a path with ".." or no segment.
export function normalizeEntryPath(name) {
  const parts = [];
  for (const part of name.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('openArchive expects bytes (Uint8Array or ArrayBuffer).');
}

function tooLarge(maxBytes) {
  return new ArchiveError(`The archive unpacks to more than ${formatBytes(maxBytes)}, so it was not opened.`);
}

function describeUnknown(data) {
  if (data.length === 0) return 'The file is empty.';
  if (data[0] === 0x50 && data[1] === 0x4b) return 'This is a zip file. The viewer opens .tar.gz artifacts only.';
  const start = new TextDecoder().decode(data.subarray(0, 64)).trimStart();
  if (start.startsWith('<')) {
    return 'This is a web page, not an archive. Bitbucket may have answered with its sign-in page.';
  }
  if (start.startsWith('{') || start.startsWith('[')) return 'This is JSON, not an archive.';
  return 'This is not a .tar.gz file.';
}

function looksLikeTar(data) {
  return data.length >= BLOCK && checksumMatches(data.subarray(0, BLOCK));
}

function isZeroBlock(block) {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

// The checksum is the sum of the header bytes with its own field counted as spaces. Old writers used signed bytes,
// so either sum is accepted.
function checksumMatches(header) {
  const stored = parseOctal(header.subarray(148, 156));
  if (stored === null) return false;
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = i >= 148 && i < 156 ? 0x20 : header[i];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return stored === unsigned || stored === signed;
}

function parseOctal(field) {
  const text = ascii(field).replace(/\0.*$/s, '').trim();
  if (!/^[0-7]+$/.test(text)) return null;
  return parseInt(text, 8);
}

// Octal digits, or base-256 when the high bit of the first byte is set (GNU and star use it for large sizes).
function readSize(header, offset) {
  const field = header.subarray(124, 136);
  if (field[0] & 0x80) {
    let value = field[0] & 0x7f;
    for (let i = 1; i < field.length; i += 1) value = value * 256 + field[i];
    if (!Number.isSafeInteger(value)) throw new ArchiveError(`The archive has an entry too large to open at byte ${offset}.`);
    return value;
  }
  const text = ascii(field).replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError(`The archive is damaged: bad size field at byte ${offset}.`);
  return parseInt(text, 8);
}

// A POSIX ustar header ("ustar\0") may split a long name into prefix and name. Old GNU headers ("ustar  \0") use
// that area for other fields, so its prefix is ignored.
function headerName(header) {
  const name = readString(header, 0, 100);
  const posix = ascii(header.subarray(257, 263)) === 'ustar\0';
  if (posix) {
    const prefix = readString(header, 345, 155);
    if (prefix) return `${prefix}/${name}`;
  }
  return name;
}

// Records are "<length> <key>=<value>\n", where length counts the whole record in bytes. The length is read from at
// most 20 digits and must cover more than its own digits and space, so every record moves past what was scanned and
// the walk stays linear, whatever the input.
function parsePax(body, offset) {
  if (body.length > PAX_MAX_BYTES) {
    throw new ArchiveError(`The archive is damaged: an extended header of ${formatBytes(body.length)} at byte ${offset}.`);
  }
  const result = {};
  let at = 0;
  while (at < body.length) {
    let space = at;
    while (space < body.length && space - at < 20 && body[space] >= 0x30 && body[space] <= 0x39) space += 1;
    if (space === at || space >= body.length || body[space] !== 0x20) break;
    const length = Number(ascii(body.subarray(at, space)));
    if (length <= space - at + 1 || at + length > body.length || body[at + length - 1] !== 0x0a) break;
    const record = new TextDecoder().decode(body.subarray(space + 1, at + length - 1));
    const equals = record.indexOf('=');
    if (equals > 0) {
      const key = record.slice(0, equals);
      const value = record.slice(equals + 1);
      if (key === 'path') result.path = value;
      if (key === 'size') {
        const size = Number(value);
        if (Number.isSafeInteger(size) && size >= 0) result.size = size;
      }
    }
    at += length;
  }
  return result;
}

function readString(bytes, start, length) {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

function ascii(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return text;
}
