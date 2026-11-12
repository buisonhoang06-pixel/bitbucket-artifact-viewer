// fileKind: how each file of an artifact is shown, decided from its content where that matters.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { IMAGE_MAX_BYTES, fileKind, looksLikeText } from '../../extension/lib/kinds.js';

const bytes = (...parts) => {
  const chunks = parts.map((part) => (typeof part === 'string' ? new TextEncoder().encode(part) : Uint8Array.from(part)));
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};
const kind = (path, ...parts) => fileKind(path, bytes(...parts));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];

describe('images', () => {
  test('by their magic bytes, whatever the name; the type comes from the bytes', () => {
    assert.deepEqual(kind('shot.png', PNG), { kind: 'image', type: 'image/png' });
    assert.deepEqual(kind('shot.bin', PNG), { kind: 'image', type: 'image/png' });
    assert.deepEqual(kind('photo.png', [0xff, 0xd8, 0xff, 0xe0, 0, 0x10]), { kind: 'image', type: 'image/jpeg' });
    assert.deepEqual(kind('a.gif', 'GIF89a', [1, 0, 1, 0]), { kind: 'image', type: 'image/gif' });
    assert.deepEqual(kind('a.gif', 'GIF87a', [1, 0, 1, 0]), { kind: 'image', type: 'image/gif' });
    assert.deepEqual(kind('a.webp', 'RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '), { kind: 'image', type: 'image/webp' });
    assert.deepEqual(kind('a.avif', [0, 0, 0, 0x1c], 'ftypavif', [0, 0, 0, 0]), { kind: 'image', type: 'image/avif' });
  });

  test('BMP and ICO only under their own extension, so text that starts with "BM" stays text', () => {
    assert.deepEqual(kind('a.bmp', 'BM', [0x36, 0, 0, 0, 0, 0]), { kind: 'image', type: 'image/bmp' });
    assert.deepEqual(kind('a.ico', [0, 0, 1, 0, 1, 0]), { kind: 'image', type: 'image/x-icon' });
    assert.equal(kind('notes.txt', 'BMW and Audi').kind, 'text');
    assert.equal(kind('data.dat', 'BM is not a bitmap here').kind, 'text');
  });

  test('SVG by its extension and an <svg> element, shown as an image', () => {
    assert.deepEqual(kind('logo.svg', '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script></svg>'),
      { kind: 'image', type: 'image/svg+xml' });
    assert.equal(kind('logo.svg', 'not an svg at all').kind, 'text');
  });

  test('an image larger than the limit is offered as a download', () => {
    const big = new Uint8Array(IMAGE_MAX_BYTES + 1);
    big.set(PNG);
    assert.equal(fileKind('huge.png', big).kind, 'binary');
  });
});

describe('video and PDF', () => {
  test('video only as webm or mp4, with the matching signature', () => {
    assert.deepEqual(kind('run.webm', [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42]), { kind: 'video', type: 'video/webm' });
    assert.deepEqual(kind('run.mp4', [0, 0, 0, 0x20], 'ftypisom', [0, 0, 2, 0]), { kind: 'video', type: 'video/mp4' });
    assert.deepEqual(kind('run.m4v', [0, 0, 0, 0x20], 'ftypM4V ', [0, 0, 2, 0]), { kind: 'video', type: 'video/mp4' });
    assert.equal(kind('run.mkv', [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0, 0]).kind, 'binary');
    assert.equal(kind('run.mp4', 'not a video').kind, 'text');
  });

  test('a PDF by its header; a file named .pdf that holds HTML is not one', () => {
    assert.deepEqual(kind('report.pdf', '%PDF-1.4\n%âãÏÓ\n', [0, 1, 2]), { kind: 'pdf', type: 'application/pdf' });
    assert.deepEqual(kind('report.pdf', '\n\n%PDF-1.7\n'), { kind: 'pdf', type: 'application/pdf' });
    assert.equal(kind('report.pdf', '<!doctype html><script>alert(1)</script>').kind, 'text');
    assert.equal(kind('notes.txt', '%PDF-1.4 in a text file').kind, 'text');
  });
});

describe('JUnit XML', () => {
  test('by its root element, after a declaration, a byte order mark, comments or processing instructions', () => {
    assert.equal(kind('results.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="x">').kind, 'junit');
    assert.equal(kind('results.xml', '\uFEFF<testsuite name="unit" tests="1">').kind, 'junit');
    assert.equal(kind('results.xml', '<?xml version="1.0"?>\n<!-- generated -->\n<?xml-stylesheet href="a"?>\n<testsuite/>').kind, 'junit');
  });

  test('XML with a DOCTYPE, which can declare entities, or another root, is text', () => {
    assert.equal(kind('results.xml', '<?xml version="1.0"?>\n<!DOCTYPE t [<!ENTITY a "aaaa">]>\n<testsuite>&a;</testsuite>').kind, 'text');
    assert.equal(kind('pom.xml', '<?xml version="1.0"?>\n<project><testsuite/></project>').kind, 'text');
  });

  test('a comment or an instruction ends at its first close, so none can reach over a DOCTYPE', () => {
    assert.equal(kind('a.xml', '<!--a--><!DOCTYPE testsuite [<!ENTITY x "y">]><!--b--><testsuite/>').kind, 'text');
    assert.equal(kind('a.xml', '<?a?><!DOCTYPE testsuite [<!ENTITY x "y">]><?b?><testsuite/>').kind, 'text');
    assert.equal(kind('a.xml', '<!-- <!DOCTYPE x> is only text here --><testsuite/>').kind, 'junit');
  });

  // 28 comments took about 2 s with the pattern before the fix, which doubled with each comment; this one takes
  // none. More would make a regression hang instead of fail.
  test('the prolog check takes time in proportion to it, however many comments it has', () => {
    for (const prolog of ['<!--a-->'.repeat(28), '<?a?>'.repeat(28), `<!--${'-'.repeat(60000)}`, '<?'.repeat(30000)]) {
      const start = performance.now();
      assert.equal(kind('a.xml', `${prolog}<x>`).kind, 'text');
      assert.ok(performance.now() - start < 500, `${prolog.slice(0, 8)}: ${Math.round(performance.now() - start)} ms`);
    }
    assert.equal(kind('a.xml', `${'<!--a-->'.repeat(40)}<testsuite/>`).kind, 'junit');
  });
});

describe('text, JSON and Markdown', () => {
  test('JSON, JSONL and Markdown by their extensions', () => {
    assert.equal(kind('a.json', '{"a":1}').kind, 'json');
    assert.equal(kind('stream.jsonl', '{"a":1}\n{"b":2}\n').kind, 'jsonl');
    assert.equal(kind('events.ndjson', '{}').kind, 'jsonl');
    assert.equal(kind('final.md', '# Title').kind, 'markdown');
    assert.equal(kind('README.markdown', '# Title').kind, 'markdown');
    assert.equal(kind('page.HTML', 'x').kind, 'html');
  });

  test('any file that is UTF-8 without NUL is text, whatever its extension', () => {
    for (const path of ['diff.patch', 'changes.diff', 'tool.py', 'run.sh', 'Makefile', 'stderr', 'config.toml']) {
      assert.deepEqual(kind(path, 'some text\nwith lines\n'), { kind: 'text', type: 'text/plain' }, path);
    }
    assert.equal(kind('greeting.txt', '\uFEFFxin chào, thế giới').kind, 'text');
    assert.equal(kind('empty.bin').kind, 'text');
  });

  test('a NUL byte or bytes that are not UTF-8 make a file binary, unless its extension says text', () => {
    assert.equal(kind('blob.bin', 'abc', [0], 'def').kind, 'binary');
    assert.equal(kind('latin1.dat', [0x63, 0x61, 0x66, 0xe9]).kind, 'binary');
    assert.equal(kind('old.txt', [0x63, 0x61, 0x66, 0xe9]).kind, 'text');
  });

  test('a character cut at the end of the 64 KB sample does not make the file binary', () => {
    const long = bytes('a'.repeat(64 * 1024 - 1), 'é and more');
    assert.equal(long[64 * 1024 - 1], 0xc3, 'the sample ends inside the character');
    assert.equal(looksLikeText(long), true);
    assert.equal(fileKind('long.data', long).kind, 'text');
  });
});
