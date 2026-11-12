// How the viewer shows each file of an artifact. Where it matters the decision comes from the content, not the name:
// - an image or a video by its magic bytes;
// - a PDF by its header;
// - a JUnit report by its root element;
// - text by being UTF-8 without a NUL byte.
// The type returned is the one the viewer gives the file's blob, so a file is never handed to Chrome as something its
// bytes are not.

export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024;
export const PDF_MAX_BYTES = 100 * 1024 * 1024;
const SNIFF_BYTES = 64 * 1024;

// Shown as text whatever their bytes, as before 1.2.0.
const TEXT_EXTENSIONS = new Set(['txt', 'log', 'xml', 'yml', 'yaml', 'csv']);
const BINARY = { kind: 'binary', type: 'application/octet-stream' };

// Returns { kind, type }. kind is one of html, pdf, image, video, junit, json, jsonl, markdown, text and binary.
export function fileKind(path, bytes) {
  const extension = /\.([^./]+)$/.exec(String(path))?.[1]?.toLowerCase() ?? '';
  if (extension === 'html' || extension === 'htm') return { kind: 'html', type: 'text/html' };
  if (extension === 'pdf' && startsWithin(bytes, '%PDF-', 1024)) {
    return bytes.length <= PDF_MAX_BYTES ? { kind: 'pdf', type: 'application/pdf' } : BINARY;
  }
  const image = imageType(bytes, extension);
  if (image) return bytes.length <= IMAGE_MAX_BYTES ? { kind: 'image', type: image } : BINARY;
  const video = videoType(bytes, extension);
  if (video) return bytes.length <= VIDEO_MAX_BYTES ? { kind: 'video', type: video } : BINARY;
  if (extension === 'xml' && isJunit(bytes)) return { kind: 'junit', type: 'application/xml' };
  if (extension === 'json') return { kind: 'json', type: 'application/json' };
  if (extension === 'jsonl' || extension === 'ndjson') return { kind: 'jsonl', type: 'application/x-ndjson' };
  if (extension === 'md' || extension === 'markdown') return { kind: 'markdown', type: 'text/markdown' };
  if (TEXT_EXTENSIONS.has(extension) || looksLikeText(bytes)) return { kind: 'text', type: 'text/plain' };
  return BINARY;
}

// Formats whose magic bytes cannot be mistaken for text count whatever the extension; BMP ("BM") and ICO need theirs.
function imageType(bytes, extension) {
  if (has(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (has(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(bytes, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(bytes, 8, 4))) return 'image/avif';
  if (extension === 'bmp' && ascii(bytes, 0, 2) === 'BM') return 'image/bmp';
  if (extension === 'ico' && has(bytes, 0, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (extension === 'svg' && looksLikeText(bytes) && /<svg[\s>]/i.test(decode(bytes.subarray(0, SNIFF_BYTES)))) return 'image/svg+xml';
  return null;
}

// A web font a report's stylesheet names, by its signature.
export function fontType(bytes) {
  const tag = ascii(bytes, 0, 4);
  if (tag === 'wOF2') return 'font/woff2';
  if (tag === 'wOFF') return 'font/woff';
  if (tag === 'OTTO') return 'font/otf';
  if (tag === 'true' || has(bytes, 0, [0x00, 0x01, 0x00, 0x00])) return 'font/ttf';
  return null;
}

// Only what Chrome plays, and only under the extension that says so: Matroska and QuickTime files also carry these
// signatures.
function videoType(bytes, extension) {
  if (extension === 'webm' && has(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'video/webm';
  if ((extension === 'mp4' || extension === 'm4v') && ascii(bytes, 4, 4) === 'ftyp') return 'video/mp4';
  return null;
}

// The root element, after an optional byte order mark and only comments and processing instructions (the XML
// declaration is one), is testsuites or testsuite. A comment ends at its first "-->" and an instruction at its first
// "?>", so the prolog matches one way only, in linear time, and no comment can reach over a DOCTYPE. A DOCTYPE can
// only come before the root, so a match also means the file declares no entities.
const JUNIT_ROOT = /^\uFEFF?\s*(?:(?:<!--(?:(?!-->)[\s\S])*-->|<\?(?:(?!\?>)[\s\S])*\?>)\s*)*<(?:testsuites|testsuite)[\s>/]/;

function isJunit(bytes) {
  return JUNIT_ROOT.test(decode(bytes.subarray(0, SNIFF_BYTES)));
}

// No NUL byte, and valid UTF-8, in the first 64 KB. When the sample stops before the file does, stream mode keeps a
// character cut at its end from counting as invalid; at the real end of the file an unfinished character does count.
export function looksLikeText(bytes) {
  const sample = bytes.subarray(0, SNIFF_BYTES);
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: bytes.length > SNIFF_BYTES });
    return true;
  } catch {
    return false;
  }
}

function has(bytes, at, values) {
  if (bytes.length < at + values.length) return false;
  return values.every((value, index) => bytes[at + index] === value);
}

function ascii(bytes, at, length) {
  if (bytes.length < at + length) return '';
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function startsWithin(bytes, text, limit) {
  return ascii(bytes, 0, Math.min(bytes.length, limit)).includes(text);
}

function decode(bytes) {
  return new TextDecoder().decode(bytes);
}
