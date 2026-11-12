// markdownToHtml: the subset reports use, escape-first, so a Markdown file's own HTML never becomes markup.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { markdownToHtml } from '../../extension/lib/markdown.js';

const md = (text) => markdownToHtml(text);

describe('blocks', () => {
  test('headings, with ids for anchors; paragraphs; line breaks; rules', () => {
    assert.equal(md('# Benchmark results\n\nSecond line'), '<h1 id="benchmark-results">Benchmark results</h1>\n<p>Second line</p>');
    assert.equal(md('## Runs ##'), '<h2 id="runs">Runs</h2>');
    assert.equal(md('# Same\n# Same'), '<h1 id="same">Same</h1>\n<h1 id="same-1">Same</h1>');
    assert.equal(md('one  \ntwo\nthree'), '<p>one<br>two\nthree</p>');
    assert.equal(md('a\n\n---\n\nb'), '<p>a</p>\n<hr>\n<p>b</p>');
  });

  test('fenced code keeps its text, escaped, with its language; indented code too', () => {
    assert.equal(md('```js\nconst a = "<b>";\n```'), '<pre><code class="language-js">const a = &quot;&lt;b&gt;&quot;;</code></pre>');
    assert.equal(md('~~~\n# not a heading\n~~~'), '<pre><code># not a heading</code></pre>');
    assert.equal(md('    indented <code>\n    more'), '<pre><code>indented &lt;code&gt;\nmore</code></pre>');
  });

  test('lists: ordered and unordered, nested by indentation, starting where they start', () => {
    assert.equal(md('- one\n- two\n  - two a\n- three'), '<ul><li>one</li><li>two\n<ul><li>two a</li></ul></li><li>three</li></ul>');
    assert.equal(md('3. third\n4. fourth'), '<ol start="3"><li>third</li><li>fourth</li></ol>');
    assert.equal(md('- [ ] to do\n- [x] done'), '<ul><li>[ ] to do</li><li>[x] done</li></ul>');
  });

  test('block quotes hold blocks', () => {
    assert.equal(md('> quoted\n> # heading'), '<blockquote><p>quoted</p>\n<h1 id="heading">heading</h1></blockquote>');
  });

  test("GFM tables, with their alignment: the benchmark's own layout", () => {
    assert.equal(md('| case | score |\n|---|---:|\n| case-a | 0.8 |\n| case-b | 1.0 |'),
      '<table><thead><tr><th>case</th><th style="text-align:right">score</th></tr></thead>'
      + '<tbody><tr><td>case-a</td><td style="text-align:right">0.8</td></tr><tr><td>case-b</td><td style="text-align:right">1.0</td></tr></tbody></table>');
    assert.equal(md('a | b\n:-: | :--\nx | `y|z`'),
      '<table><thead><tr><th style="text-align:center">a</th><th style="text-align:left">b</th></tr></thead>'
      + '<tbody><tr><td style="text-align:center">x</td><td style="text-align:left">`y</td></tr></tbody></table>');
  });
});

describe('inline', () => {
  test('emphasis, strong, strikethrough and code spans, with code left alone', () => {
    assert.equal(md('*em* **strong** __also__ _em_ ~~gone~~ `a*b*c`'),
      '<p><em>em</em> <strong>strong</strong> <strong>also</strong> <em>em</em> <del>gone</del> <code>a*b*c</code></p>');
    assert.equal(md('snake_case_name stays'), '<p>snake_case_name stays</p>');
    assert.equal(md('\\*not em\\*'), '<p>*not em*</p>');
  });

  test('links and images, inline, by reference and as autolinks', () => {
    assert.equal(md('[run](runs/run-1.md "the run") ![shot](img/a.png)'),
      '<p><a href="runs/run-1.md" title="the run">run</a> <img src="img/a.png" alt="shot"></p>');
    assert.equal(md('See [the docs][docs].\n\n[docs]: https://example.com/docs'), '<p>See <a href="https://example.com/docs">the docs</a>.</p>');
    assert.equal(md('<https://example.com/a?b=1&c=2>'), '<p><a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a></p>');
    assert.equal(md('[top](#benchmark-results)'), '<p><a href="#benchmark-results">top</a></p>');
  });
});

describe("the file's own HTML and unsafe addresses", () => {
  test('raw HTML shows as text, in blocks and inline', () => {
    assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    assert.equal(md('a <img src=x onerror=alert(1)> b'), '<p>a &lt;img src=x onerror=alert(1)&gt; b</p>');
    // The id is GitHub's, so that a link written for GitHub still finds the heading.
    assert.equal(md('# <b>bold</b>'), '<h1 id="bold">&lt;b&gt;bold&lt;/b&gt;</h1>');
  });

  test('a link or image with another scheme keeps only its text', () => {
    assert.equal(md('[click](javascript:alert(1))'), '<p>click</p>');
    assert.equal(md('[x](javascript:alert)'), '<p>x</p>');
    assert.equal(md('![x](data:image/svg+xml,abc)'), '<p>x</p>');
    assert.equal(md('[mail](mailto:a@example.com)'), '<p><a href="mailto:a@example.com">mail</a></p>');
  });

  test('quotes in an address or a title stay inside the attribute', () => {
    assert.equal(md('[a](x.html"onmouseover="alert(1))'), '<p><a href="x.html&quot;onmouseover=&quot;alert(1)">a</a></p>');
  });

  test('an image or a code span inside an address or a title stays text there, and cannot end the attribute', () => {
    assert.equal(md('[l](http://b "![ ping=http://evil/p ](x=)")'), '<p><a href="http://b">l</a></p>');
    assert.equal(md('[a](![i](p))'), '<p>a</p>');
    assert.equal(md('[a](`javascript:alert(1)`)'), '<p>a</p>');
    assert.equal(md('![a "b" `c`](x.png "t `u`")'), '<p><img src="x.png" alt="a &quot;b&quot; c" title="t u"></p>');
  });

  test("the file's own NUL characters cannot stand for what inline() sets aside", () => {
    assert.equal(md('a \u00000\u0000 b `c`'), '<p>a \uFFFD0\uFFFD b <code>c</code></p>');
  });
});

describe('links with markup in their text', () => {
  test('a code span, an escape or an image in a link keeps it: [`code`](url), a badge', () => {
    assert.equal(md('[`foo`](http://x)'), '<p><a href="http://x"><code>foo</code></a></p>');
    assert.equal(md('[a\\*b](x)'), '<p><a href="x">a*b</a></p>');
    assert.equal(md('[![build](badge.svg)](http://ci)'), '<p><a href="http://ci"><img src="badge.svg" alt="build"></a></p>');
    assert.equal(md('[**bold** text][r]\n\n[r]: http://r'), '<p><a href="http://r"><strong>bold</strong> text</a></p>');
  });

  test('an address may hold one pair of parentheses', () => {
    assert.equal(md('[Foo](https://en.wikipedia.org/wiki/Foo_(bar))'), '<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a></p>');
  });

  test('an autolink shows its address as it is', () => {
    assert.equal(md('<https://x.test/*a*>'), '<p><a href="https://x.test/*a*">https://x.test/*a*</a></p>');
  });
});

describe('blocks the review found', () => {
  test('a reference definition inside fenced code stays code', () => {
    assert.equal(md('```\n[a]: http://x\n```'), '<pre><code>[a]: http://x</code></pre>');
    assert.equal(md('~~~ a`b\nx\n~~~'), '<pre><code class="language-a`b">x</code></pre>');
  });

  test('closing #s of a heading go, and a heading of only #s is empty', () => {
    assert.equal(md('# ###'), '<h1 id=""></h1>');
    assert.equal(md('# C# #'), '<h1 id="c">C#</h1>');
  });

  test('quotes nest at most 32 deep; the rest is text', () => {
    const html = md('>'.repeat(40) + ' deep');
    assert.equal(html.match(/<blockquote>/g).length, 32);
    assert.ok(html.includes('&gt;&gt;&gt;&gt;&gt;&gt;&gt;&gt; deep'));
  });

  test('a table row keeps its own cells, up to the header\'s, and is not padded to the header', () => {
    assert.equal(md('|a|b|c|\n|-|-|-|\n|x|\n|1|2|3|4|'),
      '<table><thead><tr><th>a</th><th>b</th><th>c</th></tr></thead><tbody><tr><td>x</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></tbody></table>');
  });
});

// Each line is built to make a backtracking pattern take quadratic or worse time. At this size quadratic work takes
// tens of seconds and linear work a few milliseconds, so the limit is far from both.
describe('time in proportion to the text', () => {
  const N = 200000;
  const crafted = {
    'open brackets': '['.repeat(N),
    'image openers': '!['.repeat(N / 2),
    'links without a close': '[a](x'.repeat(N / 5),
    'titles without a close': '[a](x "'.repeat(N / 7),
    'heading with a long run of spaces': `# a${' '.repeat(N)}b`,
    'fence with a backtick in its info': `\`\`\`${'a'.repeat(N)}\``,
    'delimiter row of spaces': `a|b\n${' '.repeat(N)}x`,
    'strong without a close': '**a '.repeat(N / 4),
    'emphasis without a close': '*a '.repeat(N / 3),
    'underscores without a close': '__a '.repeat(N / 4),
    'strikethrough without a close': '~~a '.repeat(N / 4),
    'a run of backticks': '`'.repeat(N),
    'backtick runs of every length': Array.from({ length: 600 }, (_, i) => '`'.repeat(i + 1)).join('a'),
    'line break check on a run of spaces': `a${' '.repeat(N)}b\nc`,
    'heading of open angle brackets': `# ${'<'.repeat(N)}`,
    'autolinks without a close': '<http:a'.repeat(N / 7),
    'quote markers': '>'.repeat(N),
    'list markers': '- '.repeat(N / 2),
    'a wide table, many rows': `${'|a'.repeat(100)}|\n${'|-'.repeat(100)}|\n${'x|\n'.repeat(N / 3)}`,
  };
  for (const [name, text] of Object.entries(crafted)) {
    test(name, () => {
      const start = performance.now();
      md(text);
      const ms = performance.now() - start;
      assert.ok(ms < 1500, `${name}: ${Math.round(ms)} ms`);
    });
  }
});
