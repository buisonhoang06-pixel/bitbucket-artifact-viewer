// Resolves links between files of an unpacked archive, and picks the file to open first.

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

// Returns one of:
//   { kind: 'file', path, anchor }   a file in the archive (anchor is null or a decoded fragment)
//   { kind: 'anchor', anchor }       a place in the same file
//   { kind: 'external', url }        an http, https or mailto link
//   { kind: 'blocked', url }         any other scheme (javascript:, data:, file:, ...)
//   { kind: 'missing', path }        a file that is not in the archive, or a path that climbs above its root
// `files` is anything with has(path), such as the Map that openArchive returns.
export function resolveLink(fromPath, href, files) {
  const raw = String(href ?? '').trim();
  if (raw === '') return { kind: 'anchor', anchor: '' };
  if (raw.startsWith('#')) return { kind: 'anchor', anchor: decode(raw.slice(1)) };
  if (raw.startsWith('//')) return { kind: 'external', url: `https:${raw}` };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (scheme) {
    return SAFE_SCHEMES.has(scheme[1].toLowerCase()) ? { kind: 'external', url: raw } : { kind: 'blocked', url: raw };
  }

  const hashAt = raw.indexOf('#');
  const beforeHash = hashAt === -1 ? raw : raw.slice(0, hashAt);
  const anchor = hashAt === -1 ? null : decode(raw.slice(hashAt + 1));
  const queryAt = beforeHash.indexOf('?');
  const pathPart = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  if (pathPart === '') return { kind: 'anchor', anchor: anchor ?? '' };

  // Resolved by hand rather than with URL, which would clamp a ".." above the root instead of rejecting it.
  const segments = pathPart.startsWith('/') ? [] : folderSegments(fromPath);
  for (const encoded of pathPart.split('/')) {
    const segment = decode(encoded);
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return { kind: 'missing', path: pathPart };
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const path = segments.join('/');
  if (!path || !files.has(path)) return { kind: 'missing', path: path || pathPart };
  return { kind: 'file', path, anchor };
}

// The file to open first: the shallowest HTML file, since a report's own page sits above the files it links to. At
// the same depth index.html comes first, then the others by name; of pages with the same name, the one in the last
// folder, which is the newest when folders are named by date or run number. Null when the archive has no HTML file.
export function pickEntry(paths) {
  const pages = [...paths].filter((path) => /\.html?$/i.test(path));
  return pages.length ? pages.sort(compareEntries)[0] : null;
}

const ORDER = new Intl.Collator('en', { numeric: true });

function compareEntries(a, b) {
  const name = (path) => path.slice(path.lastIndexOf('/') + 1);
  const index = (path) => (/^index\.html?$/i.test(name(path)) ? 0 : 1);
  return a.split('/').length - b.split('/').length
    || index(a) - index(b)
    || ORDER.compare(name(a), name(b))
    || ORDER.compare(b, a);
}

function folderSegments(path) {
  const segments = String(path ?? '').split('/').filter(Boolean);
  segments.pop();
  return segments;
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
