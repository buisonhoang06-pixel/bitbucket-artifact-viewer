import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { pickEntry, resolveLink } from '../../extension/lib/links.js';

const SUMMARY = 'reports/2026-11-11T06-20-30-787+0700/summary.html';
const REPORT = 'projects/app/be/evals/results/2026-11-11T06-20-30-787+0700/report.html';
const TRANSCRIPT = 'projects/app/be/evals/results/2026-11-11T06-20-30-787+0700/transcripts/checkout-flow-run1.txt';
const FILES = new Set([SUMMARY, REPORT, TRANSCRIPT, 'docs/my file.txt', 'docs/index.html']);

describe('resolveLink', () => {
  test('the links of a real summary.html, with "+" in the stamp and "%20" for a space', () => {
    assert.deepEqual(
      resolveLink(SUMMARY, '../../projects/app/be/evals/results/2026-11-11T06-20-30-787+0700/report.html', FILES),
      { kind: 'file', path: REPORT, anchor: null },
    );
    assert.deepEqual(
      resolveLink(SUMMARY, '../../projects/app/be/evals/results/2026-11-11T06-20-30-787%2B0700/transcripts/checkout-flow-run1.txt', FILES),
      { kind: 'file', path: TRANSCRIPT, anchor: null },
    );
    assert.deepEqual(resolveLink('docs/index.html', 'my%20file.txt', FILES), { kind: 'file', path: 'docs/my file.txt', anchor: null });
  });

  test('fragments and query strings', () => {
    assert.deepEqual(resolveLink(REPORT, 'report.html#case-3', FILES), { kind: 'file', path: REPORT, anchor: 'case-3' });
    assert.deepEqual(resolveLink(REPORT, './report.html?x=1#a%20b', FILES), { kind: 'file', path: REPORT, anchor: 'a b' });
    assert.deepEqual(resolveLink(REPORT, '#top', FILES), { kind: 'anchor', anchor: 'top' });
    assert.deepEqual(resolveLink(REPORT, '?x=1', FILES), { kind: 'anchor', anchor: '' });
    assert.deepEqual(resolveLink(REPORT, '', FILES), { kind: 'anchor', anchor: '' });
  });

  test('a path from the archive root', () => {
    assert.deepEqual(resolveLink(REPORT, '/docs/index.html', FILES), { kind: 'file', path: 'docs/index.html', anchor: null });
  });

  test('external and blocked schemes', () => {
    assert.deepEqual(resolveLink(SUMMARY, 'https://bitbucket.org/x', FILES), { kind: 'external', url: 'https://bitbucket.org/x' });
    assert.deepEqual(resolveLink(SUMMARY, 'HTTP://example.com', FILES), { kind: 'external', url: 'HTTP://example.com' });
    assert.deepEqual(resolveLink(SUMMARY, 'mailto:team@example.com', FILES), { kind: 'external', url: 'mailto:team@example.com' });
    assert.deepEqual(resolveLink(SUMMARY, '//example.com/a', FILES), { kind: 'external', url: 'https://example.com/a' });
    for (const href of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'file:///etc/passwd', 'chrome-extension://abc/viewer.html']) {
      assert.equal(resolveLink(SUMMARY, href, FILES).kind, 'blocked', href);
    }
  });

  test('missing files and paths above the root', () => {
    assert.deepEqual(resolveLink(SUMMARY, 'nope.html', FILES), { kind: 'missing', path: 'reports/2026-11-11T06-20-30-787+0700/nope.html' });
    assert.equal(resolveLink(SUMMARY, '../../../report.html', FILES).kind, 'missing');
    assert.equal(resolveLink('top.html', '../x.txt', new Set(['x.txt'])).kind, 'missing');
    assert.equal(resolveLink(SUMMARY, '../../projects/', FILES).kind, 'missing');
  });

  test('a bad percent sequence is kept as typed', () => {
    assert.deepEqual(resolveLink('a.html', 'b%zz.txt', new Set(['b%zz.txt'])), { kind: 'file', path: 'b%zz.txt', anchor: null });
  });
});

describe('pickEntry', () => {
  test('the shallowest HTML file; a root index.html wins over any page deeper in', () => {
    assert.equal(pickEntry(['a/b/summary.html', 'c/summary.html', 'index.html']), 'index.html');
    assert.equal(pickEntry(['x/y/index.html', 'z/index.html', 'report.html']), 'report.html');
    assert.equal(pickEntry(['playwright-report/data/a.html', 'playwright-report/index.html']), 'playwright-report/index.html');
    assert.equal(pickEntry(['notes.txt', 'data.json']), null);
    assert.equal(pickEntry(new Map([['only/summary.html', new Uint8Array()]]).keys()), 'only/summary.html');
  });

  test('at the same depth index.html first, then by name, in natural order', () => {
    assert.equal(pickEntry(['site/report.html', 'site/index.htm', 'site/about.html']), 'site/index.htm');
    assert.equal(pickEntry(['notes.txt', 'b/report.HTML', 'a/report.htm']), 'a/report.htm');
    assert.equal(pickEntry(['a/run-10.html', 'a/run-2.html']), 'a/run-2.html');
  });

  test('of same-named pages at the same depth, the one in the last folder: the newest, for folders named by date', () => {
    assert.equal(pickEntry([
      'reports/2026-11-10T11-57-05-342+0700/summary.html',
      SUMMARY,
      'reports/2026-11-10T14-45-21-335+0700/summary.html',
      REPORT,
    ]), SUMMARY);
    assert.equal(pickEntry(['runs/run-9/index.html', 'runs/run-10/index.html']), 'runs/run-10/index.html');
  });

  test("the benchmark's artifact opens on benchmark.html, even with HTML files deeper in its runs", () => {
    assert.equal(pickEntry([
      'bench/runs/batch-1/case-a/run-1/notes.html',
      'bench/runs/batch-1/case-a/run-1/stream.jsonl',
      'benchmark.html',
      'benchmark.json',
      'benchmark.md',
    ]), 'benchmark.html');
  });
});
