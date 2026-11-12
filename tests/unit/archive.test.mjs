import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { ArchiveError, formatBytes, normalizeEntryPath, openArchive } from '../../extension/lib/archive.js';
import { cleanup, craftedTar, makeTree, tarWithGnuTar, tarWithPython } from '../helpers/archives.mjs';

after(cleanup);

const LONG_115 = 'projects/web/mesh/evals/results/2026-11-11T06-20-30-787+0700/transcripts/handles-declined-card-on-checkout-run1.txt';
const LONG_211 = `${'level-one-folder/'.repeat(12)}end.txt`;
const LONG_COMPONENT = `deep/${'x'.repeat(120)}.txt`;

const COMMON = {
  [LONG_115]: 'transcript of run 1\n',
  [LONG_211]: 'deep file\n',
  'reports/2026-11-11T06-20-30-787+0700/summary.html': '<h1>Summary</h1>',
  'notes/tiếng-việt.txt': 'xin chào\n',
  'empty.txt': '',
  'block-512.bin': new Uint8Array(512).fill(7),
  'block-513.bin': new Uint8Array(513).fill(9),
};

function text(bytes) {
  return new TextDecoder().decode(bytes);
}

function assertSameFiles(actual, expected) {
  assert.deepEqual([...actual.keys()].sort(), Object.keys(expected).sort());
  for (const [path, content] of Object.entries(expected)) {
    const want = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    assert.deepEqual(new Uint8Array(actual.get(path)), want, path);
  }
}

describe('openArchive reads what real tools write', () => {
  test('a long transcript path is 115 characters', () => {
    assert.equal(LONG_115.length, 115);
    assert.ok(LONG_211.length > 200);
  });

  for (const format of ['gnu', 'pax']) {
    test(`GNU tar --format=${format}, gzip, entries stored with "./"`, async () => {
      const files = { ...COMMON, [LONG_COMPONENT]: 'long component\n' };
      const archive = tarWithGnuTar(makeTree(files), { format });
      assertSameFiles(await openArchive(archive), files);
    });
  }

  test('GNU tar --format=ustar splits long paths into prefix and name', async () => {
    const archive = tarWithGnuTar(makeTree(COMMON), { format: 'ustar', entries: Object.keys(COMMON) });
    assertSameFiles(await openArchive(archive), COMMON);
  });

  test("Python's tarfile (pax, its default)", async () => {
    const files = { ...COMMON, [LONG_COMPONENT]: 'long component\n' };
    assertSameFiles(await openArchive(tarWithPython(makeTree(files))), files);
  });

  test('an uncompressed tar opens too', async () => {
    const archive = tarWithGnuTar(makeTree(COMMON), { gzip: false });
    assertSameFiles(await openArchive(archive), COMMON);
  });

  test('an ArrayBuffer is accepted', async () => {
    const archive = tarWithGnuTar(makeTree({ 'a.txt': 'a' }));
    const files = await openArchive(archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength));
    assert.equal(text(files.get('a.txt')), 'a');
  });

  test('directories and symlinks are not listed as files', async () => {
    const root = makeTree({ 'logs/run1.txt': 'run 1' }, { 'logs/latest': 'run1.txt' });
    const files = await openArchive(tarWithGnuTar(root));
    assert.deepEqual([...files.keys()], ['logs/run1.txt']);
  });
});

describe('openArchive normalizes and filters entry names', () => {
  test('".." entries are skipped; "/", "./" and "." segments are dropped; later duplicates win', async () => {
    const archive = craftedTar([
      { name: '../evil.txt', data: 'evil' },
      { name: 'dir/../../up.txt', data: 'up' },
      { name: '/abs/path.txt', data: 'abs' },
      { name: './dot/./file.txt', data: 'dot' },
      { name: 'folder', type: 'dir' },
      { name: 'link', type: 'symlink', target: 'same.txt' },
      { name: 'same.txt', data: 'one' },
      { name: 'same.txt', data: 'two' },
    ]);
    const files = await openArchive(archive);
    assert.deepEqual([...files.keys()].sort(), ['abs/path.txt', 'dot/file.txt', 'same.txt']);
    assert.equal(text(files.get('same.txt')), 'two');
  });

  test('normalizeEntryPath', () => {
    assert.equal(normalizeEntryPath('./a//b/./c.txt'), 'a/b/c.txt');
    assert.equal(normalizeEntryPath('/a.txt'), 'a.txt');
    assert.equal(normalizeEntryPath('a/../b.txt'), null);
    assert.equal(normalizeEntryPath('./'), null);
  });
});

// A hand-written tar for the branches that common tools rarely produce.
function header({ name = '', size = 0, type = '0', magic = 'ustar\u000000', prefix = '', sizeField = null, linkname = '' }) {
  const block = new Uint8Array(512);
  const put = (offset, value, length) => {
    const bytes = new TextEncoder().encode(value);
    block.set(bytes.subarray(0, length), offset);
  };
  put(0, name, 100);
  put(100, '0000644\0', 8);
  put(108, '0000000\0', 8);
  put(116, '0000000\0', 8);
  if (sizeField) block.set(sizeField, 124);
  else put(124, `${size.toString(8).padStart(11, '0')}\0`, 12);
  put(136, '00000000000\0', 12);
  block[156] = type === '\0' ? 0 : type.charCodeAt(0);
  put(157, linkname, 100);
  put(257, magic, 8);
  put(345, prefix, 155);
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, `${sum.toString(8).padStart(6, '0')}\0 `, 8);
  return block;
}

function entry(options, data = '') {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  padded.set(bytes);
  return [header({ size: bytes.length, ...options }), padded];
}

function paxRecords(records) {
  let body = '';
  for (const [key, value] of Object.entries(records)) {
    const tail = ` ${key}=${value}\n`;
    let length = tail.length + 1;
    while (`${length}${tail}`.length !== length) length += 1;
    body += `${length}${tail}`;
  }
  return body;
}

function tar(...parts) {
  const blocks = [...parts.flat(), new Uint8Array(1024)];
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

describe('readTar branches', () => {
  test('a pax header sets the path and size of the next entry', async () => {
    const longName = `pax/${'p'.repeat(150)}.txt`;
    const data = tar(
      entry({ name: 'PaxHeader', type: 'x' }, paxRecords({ path: longName, size: '5' })),
      [header({ name: 'short-name', size: 0 }), (() => { const block = new Uint8Array(512); block.set(new TextEncoder().encode('hello')); return block; })()],
    );
    const files = await openArchive(gzipSync(data));
    assert.deepEqual([...files.keys()], [longName]);
    assert.equal(text(files.get(longName)), 'hello');
  });

  test('a base-256 size field is read', async () => {
    const sizeField = new Uint8Array(12);
    sizeField[0] = 0x80;
    sizeField[11] = 5;
    const data = tar([header({ name: 'big.txt', sizeField }), (() => { const block = new Uint8Array(512); block.set(new TextEncoder().encode('world')); return block; })()]);
    assert.equal(text((await openArchive(data)).get('big.txt')), 'world');
  });

  test('global pax headers and GNU long-link entries are ignored; types 7 and NUL are files', async () => {
    const data = tar(
      entry({ name: 'GlobalHead', type: 'g' }, paxRecords({ comment: 'ignored' })),
      entry({ name: '././@LongLink', type: 'K' }, 'some/long/link/target\0'),
      entry({ name: 'contiguous.txt', type: '7' }, 'seven'),
      entry({ name: 'old-style.txt', type: '\0' }, 'nul'),
      entry({ name: 'old-dir/', type: '0' }, ''),
    );
    const files = await openArchive(data);
    assert.deepEqual([...files.keys()].sort(), ['contiguous.txt', 'old-style.txt']);
  });

  test('a POSIX header joins prefix and name; an old GNU header ignores the prefix area', async () => {
    const data = tar(
      entry({ name: 'c.txt', prefix: 'a/b' }, 'posix'),
      entry({ name: 'd.txt', prefix: 'junk', magic: 'ustar  \0' }, 'gnu'),
    );
    const files = await openArchive(data);
    assert.equal(text(files.get('a/b/c.txt')), 'posix');
    assert.equal(text(files.get('d.txt')), 'gnu');
  });
});

describe('hostile and unusual input stays fast and readable', () => {
  test('a pax length with thousands of leading zeros is read in linear time', async () => {
    const body = `${'0'.repeat(80000)}03 a`;
    const data = tar(entry({ name: 'PaxHeader', type: 'x' }, body), entry({ name: 'after.txt' }, 'after'));
    const started = performance.now();
    const files = await openArchive(gzipSync(data));
    assert.ok(performance.now() - started < 500, 'well under a second');
    assert.equal(text(files.get('after.txt')), 'after');
  });

  test('a pax header larger than 1 MiB is refused', async () => {
    const data = tar(entry({ name: 'PaxHeader', type: 'x' }, 'x'.repeat(1024 * 1024 + 1)), entry({ name: 'a.txt' }, 'a'));
    await assert.rejects(openArchive(gzipSync(data)), /extended header of 1\.00 MB/);
  });

  test('bytes after a complete gzip stream are ignored when the tar inside is complete', async () => {
    const gz = tarWithGnuTar(makeTree({ 'a.txt': 'a', 'b/c.txt': 'c' }));
    for (const tail of [new Uint8Array(512), new TextEncoder().encode('trailing garbage')]) {
      const files = await openArchive(new Uint8Array([...gz, ...tail]));
      assert.deepEqual([...files.keys()].sort(), ['./a.txt', './b/c.txt'].map((path) => path.slice(2)).sort());
    }
  });

  test('a wrong gzip checksum is reported, even when the tar inside came out complete', async () => {
    for (let i = 0; i < 40; i += 1) {
      const gz = tarWithGnuTar(makeTree({ [`file-${i}.txt`]: 'z'.repeat(1000 + i * 977) }));
      const damaged = new Uint8Array(gz);
      damaged[damaged.length - 6] ^= 0xff;
      await assert.rejects(openArchive(damaged), /could not be decompressed/, `archive ${i}`);
    }
  });

  test('a tar split across two gzip members is still reported as damaged', async () => {
    const raw = craftedTar([{ name: 'big.txt', data: 'y'.repeat(20000) }], { gzip: false });
    const half = Math.floor(raw.length / 2);
    const twoMembers = new Uint8Array([...gzipSync(raw.subarray(0, half)), ...gzipSync(raw.subarray(half))]);
    await assert.rejects(openArchive(twoMembers), /could not be decompressed/);
  });
});

describe('limits that a small crafted archive cannot get past', () => {
  test('more entries than the limit are refused', async () => {
    const bytes = craftedTar(['a', 'b', 'c', 'd'].map((name) => ({ name: `${name}.txt`, data: name })));
    await assert.rejects(openArchive(bytes, { maxEntries: 3 }), /more than 3 entries/);
    assert.equal((await openArchive(bytes, { maxEntries: 4 })).size, 4);
  });

  test('a name longer than 4,096 characters is refused before it is read; a long real path still opens', async () => {
    const tooLong = `${'d/'.repeat(2100)}f.txt`;
    await assert.rejects(openArchive(craftedTar([{ name: tooLong, data: 'x' }])), /longer than 4,096 characters/);
    const longButFine = `${'d/'.repeat(1900)}f.txt`;
    assert.ok((await openArchive(craftedTar([{ name: longButFine, data: 'x' }]))).has(longButFine));
  });
});

describe('openArchive explains what is wrong', () => {
  const twoFiles = () => craftedTar([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'world' }], { gzip: false });

  test('a damaged header after the first one', async () => {
    const data = twoFiles();
    data[1024 + 5] ^= 0xff;
    await assert.rejects(openArchive(gzipSync(data)), { name: 'ArchiveError', message: /bad header checksum at byte 1024/ });
  });

  test('an entry that runs past the end', async () => {
    const data = craftedTar([{ name: 'big.txt', data: 'x'.repeat(5000) }], { gzip: false });
    await assert.rejects(openArchive(gzipSync(data.subarray(0, 1512))), /truncated/);
  });

  test('a gzip stream cut in half', async () => {
    const gz = tarWithGnuTar(makeTree({ 'a.txt': 'a'.repeat(100000) }));
    await assert.rejects(openArchive(gz.subarray(0, Math.floor(gz.length / 2))), /could not be decompressed/);
  });

  test('gzip around something that is not a tar, short or long, or around nothing', async () => {
    await assert.rejects(openArchive(gzipSync(Buffer.from('just text'))), /does not contain a tar file/);
    await assert.rejects(openArchive(gzipSync(Buffer.from('not a tar header '.repeat(100)))), /does not contain a tar file/);
    await assert.rejects(openArchive(gzipSync(Buffer.alloc(0))), /archive is empty/);
  });

  test('a tar with no entries opens as an empty archive', async () => {
    assert.equal((await openArchive(gzipSync(new Uint8Array(1024)))).size, 0);
  });

  test('a zip, a web page, JSON, random bytes and an empty file', async () => {
    await assert.rejects(openArchive(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0])), /zip file/);
    await assert.rejects(openArchive(new TextEncoder().encode('\n  <!DOCTYPE html><title>Log in</title>')), /sign-in page/);
    await assert.rejects(openArchive(new TextEncoder().encode('{"error": "nope"}')), /JSON/);
    await assert.rejects(openArchive(new Uint8Array(2048).map((_, i) => (i * 37 + 11) % 251)), /not a \.tar\.gz/);
    await assert.rejects(openArchive(new Uint8Array(0)), /empty/);
  });

  test('the size cap stops a large archive, compressed or not', async () => {
    const root = makeTree({ 'big.bin': new Uint8Array(200000) });
    await assert.rejects(openArchive(tarWithGnuTar(root), { maxBytes: 50000 }), (error) => {
      assert.ok(error instanceof ArchiveError);
      assert.match(error.message, /more than 48\.8 KB/);
      return true;
    });
    await assert.rejects(openArchive(tarWithGnuTar(root, { gzip: false }), { maxBytes: 50000 }), /more than/);
  });

  test('formatBytes', () => {
    assert.equal(formatBytes(900), '900 B');
    assert.equal(formatBytes(9790), '9.56 KB');
    assert.equal(formatBytes(512 * 1024 * 1024), '512.0 MB');
  });
});
