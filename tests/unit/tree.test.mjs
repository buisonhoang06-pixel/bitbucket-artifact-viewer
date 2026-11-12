// fileTree: the artifact's files as folders and files, chains of single folders on one row, in natural order.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_DEPTH, fileIcon, fileTree } from '../../extension/lib/tree.js';

// The tree as nested lists of names, folders marked with a slash, for short expectations.
const shape = (node) => [
  ...node.folders.map((folder) => ({ [`${folder.name}/`]: shape(folder) })),
  ...node.files.map((file) => file.name),
];

describe('fileTree', () => {
  test("the benchmark's layout: folders first, single-folder chains on one row, files under their folder", () => {
    const tree = fileTree([
      'summary.md',
      'projects/web/fe/evals/results/2026-11-12T12-14-43-421+0000/report.html',
      'projects/web/fe/evals/results/2026-11-12T12-14-43-421+0000/transcripts/run1.txt',
      'projects/web/mesh/evals/results/2026-11-12T12-14-43-421+0000/report.html',
      'shared/evals/results/2026-11-12T12-14-43-421+0000/report.html',
      'summary.html',
    ]);
    assert.deepEqual(shape(tree), [
      { 'projects/web/': [
        { 'fe/evals/results/2026-11-12T12-14-43-421+0000/': [{ 'transcripts/': ['run1.txt'] }, 'report.html'] },
        { 'mesh/evals/results/2026-11-12T12-14-43-421+0000/': ['report.html'] },
      ] },
      { 'shared/evals/results/2026-11-12T12-14-43-421+0000/': ['report.html'] },
      'summary.html',
      'summary.md',
    ]);
  });

  test('each file keeps its full path; each folder row has the path of its last folder', () => {
    const tree = fileTree(['a/b/c/x.json', 'a/b/c/y.json']);
    assert.equal(tree.folders[0].name, 'a/b/c');
    assert.equal(tree.folders[0].path, 'a/b/c');
    assert.deepEqual(tree.folders[0].files, [
      { name: 'x.json', path: 'a/b/c/x.json', icon: 'file-data' },
      { name: 'y.json', path: 'a/b/c/y.json', icon: 'file-data' },
    ]);
    const split = fileTree(['a/b/x.json', 'a/c/y.json']);
    assert.equal(split.folders[0].name, 'a');
    assert.deepEqual(split.folders[0].folders.map((folder) => folder.path), ['a/b', 'a/c']);
  });

  test('common public layouts: a Playwright report and an lcov report', () => {
    assert.deepEqual(shape(fileTree([
      'playwright-report/index.html',
      'playwright-report/data/3f2a9c.png',
      'playwright-report/data/trace-1.zip',
      'lcov-report/index.html',
      'lcov-report/src/cart.ts.html',
      'lcov.info',
    ])), [
      { 'lcov-report/': [{ 'src/': ['cart.ts.html'] }, 'index.html'] },
      { 'playwright-report/': [{ 'data/': ['3f2a9c.png', 'trace-1.zip'] }, 'index.html'] },
      'lcov.info',
    ]);
  });

  test("a file's icon comes from its extension, any case; an unknown one gets the plain file", () => {
    assert.deepEqual(['a.HTML', 'b.jsonl', 'c.md', 'd.PNG', 'e.webm', 'f.tar.gz', 'g.patch', 'h.bin', 'Makefile', 'run.log']
      .map(fileIcon), ['file-code', 'file-data', 'file-text', 'file-image', 'file-video', 'file-archive', 'file-diff', 'file', 'file', 'file-text']);
  });

  test('a folder that also holds a file does not join its only folder', () => {
    assert.deepEqual(shape(fileTree(['a/notes.md', 'a/b/x.txt'])), [{ 'a/': [{ 'b/': ['x.txt'] }, 'notes.md'] }]);
  });

  test('natural order: run-2 before run-10, case does not decide', () => {
    assert.deepEqual(shape(fileTree(['run-10.txt', 'run-2.txt', 'B.txt', 'a.txt'])), ['a.txt', 'B.txt', 'run-2.txt', 'run-10.txt']);
  });

  test('a file and a folder of the same name both show', () => {
    assert.deepEqual(shape(fileTree(['a', 'a/b'])), [{ 'a/': ['b'] }, 'a']);
  });

  test(`nesting stops at ${MAX_DEPTH} folders; a deeper file is listed under the rest of its path`, () => {
    const deep = [...Array.from({ length: MAX_DEPTH + 3 }, (_, i) => `d${i}`), 'file.txt'].join('/');
    const sibling = (depth) => [...Array.from({ length: depth }, (_, i) => `d${i}`), 'x.txt'].join('/');
    // Siblings at every level keep each folder on its own row.
    const tree = fileTree([deep, ...Array.from({ length: MAX_DEPTH }, (_, i) => sibling(i + 1))]);
    let node = tree;
    let levels = 0;
    while (node.folders.length) {
      node = node.folders[0];
      levels += 1;
    }
    assert.equal(levels, MAX_DEPTH);
    assert.deepEqual(node.files.map((file) => file.name), [`d${MAX_DEPTH}/d${MAX_DEPTH + 1}/d${MAX_DEPTH + 2}/file.txt`, 'x.txt']);
    assert.equal(node.files[0].path, deep);
  });
});
