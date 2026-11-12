// Builds real archives for the tests with the tools that write them in practice: GNU tar (gnu, pax and ustar
// formats) and Python's tarfile.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const scratch = [];

export function cleanup() {
  while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
}

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

// files: { 'a/b.txt': 'text' | Uint8Array }; links: { 'a/link': 'target' } become symlinks.
export function makeTree(files, links = {}) {
  const root = tempDir('bav-tree-');
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  for (const [path, target] of Object.entries(links)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    symlinkSync(target, full);
  }
  return root;
}

// GNU tar. `entries` are the names given to tar inside `root`; ['.'] stores every path with a leading "./".
export function tarWithGnuTar(root, { format = 'gnu', gzip = true, entries = ['.'] } = {}) {
  const out = join(tempDir('bav-tar-'), gzip ? 'archive.tar.gz' : 'archive.tar');
  execFileSync('tar', ['-C', root, `--format=${format}`, gzip ? '-czf' : '-cf', out, ...entries], { stdio: 'pipe' });
  return new Uint8Array(readFileSync(out));
}

// Python's tarfile in pax format, its default since Python 3.8.
export function tarWithPython(root, { gzip = true } = {}) {
  const out = join(tempDir('bav-tar-'), gzip ? 'archive.tar.gz' : 'archive.tar');
  const script = [
    'import os, sys, tarfile',
    'root, out, mode = sys.argv[1], sys.argv[2], sys.argv[3]',
    'with tarfile.open(out, mode, format=tarfile.PAX_FORMAT) as archive:',
    '    for name in sorted(os.listdir(root)):',
    '        archive.add(os.path.join(root, name), arcname=name)',
  ].join('\n');
  execFileSync('python3', ['-I', '-c', script, root, out, gzip ? 'w:gz' : 'w'], { stdio: 'pipe' });
  return new Uint8Array(readFileSync(out));
}

// Entries with names and types that tar would not write from a folder: [{ name, data, type }], where type is
// 'file' (default), 'dir' or 'symlink'.
export function craftedTar(entries, { gzip = true } = {}) {
  const out = join(tempDir('bav-tar-'), gzip ? 'archive.tar.gz' : 'archive.tar');
  const spec = join(tempDir('bav-spec-'), 'entries.json');
  writeFileSync(spec, JSON.stringify(entries));
  const script = [
    'import io, json, sys, tarfile',
    'spec, out, mode = sys.argv[1], sys.argv[2], sys.argv[3]',
    'with tarfile.open(out, mode, format=tarfile.GNU_FORMAT) as archive:',
    '    for entry in json.load(open(spec)):',
    '        info = tarfile.TarInfo(entry["name"])',
    '        kind = entry.get("type", "file")',
    '        data = entry.get("data", "").encode()',
    '        if kind == "dir":',
    '            info.type = tarfile.DIRTYPE',
    '            archive.addfile(info)',
    '        elif kind == "symlink":',
    '            info.type = tarfile.SYMTYPE',
    '            info.linkname = entry["target"]',
    '            archive.addfile(info)',
    '        else:',
    '            info.size = len(data)',
    '            archive.addfile(info, io.BytesIO(data))',
  ].join('\n');
  execFileSync('python3', ['-I', '-c', script, spec, out, gzip ? 'w:gz' : 'w'], { stdio: 'pipe' });
  return new Uint8Array(readFileSync(out));
}
