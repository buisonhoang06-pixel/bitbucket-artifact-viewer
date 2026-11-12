// Markdown to HTML, for the Markdown files of an artifact. Escape-first: the file's text is escaped before any markup
// is added, so its own HTML shows as text, and every tag in the result comes from here. Link and image addresses keep
// only what a report may use (a relative path, an anchor, http, https or mailto); prepareHtml then rewrites them
// like any report's.
//
// The subset is what reports use: ATX headings, paragraphs and line breaks, emphasis, strong, strikethrough, code
// spans, fenced and indented code, nested lists, block quotes, horizontal rules, links and images (inline, by
// reference, and autolinks) and GFM tables.
//
// The file is the artifact's, so a pattern that backtracks on a crafted line would freeze the tab: every pattern and
// loop here takes time in proportion to the line. Quotes and lists nest at most MAX_NESTING deep, and a table row
// keeps only its own cells (up to the header's): padding each short row to the header's width would let a few bytes
// make a row of a hundred cells.

const FENCE = /^ {0,3}(`{3,}|~{3,})([\s\S]*)/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+([\s\S]*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?([\s\S]*)/;
const ITEM = /^( {0,12})([-*+]|\d{1,9}[.)])(?:[ \t]+([\s\S]*)|[ \t]*$)/;
const DELIMITER_CELL = /^:?-+:?$/;
const REFERENCE = /^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+"([^"]*)")?\s*$/;
const SAFE_ADDRESS = /^(?:[a-z][a-z0-9+.-]*:)?/i;
const MAX_NESTING = 32;

// On escaped text. A label holds no bracket and an address no space, and an address's parentheses come in pairs one
// deep (https://en.wikipedia.org/wiki/Foo_(bar)), so that each scan stops at the next bracket, space or quote.
const ADDRESS = String.raw`((?:[^\s()]|\([^\s()]*\))+)`;
const TITLE = String.raw`(?:\s+&quot;((?:[^&]|&(?!quot;))*)&quot;)?`;
const IMAGE = new RegExp(String.raw`!\[([^\][]*)\]\(\s*${ADDRESS}${TITLE}\s*\)`, 'g');
const LINK = new RegExp(String.raw`\[([^\][]+)\]\(\s*${ADDRESS}${TITLE}\s*\)`, 'g');
const REFERENCE_LINK = /\[([^\][]+)\]\[([^\][]*)\]/g;
const AUTOLINK = /&lt;((?:https?|mailto):(?:[^\s&]|&amp;)+?)&gt;/g;
// Emphasis does not reach past the next marker of its kind.
const STRONG = /\*\*(?=\S)((?:(?!\*\*)[\s\S])*?\S)\*\*/g;
const STRONG_UNDERSCORE = /(^|[^\w])__(?=\S)((?:(?!__)[\s\S])*?\S)__(?=[^\w]|$)/g;
const EMPHASIS = /\*(?=[^\s*])([^*]*?[^\s*])\*/g;
const EMPHASIS_UNDERSCORE = /(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?=[^\w]|$)/g;
const STRIKE = /~~(?=\S)((?:(?!~~)[\s\S])*?\S)~~/g;

export function markdownToHtml(text) {
  const references = new Map();
  let fence = null;
  // The file's own NUL characters go first: inline() marks what it sets aside with them.
  const lines = String(text).replace(/\u0000/g, '\uFFFD').replace(/\r\n?/g, '\n').split('\n').filter((line) => {
    // A reference definition inside fenced code is code.
    if (fence) {
      if (fence.closes.test(line)) fence = null;
      return true;
    }
    fence = fenceAt(line);
    if (fence) return true;
    const reference = REFERENCE.exec(line);
    if (!reference) return true;
    references.set(reference[1].toLowerCase(), { address: reference[2], title: reference[3] ?? null });
    return false;
  });
  return blocks(lines, { references, slugs: new Map(), depth: 0 });
}

function blocks(lines, context) {
  const out = [];
  const nests = context.depth < MAX_NESTING;
  const inner = { ...context, depth: context.depth + 1 };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const fence = fenceAt(line);
    if (fence) {
      const body = [];
      i += 1;
      while (i < lines.length && !fence.closes.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const language = fence.language ? ` class="language-${escapeHtml(fence.language)}"` : '';
      out.push(`<pre><code${language}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = headingText(heading[2] ?? '');
      out.push(`<h${level} id="${slug(content, context.slugs)}">${inline(content, context)}</h${level}>`);
      i += 1;
      continue;
    }
    if (RULE.test(line)) {
      out.push('<hr>');
      i += 1;
      continue;
    }
    if (nests && QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        body.push(QUOTE.exec(lines[i])[1]);
        i += 1;
      }
      out.push(`<blockquote>${blocks(body, inner)}</blockquote>`);
      continue;
    }
    if (tableAt(lines, i)) {
      const header = cells(line);
      const align = cells(lines[i + 1]).map((cell) => (cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : cell.startsWith(':') ? 'left' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(cells(lines[i]));
        i += 1;
      }
      const cell = (tag, content, index) => `<${tag}${align[index] ? ` style="text-align:${align[index]}"` : ''}>${inline(content, context)}</${tag}>`;
      out.push(`<table><thead><tr>${header.map((content, index) => cell('th', content, index)).join('')}</tr></thead>`
        + `<tbody>${rows.map((row) => `<tr>${row.slice(0, header.length).map((content, index) => cell('td', content, index)).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const item = nests ? ITEM.exec(line) : null;
    if (item) {
      const [list, next] = listAt(lines, i, inner);
      out.push(list);
      i = next;
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (lines[i].trim() === '' && /^( {4}|\t)/.test(lines[i + 1] ?? '')))) {
        body.push(lines[i].replace(/^( {4}|\t)/, ''));
        i += 1;
      }
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '' && !startsBlock(lines, i)) {
      paragraph.push(lines[i]);
      i += 1;
    }
    if (!paragraph.length) {
      paragraph.push(lines[i]);
      i += 1;
    }
    out.push(`<p>${paragraph.map((part, index) => {
      const last = index === paragraph.length - 1;
      const broken = !last && (part.endsWith('  ') || part.endsWith('\\'));
      return inline((part.endsWith('\\') ? part.slice(0, -1) : part).trimEnd(), context) + (broken ? '<br>' : last ? '' : '\n');
    }).join('')}</p>`);
  }
  return out.join('\n');
}

function startsBlock(lines, i) {
  const line = lines[i];
  return fenceAt(line) !== null || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || tableAt(lines, i);
}

// A fence's opening line: the language, and the pattern of the line that closes it. A backtick fence's info string
// has no backtick.
function fenceAt(line) {
  const match = FENCE.exec(line);
  if (!match || (match[1][0] === '`' && match[2].includes('`'))) return null;
  return {
    language: match[2].trim().split(/\s/)[0],
    closes: new RegExp(`^ {0,3}${match[1][0]}{${match[1].length},}[ \\t]*$`),
  };
}

// An ATX heading's text, without its closing #s and the spaces before them.
function headingText(text) {
  const trimmed = text.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === '#') end -= 1;
  if (end === 0) return '';
  if (end === trimmed.length || !/[ \t]/.test(trimmed[end - 1])) return trimmed;
  return trimmed.slice(0, end).trimEnd();
}

// A GFM table: a line with a pipe, then a delimiter row of dashes (colons for the alignment) in each cell.
function tableAt(lines, i) {
  if (!lines[i].includes('|') || i + 1 >= lines.length) return false;
  let row = lines[i + 1].trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').every((cell) => DELIMITER_CELL.test(cell.trim()));
}

// A list from line i: its items continue on lines indented past the marker, and a nested list is just content of
// an item. A change between ordered and unordered markers ends the list. context is the items' own, one level in.
function listAt(lines, start, context) {
  const first = ITEM.exec(lines[start]);
  const indent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;
  while (i < lines.length) {
    const item = ITEM.exec(lines[i]);
    if (!item || item[1].length !== indent || /\d/.test(item[2]) !== ordered) break;
    const contentIndent = indent + item[2].length + 1;
    const body = [item[3] ?? ''];
    i += 1;
    while (i < lines.length) {
      const line = lines[i];
      if (line.trim() === '') {
        const next = lines[i + 1] ?? '';
        if (next.trim() !== '' && leading(next) >= contentIndent) {
          body.push('');
          i += 1;
          continue;
        }
        break;
      }
      const sibling = ITEM.exec(line);
      if (sibling && sibling[1].length <= indent) break;
      if (leading(line) < contentIndent && !sibling && startsBlock(lines, i)) break;
      body.push(line.slice(Math.min(leading(line), contentIndent)));
      i += 1;
    }
    items.push(body);
  }
  const start1 = ordered ? Number.parseInt(first[2], 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  const open = ordered && start1 !== 1 ? `<ol start="${start1}">` : `<${tag}>`;
  const html = items.map((body) => {
    const tight = !body.includes('');
    const inner = blocks(body, context);
    return `<li>${tight ? inner.replace(/^<p>([\s\S]*?)<\/p>/, '$1') : inner}</li>`;
  }).join('');
  while (i < lines.length && lines[i].trim() === '' && ITEM.exec(lines[i + 1] ?? '')?.[1].length === indent) i += 1;
  return [`${open}${html}</${tag}>`, i];
}

function leading(line) {
  return line.length - line.trimStart().length;
}

function cells(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|') && !row.endsWith('\\|')) row = row.slice(0, -1);
  return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

// Inline markup on escaped text. Code spans and backslash escapes are set aside first, so that nothing inside them is
// read as markup, and links and images as they are made. What is set aside waits in kept behind a NUL placeholder
// (markdownToHtml removed the file's own NULs) and goes back in at the end. A link's text is read with the same
// kept, so that a code span or an image in it comes back too: [`code`](url), or a badge [![build](badge.svg)](ci).
function inline(text, context, kept = []) {
  const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  // An attribute's value: what is set aside comes back as text, without its tags, so that nothing set aside can end
  // the attribute; what is left is escaped text, which has no quote.
  const plain = (html) => restore(html, kept).replace(/<[^<>]*>/g, '');
  let out = codeSpans(String(text), keep).replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, (_, char) => keep(escapeHtml(char)));
  out = escapeHtml(out)
    .replace(IMAGE, (_, alt, address, title) => keep(image(plain(alt), plain(address), title && plain(title))))
    .replace(LINK, (_, label, address, title) => keep(link(inline(unescapeHtml(label), context, kept), plain(address), title && plain(title))))
    .replace(REFERENCE_LINK, (match, label, id) => {
      const reference = context.references.get(unescapeHtml(id || label).toLowerCase());
      if (!reference) return match;
      return keep(link(inline(unescapeHtml(label), context, kept), escapeHtml(reference.address), reference.title && escapeHtml(reference.title)));
    })
    .replace(AUTOLINK, (_, address) => keep(link(address, plain(address), null)))
    .replace(STRONG, '<strong>$1</strong>')
    .replace(STRONG_UNDERSCORE, '$1<strong>$2</strong>')
    .replace(EMPHASIS, '<em>$1</em>')
    .replace(EMPHASIS_UNDERSCORE, '$1<em>$2</em>')
    .replace(STRIKE, '<del>$1</del>');
  return restore(out, kept);
}

function restore(html, kept) {
  let out = html;
  for (let pass = 0; pass < 4 && out.includes('\u0000'); pass += 1) out = out.replace(/\u0000(\d+)\u0000/g, (_, index) => kept[Number(index)] ?? '');
  return out;
}

// Code spans as CommonMark finds them: a run of backticks opens one and the next run of the same length closes it;
// a run that nothing closes stays as text. Each run is looked at once.
function codeSpans(text, keep) {
  const runs = [...text.matchAll(/`+/g)].map((match) => ({ at: match.index, length: match[0].length }));
  const closer = new Array(runs.length).fill(-1);
  const later = new Map();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    closer[index] = later.get(runs[index].length) ?? -1;
    later.set(runs[index].length, index);
  }
  let out = '';
  let copied = 0;
  runs.forEach((run, index) => {
    if (run.at < copied || closer[index] < 0) return;
    const end = runs[closer[index]];
    out += text.slice(copied, run.at) + keep(`<code>${escapeHtml(text.slice(run.at + run.length, end.at).trim())}</code>`);
    copied = end.at + end.length;
  });
  return out + text.slice(copied);
}

// Addresses here are escaped text. One with a scheme other than http, https or mailto is left out, and so is one
// that is empty once what was set aside in it is gone.
function safe(address) {
  const scheme = SAFE_ADDRESS.exec(address)[0].toLowerCase();
  return address && (scheme === '' || scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') ? address : null;
}

// html is the link's text, already marked up.
function link(html, address, title) {
  const target = safe(address);
  if (target === null) return html;
  return `<a href="${target}"${title ? ` title="${title}"` : ''}>${html}</a>`;
}

function image(alt, address, title) {
  const target = safe(address);
  if (target === null) return alt;
  return `<img src="${target}" alt="${alt}"${title ? ` title="${title}"` : ''}>`;
}

// GitHub's way: lower case, spaces to hyphens, other punctuation dropped; a repeated heading gets -1, -2 and so on.
function slug(text, slugs) {
  const base = String(text).toLowerCase().replace(/<[^<>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');
  const seen = slugs.get(base) ?? 0;
  slugs.set(base, seen + 1);
  return escapeHtml(seen ? `${base}-${seen}` : base);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function unescapeHtml(text) {
  return String(text).replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);
}
