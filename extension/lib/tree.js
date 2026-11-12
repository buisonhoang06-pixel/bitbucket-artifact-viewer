// The files of an artifact as a folder tree, for the viewer's list of files. In each folder, folders come first, then
// files, each in natural order (run-2 before run-10). A folder that holds one folder and no file shares its row with
// it ("coverage/lcov-report"), as editors show such chains. Nesting stops at MAX_DEPTH folders, so that a crafted
// archive cannot nest the list without end: a deeper file is listed in its folder at that depth, under the rest of
// its path.
export const MAX_DEPTH = 16;

const ORDER = new Intl.Collator('en', { numeric: true });
const compare = (a, b) => ORDER.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

// The icon of a file in the list, by its extension. It is only a hint for the eye: the viewer decides how to show a
// file from its content (see kinds.js).
const ICONS = new Map(Object.entries({
  'file-code': 'html htm xhtml xml css js mjs cjs ts tsx jsx py rb go java kt cs php sh sql',
  'file-data': 'json jsonl ndjson yml yaml toml',
  'file-text': 'txt log md markdown csv tsv pdf rst out',
  'file-image': 'png jpg jpeg gif webp avif bmp ico svg',
  'file-video': 'mp4 m4v webm mov',
  'file-archive': 'zip gz tgz tar bz2 xz 7z jar',
  'file-diff': 'patch diff',
}).flatMap(([icon, extensions]) => extensions.split(' ').map((extension) => [extension, icon])));

export function fileIcon(name) {
  return ICONS.get(/\.([^./]+)$/.exec(name)?.[1]?.toLowerCase()) ?? 'file';
}

// paths are the archive's normalized paths (no empty segment). Returns { folders, files }: each folder is
// { name, path, folders, files }, path being the folder's full path; each file is { name, path, icon }.
export function fileTree(paths) {
  const root = folder('', '');
  for (const path of paths) {
    // Only the first MAX_DEPTH folders are looked up, so a path of thousands of segments costs no more than its length.
    const text = String(path);
    let node = root;
    let start = 0;
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const slash = text.indexOf('/', start);
      if (slash < 0) break;
      const part = text.slice(start, slash);
      let next = node.folders.get(part);
      if (!next) {
        next = folder(part, node.path ? `${node.path}/${part}` : part);
        node.folders.set(part, next);
      }
      node = next;
      start = slash + 1;
    }
    const name = text.slice(start);
    node.files.push({ name, path, icon: fileIcon(name) });
  }
  return finish(root);
}

function folder(name, path) {
  return { name, path, folders: new Map(), files: [] };
}

function finish(node) {
  const folders = [...node.folders.values()].map((child) => {
    let current = child;
    let name = child.name;
    while (current.files.length === 0 && current.folders.size === 1) {
      current = current.folders.values().next().value;
      name = `${name}/${current.name}`;
    }
    return { name, path: current.path, ...finish(current) };
  });
  return {
    folders: folders.sort((a, b) => compare(a.name, b.name)),
    files: node.files.sort((a, b) => compare(a.name, b.name)),
  };
}
