// A synthetic test report: reports/<stamp>/summary.html linking with "../../" to each project's
// results/<stamp>/report.html and to transcripts. Its report.html also carries what the
// viewer must never run or load: a script, an inline handler, a tracking image, a form and a meta refresh.
import { readdirSync, readFileSync } from 'node:fs';

import { makeTree, tarWithGnuTar } from './archives.mjs';

export const STAMP = '2026-01-01T00-00-00-000+0000';
export const SUMMARY = `reports/${STAMP}/summary.html`;
export const BE = `projects/demo/be/evals/results/${STAMP}`;
export const FE = `projects/demo/fe/evals/results/${STAMP}`;
export const TRANSCRIPT = `${BE}/transcripts/checkout-flow-run1.txt`;

const filler = Array.from({ length: 80 }, (_, i) => `<p>Line ${i + 1} of the run log.</p>`).join('\n');

export const REPORT_FILES = {
  [SUMMARY]: `<!doctype html>
<html><head><meta charset="utf-8"><title>Test results: summary</title>
<style>body { font-family: sans-serif; }</style></head>
<body>
<h1 id="top">Test results: summary</h1>
<p>2 of 3 cases passed.</p>
<ul>
  <li><a id="link-report-be" href="../../${BE}/report.html">report.html (demo-be)</a></li>
  <li><a id="link-report-fe" href="../../${FE.replace('+', '%2B')}/report.html#case-2">demo-fe, case 2</a></li>
  <li><a id="link-transcript" href="../../${TRANSCRIPT}">transcript</a></li>
  <li><a id="link-missing" href="../../${BE}/missing.html">missing</a></li>
  <li><a id="link-js" href="javascript:document.title='JS LINK RAN'">blocked</a></li>
  <li><a id="link-external" href="https://example.com/docs">external</a></li>
  <li><a id="link-spoofed" data-viewer-href="https://example.com/spoofed">no href, a planted original address</a></li>
</ul>
</body></html>
`,
  [`${BE}/report.html`]: `<!doctype html>
<html><head><meta charset="utf-8"><title>demo-be report</title>
<meta http-equiv="refresh" content="0; url=https://tracker.test/refresh">
<script>document.title = 'SCRIPT RAN'; try { parent.document.title = 'SCRIPT RAN IN PARENT'; } catch (e) {}</script>
</head>
<body>
<h1>demo-be report</h1>
<img id="tracker" src="https://tracker.test/pixel.png" alt="">
<div style="background: url(https://tracker.test/background.png)">styled</div>
<form id="form" action="https://tracker.test/form" method="get"><input name="q" value="x"><button id="submit" type="submit">Send</button></form>
<p id="handler" onclick="document.title = 'HANDLER RAN'">click me</p>
<link rel="preconnect" href="https://tracker.test/">
<link rel="dns-prefetch" href="https://tracker.test/">
<img id="map-image" usemap="#hostile-map" width="240" height="40" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
<map name="hostile-map"><area shape="rect" coords="0,0,240,40" href="https://example.com/area"></map>
<svg id="svg-box" width="240" height="40"><a xlink:href="https://example.com/svg"><rect width="240" height="40" fill="#dddddd"></rect></a></svg>
<div id="open-host"><template shadowrootmode="open"><a id="shadow-link" href="https://example.com/shadow">open shadow link</a></template></div>
<div id="closed-host" style="display:block;width:240px;height:24px"><template shadowrootmode="closed"><a href="https://example.com/closed" style="display:block;width:240px;height:24px">closed shadow link</a></template></div>
<a id="to-transcript" href="transcripts/checkout-flow-run1.txt">transcript</a>
<a id="to-case-1" href="#case-1">case 1</a>
<a id="protocol-relative" href="//example.com/relative">protocol-relative link</a>
${filler}
<details class="section"><summary>Case 1</summary><p id="case-1">Case 1 details</p></details>
</body></html>
`,
  [`${FE}/report.html`]: `<!doctype html>
<html><head><meta charset="utf-8"><title>demo-fe report</title></head>
<body>
<h1>demo-fe report</h1>
${filler}
<details class="section"><summary>Case 2</summary><p id="case-2">Case 2 details</p></details>
</body></html>
`,
  [TRANSCRIPT]: 'Transcript of run 1\n<b>not bold</b>\n',
  [`${BE}/aggregate-result.json`]: '{"cases": []}\n',
};

// The artifact as Bitbucket would serve it: a .tar.gz of the report folders. title changes the summary's heading,
// to tell two archives apart; extra adds files.
export function reportArchive({ title = null, extra = {} } = {}) {
  const files = { ...REPORT_FILES, ...extra };
  if (title) files[SUMMARY] = files[SUMMARY].replaceAll('Test results: summary', title);
  return tarWithGnuTar(makeTree(files), { entries: ['reports', 'projects'] });
}

// A benchmark's artifact: the final report at the top, and each run's files below it,
// with an HTML page deeper down that must not open first, and a binary file.
export const BENCH_RUN = 'bench/runs/2026-11-12-batch/case-a/run-1';

export function benchmarkArchive() {
  const binary = new Uint8Array(512);
  binary.set([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]);
  const files = {
    'benchmark.html': `<!doctype html><html><head><meta charset="utf-8"><title>Benchmark results</title></head><body>
<h1>Benchmark results</h1>
<p><a id="to-stream" href="${BENCH_RUN}/stream.jsonl">the session's events</a> · <a id="to-diff" href="${BENCH_RUN}/diff.patch">the agent's changes</a></p>
</body></html>
`,
    'benchmark.md': '# Benchmark results\n\n| case | score |\n|---|---|\n| case-a | 0.8 |\n',
    'benchmark.json': '{"cases":[{"id":"case-a","score":0.8}]}\n',
    [`${BENCH_RUN}/run.json`]: '{"id":"run-1","case":"case-a","model":"model-a"}\n',
    [`${BENCH_RUN}/stream.jsonl`]: '{"type":"system","subtype":"init"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"Reading the files"}]}}\nnot json\n',
    [`${BENCH_RUN}/diff.patch`]: 'diff --git a/src/cart.js b/src/cart.js\n--- a/src/cart.js\n+++ b/src/cart.js\n@@ -1 +1 @@\n-const total = 0;\n+let total = 0;\n',
    [`${BENCH_RUN}/transcript.txt`]: 'Transcript of the run\n',
    [`${BENCH_RUN}/final.md`]: '# Final answer\n\nThe change is ready.\n',
    [`${BENCH_RUN}/notes.html`]: '<!doctype html><title>Run notes</title><h1>Run notes</h1>',
    [`${BENCH_RUN}/screenshot.bin`]: binary,
  };
  return tarWithGnuTar(makeTree(files), { entries: ['benchmark.html', 'benchmark.md', 'benchmark.json', 'bench'] });
}

// The media fixtures in tests/fixtures/media, an index page linking to them, and two files whose names lie: a .pdf
// and a .png that hold HTML.
const MEDIA = new URL('../fixtures/media/', import.meta.url);

export function mediaArchive() {
  const files = {};
  for (const name of readdirSync(MEDIA)) files[`media/${name}`] = new Uint8Array(readFileSync(new URL(name, MEDIA)));
  files['media/fake.pdf'] = '<!doctype html><h1>Not a PDF</h1><script>document.title = "RAN"</script>';
  files['media/fake.png'] = '<!doctype html><h1>Not an image</h1><script>document.title = "RAN"</script>';
  files['index.html'] = '<!doctype html><title>Media</title><h1>Media</h1><p><img id="inline" src="media/shot.png" alt="shot"></p>';
  return tarWithGnuTar(makeTree(files), { entries: ['index.html', 'media'] });
}

// The JUnit fixtures in tests/fixtures/junit, under results/.
const JUNIT = new URL('../fixtures/junit/', import.meta.url);

export function junitFixture(name) {
  return readFileSync(new URL(name, JUNIT), 'utf8');
}

export function junitArchive() {
  const files = {};
  for (const name of readdirSync(JUNIT)) files[`results/${name}`] = junitFixture(name);
  // Past the report's limits: more suites than it builds, and more cases than it builds, written under a prefix.
  files['results/many-suites.xml'] = `<testsuites>${'<testsuite name="s"/>'.repeat(20001)}</testsuites>`;
  files['results/prefixed-cases.xml'] = `<testsuite name="p" xmlns:j="urn:j">${'<j:testcase name="c"/>'.repeat(20001)}</testsuite>`;
  return tarWithGnuTar(makeTree(files), { entries: ['results'] });
}

// A report like a coverage output, in tests/fixtures/report-assets, with its own stylesheets, images and font.
const REPORT_ASSETS = new URL('../fixtures/report-assets/', import.meta.url);

export function assetsArchive() {
  const files = {};
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(new URL(folder, REPORT_ASSETS), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${folder}${entry.name}/`, `${prefix}${entry.name}/`);
      else files[`coverage/${prefix}${entry.name}`] = new Uint8Array(readFileSync(new URL(`${folder}${entry.name}`, REPORT_ASSETS)));
    }
  };
  walk('', '');
  return tarWithGnuTar(makeTree(files), { entries: ['coverage'] });
}

// Markdown that uses every part of the subset, a page it links to, an image, and HTML and an address that must stay
// inert.
export function markdownArchive() {
  const png = new Uint8Array(readFileSync(new URL('../fixtures/media/shot.png', import.meta.url)));
  const files = {
    'docs/README.md': `# Project notes

Read the [guide](guide.md), or jump to [the results](#results).

## Steps

1. Install
2. Run the **checks**
   - unit
   - e2e

> A quoted line.

\`\`\`sh
npm test
\`\`\`

## Results

| case | score |
|---|---:|
| case-a | 0.8 |

![logo](img/logo.png)

<script>document.title = 'RAN'</script>
[a trap](javascript:alert(1))
`,
    'docs/guide.md': '# The guide\n\nBack to the [notes](README.md).\n',
    'docs/img/logo.png': png,
  };
  return tarWithGnuTar(makeTree(files), { entries: ['docs'] });
}

// An archive with no HTML file, only a large log.
export function logArchive(bytes) {
  return tarWithGnuTar(makeTree({ 'logs/big.log': 'x'.repeat(bytes) }), { entries: ['logs'] });
}
