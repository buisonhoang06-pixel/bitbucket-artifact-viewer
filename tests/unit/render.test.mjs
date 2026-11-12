// The text formatters of render.js: JSON and JSON Lines.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatJson, formatJsonl, rewriteCss, srcsetCandidates } from '../../extension/lib/render.js';

describe('formatJson', () => {
  test('indents JSON by two spaces, and says null for text that is not JSON', () => {
    assert.equal(formatJson('{"a":1,"b":[true,null]}'), '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
    assert.equal(formatJson('[]'), '[]');
    assert.equal(formatJson('{"a":'), null);
    assert.equal(formatJson(''), null);
  });
});

describe('formatJsonl', () => {
  test('one record per line, under its own line number; blank lines left out; other lines kept as they are', () => {
    const text = '{"type":"start"}\n\n{"type":"tool","name":"Read"}\nnot json\r\n{"type":"end"}\n';
    assert.equal(formatJsonl(text), [
      '── line 1 ──', '{\n  "type": "start"\n}',
      '── line 3 ──', '{\n  "type": "tool",\n  "name": "Read"\n}',
      '── line 4 ──', 'not json',
      '── line 5 ──', '{\n  "type": "end"\n}',
    ].join('\n'));
  });
});

describe('formatJson keeps the file as written', () => {
  test('numbers as written, keys in their order, repeated keys too', () => {
    assert.equal(formatJson('{"id":12345678901234567890,"big":1e999,"x":1.50}'), '{\n  "id": 12345678901234567890,\n  "big": 1e999,\n  "x": 1.50\n}');
    assert.equal(formatJson('{"2":1,"1":2,"1":3}'), '{\n  "2": 1,\n  "1": 2,\n  "1": 3\n}');
    assert.equal(formatJson('{"s":"a\\"b,c:d{","e":{ },"f":[ ]}'), '{\n  "s": "a\\"b,c:d{",\n  "e": {},\n  "f": []\n}');
  });

  test('deep nesting is valid JSON, indented at most 32 levels; formatting stops past the limit', () => {
    const deep = `${'['.repeat(200000)}${']'.repeat(200000)}`;
    const formatted = formatJson(deep, 2 * 1024 * 1024);
    assert.ok(formatted.length > 2 * 1024 * 1024 && formatted.length < 2 * 1024 * 1024 + 100);
    assert.equal(Math.max(...formatted.split('\n').map((line) => line.length - line.trimStart().length)), 64);
    assert.ok(formatJsonl(`${'{"a":1}\n'.repeat(400000)}`, 1000).length < 1100);
  });
});

describe('srcsetCandidates', () => {
  test('a data: URL keeps its comma; a comma after a URL ends its candidate', () => {
    assert.deepEqual(srcsetCandidates('data:image/png;base64,AAAA 2x, b.png 1x'),
      [{ url: 'data:image/png;base64,AAAA', descriptors: '2x' }, { url: 'b.png', descriptors: '1x' }]);
    assert.deepEqual(srcsetCandidates('a.png, b.png 2x ,  c.png'),
      [{ url: 'a.png', descriptors: '' }, { url: 'b.png', descriptors: '2x' }, { url: 'c.png', descriptors: '' }]);
    // As the standard reads it, and Chrome with it: a comma inside a URL does not end it.
    assert.deepEqual(srcsetCandidates('a.png,b.png 2x'), [{ url: 'a.png,b.png', descriptors: '2x' }]);
    assert.deepEqual(srcsetCandidates(''), []);
  });
});

describe('rewriteCss', () => {
  const resolve = (address) => (address.startsWith('img/') ? `blob:${address}` : null);
  test('rewrites url() however it is quoted, and keeps what it cannot resolve', () => {
    const css = 'a{background:url(img/a.png)} b{background:url( "img/b.png" )} c{background:url(\'img/c.png\')} '
      + 'd{background:url(data:image/png;base64,AAAA)} e{background:url(https://hint.test/x.png)}';
    assert.equal(rewriteCss(css, { resolve, load: () => null }),
      'a{background:url("blob:img/a.png")} b{background:url("blob:img/b.png")} c{background:url("blob:img/c.png")} '
      + 'd{background:url(data:image/png;base64,AAAA)} e{background:url(https://hint.test/x.png)}');
  });

  test('inlines an @import it can load, inside @media when the import has one, and keeps the rest', () => {
    const load = (address) => (address === 'theme.css' ? 'h1{color:red}' : null);
    assert.equal(rewriteCss('@import "theme.css";\np{}', { resolve, load }), 'h1{color:red}\np{}');
    assert.equal(rewriteCss("@import url('theme.css') print;", { resolve, load }), '@media print {\nh1{color:red}\n}');
    assert.equal(rewriteCss('@import "https://hint.test/x.css";', { resolve, load }), '@import "https://hint.test/x.css";');
  });

  test('an empty url() stays as it is', () => {
    assert.equal(rewriteCss('a{background:url()} b{background:url(  )}', { resolve: () => 'blob:x', load: () => null }),
      'a{background:url()} b{background:url(  )}');
  });

  test('takes time in proportion to the stylesheet, however it is crafted', () => {
    const spaces = ' '.repeat(80000);
    for (const css of ['url( a'.repeat(40000), 'url('.repeat(60000), 'url("a'.repeat(40000), '@import "a"'.repeat(30000), '@import url(a'.repeat(20000),
      `url(${spaces}`, `@import url(${spaces}`, `url(${spaces}a${spaces}`]) {
      const start = performance.now();
      rewriteCss(css, { resolve: () => null, load: () => null });
      assert.ok(performance.now() - start < 500, `${css.slice(0, 10)}: ${Math.round(performance.now() - start)} ms`);
    }
  });
});
