// Builds the documents the viewer puts into its sandboxed frame. The artifact's HTML never enters the viewer's own
// page: it is parsed with DOMParser, which runs and loads nothing, adjusted, and handed over as srcdoc text.

// Images and fonts may come from blob: URLs, which only the viewer makes, from the artifact's own files.
export const RENDER_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src blob:; form-action 'none'; base-uri 'none'";

// Resource hints can open connections or resolve names without any request a policy would see.
const HINTS = new Set(['dns-prefetch', 'preconnect', 'prefetch', 'preload', 'prerender', 'modulepreload']);
// Frames and plug-ins. The policy blocks everything they would load except an iframe's srcdoc, a document of its own
// that this cleaner never sees: its resource hints reached the network in Chrome 156. Reports need none of them.
const EMBEDS = 'iframe, frame, frameset, object, embed, fencedframe, portal';

// Where a rewritten link keeps the address the artifact gave it, for the viewer's own click handling.
export const ORIGINAL_HREF = 'data-viewer-href';
const XLINK = 'http://www.w3.org/1999/xlink';

// The artifact's own HTML, with the policy that blocks every network load put first. A meta refresh and resource
// hints are removed too; the sandbox and the policy already stop what they could do, and removing them keeps it so
// if either is ever loosened. Declarative shadow roots are made open, so that the viewer sees the links inside them
// (a closed root hides its links from the viewer's click handling); with scripts off, no other shadow root exists.
//
// linkAddress(href) gives the address each link carries, or null to keep it. The viewer follows a clicked link
// itself, from the original address kept in ORIGINAL_HREF. The carried address is what Chrome opens when a link is
// opened another way (a middle click, "Open link in new tab", dragging): a relative link would otherwise resolve
// into the extension's own folder, where the file does not exist.
//
// assets, when given, maps the report's own images, stylesheets and fonts to the artifact's files (see rewriteAssets).
export function prepareHtml(html, linkAddress = () => null, assets = null) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  clean(doc, linkAddress, assets);
  const policy = doc.createElement('meta');
  policy.setAttribute('http-equiv', 'Content-Security-Policy');
  policy.setAttribute('content', RENDER_CSP);
  // Right after the policy and before anything of the report's, so that an "on" in the report cannot turn the
  // prefetching of link hosts back on.
  const prefetch = doc.createElement('meta');
  prefetch.setAttribute('http-equiv', 'x-dns-prefetch-control');
  prefetch.setAttribute('content', 'off');
  doc.head.prepend(policy, prefetch);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// DOMParser leaves declarative shadow roots as plain templates, so their contents, and templates nested in them,
// are cleaned through template.content. Only HTML templates have content; a <template> inside SVG or MathML is an
// ordinary element of that namespace.
const HTML_NS = 'http://www.w3.org/1999/xhtml';

function clean(root, linkAddress, assets) {
  for (const node of root.querySelectorAll(EMBEDS)) node.remove();
  for (const node of root.querySelectorAll(`[${ORIGINAL_HREF}]`)) node.removeAttribute(ORIGINAL_HREF);
  for (const link of root.querySelectorAll('a, area')) {
    const href = link.getAttribute('href') ?? link.getAttributeNS(XLINK, 'href');
    if (href === null) continue;
    link.setAttribute(ORIGINAL_HREF, href);
    const address = linkAddress(href);
    if (address !== null) link.setAttribute('href', address);
  }
  for (const meta of root.querySelectorAll('meta[http-equiv]')) {
    if (meta.getAttribute('http-equiv').trim().toLowerCase() === 'refresh') meta.remove();
  }
  for (const link of root.querySelectorAll('link[rel]')) {
    if (link.getAttribute('rel').toLowerCase().split(/\s+/).some((token) => HINTS.has(token))) link.remove();
  }
  for (const template of root.querySelectorAll('template')) {
    if (template.namespaceURI !== HTML_NS || !template.content) continue;
    if (template.hasAttribute('shadowrootmode')) template.setAttribute('shadowrootmode', 'open');
    clean(template.content, linkAddress, assets);
  }
  if (assets) rewriteAssets(root, assets);
}

// The report's images, stylesheets and fonts, from the artifact. assets.image(address) and assets.css(text) come from
// the viewer: the first gives a blob URL for an archive image, or null; the second rewrites the url() and @import
// of a stylesheet. assets.stylesheet(address) gives an archive stylesheet's text, rewritten, or null. Whatever is not
// in the archive keeps its address, and the policy then blocks it.
function rewriteAssets(root, assets) {
  for (const style of root.querySelectorAll('style')) style.textContent = safeStyleText(assets.css(style.textContent));
  for (const element of root.querySelectorAll('[style]')) element.setAttribute('style', assets.css(element.getAttribute('style')));
  for (const image of root.querySelectorAll('img[src], input[type="image" i][src]')) {
    const address = assets.image(image.getAttribute('src'));
    if (address) image.setAttribute('src', address);
  }
  for (const element of root.querySelectorAll('img[srcset], source[srcset]')) {
    let changed = false;
    const candidates = srcsetCandidates(element.getAttribute('srcset')).map(({ url, descriptors }) => {
      const address = assets.image(url);
      if (address) changed = true;
      return [address ?? url, descriptors].filter(Boolean).join(' ');
    });
    if (changed) element.setAttribute('srcset', candidates.join(', '));
  }
  for (const image of root.querySelectorAll('image')) {
    const href = image.getAttribute('href') ?? image.getAttributeNS(XLINK, 'href');
    const address = href === null ? null : assets.image(href);
    if (address) image.setAttribute('href', address);
  }
  for (const link of root.querySelectorAll('link[rel][href]')) {
    if (!link.getAttribute('rel').toLowerCase().split(/\s+/).includes('stylesheet')) continue;
    const css = assets.stylesheet(link.getAttribute('href'));
    if (css === null) continue;
    const style = link.ownerDocument.createElement('style');
    if (link.hasAttribute('media')) style.setAttribute('media', link.getAttribute('media'));
    style.textContent = safeStyleText(css);
    link.replaceWith(style);
  }
}

// An inlined stylesheet must not end its <style> early: "</style" inside it, which CSS never needs, is escaped, so
// that nothing after it becomes markup the cleaner never saw.
function safeStyleText(css) {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

// The candidates of a srcset, split as the HTML standard splits them: a URL runs to the next space, so that a comma
// inside one (a data: URL) does not end it, and a comma at its end does; the descriptors run to the next comma
// outside parentheses.
export function srcsetCandidates(value) {
  const candidates = [];
  let at = 0;
  while (at < value.length) {
    while (at < value.length && /[\s,]/.test(value[at])) at += 1;
    if (at >= value.length) break;
    const start = at;
    while (at < value.length && !/\s/.test(value[at])) at += 1;
    let url = value.slice(start, at);
    let descriptors = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const from = at;
      let depth = 0;
      while (at < value.length && (value[at] !== ',' || depth > 0)) {
        if (value[at] === '(') depth += 1;
        else if (value[at] === ')' && depth > 0) depth -= 1;
        at += 1;
      }
      descriptors = value.slice(from, at).trim();
    }
    candidates.push({ url, descriptors });
  }
  return candidates;
}

// The address of a url() is quoted, or unquoted without spaces, quotes or parentheses, as CSS has it. Each form ends
// at the first character it cannot hold, and an unquoted one is never empty, so that the spaces around it can be
// split only one way: a crafted stylesheet costs time in proportion to its length. An empty url() stays as it is.
const CSS_ADDRESS = String.raw`(?:"([^"]*)"|'([^']*)'|([^'"()\s]+))`;
const CSS_IMPORT = new RegExp(String.raw`@import\s+(?:url\(\s*${CSS_ADDRESS}\s*\)|"([^"]*)"|'([^']*)')([^;{}@]*);`, 'gi');
const CSS_URL = new RegExp(String.raw`url\(\s*${CSS_ADDRESS}\s*\)`, 'gi');

// The url() and @import of a stylesheet. resolve(address) gives the address to use instead, or null to keep it;
// load(address) gives the text of an imported stylesheet, already rewritten, or null to keep the @import.
export function rewriteCss(text, { resolve, load }) {
  const imported = text.replace(CSS_IMPORT, (match, double, single, bare, string1, string2, media) => {
    const css = load((double ?? single ?? bare ?? string1 ?? string2).trim());
    if (css === null) return match;
    return media.trim() ? `@media ${media.trim()} {\n${css}\n}` : css;
  });
  return imported.replace(CSS_URL, (match, double, single, bare) => {
    const replacement = resolve((double ?? single ?? bare).trim());
    return replacement === null ? match : `url("${replacement}")`;
  });
}

// JSON with two-space indentation, or null when the text is not JSON. It is the file's own text, re-indented: numbers
// stay as written (parsing would turn 12345678901234567890 into 12345678901234567000 and 1e999 into null), and keys
// keep their order, repeated ones too. Indentation stops growing after MAX_INDENT levels, so that deep nesting cannot
// make the text explode, and formatting stops once the text is longer than limit, which the caller then cuts.
const MAX_INDENT = 32;
const JSON_SPACE = new Set([' ', '\t', '\n', '\r']);

export function formatJson(text, limit = Infinity) {
  try {
    JSON.parse(text);
  } catch {
    return null;
  }
  const parts = [];
  let length = 0;
  let depth = 0;
  const put = (part) => {
    parts.push(part);
    length += part.length;
  };
  const newline = () => `\n${'  '.repeat(Math.min(depth, MAX_INDENT))}`;
  for (let at = 0; at < text.length && length <= limit; at += 1) {
    const char = text[at];
    if (char === '"') {
      let end = at + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      put(text.slice(at, end + 1));
      at = end;
    } else if (char === '{' || char === '[') {
      // An empty object or array stays on one line.
      let next = at + 1;
      while (JSON_SPACE.has(text[next])) next += 1;
      if (text[next] === (char === '{' ? '}' : ']')) {
        put(char + text[next]);
        at = next;
      } else {
        depth += 1;
        put(char + newline());
      }
    } else if (char === '}' || char === ']') {
      depth -= 1;
      put(newline() + char);
    } else if (char === ',') {
      put(`,${newline()}`);
    } else if (char === ':') {
      put(': ');
    } else if (!JSON_SPACE.has(char)) {
      put(char);
    }
  }
  return parts.join('');
}

// JSON Lines: each record pretty-printed under its line number. A line that is not JSON is kept as it is, and blank
// lines are left out. As for formatJson, formatting stops once the text is longer than limit.
export function formatJsonl(text, limit = Infinity) {
  const out = [];
  let length = 0;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && length <= limit; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    const record = `── line ${index + 1} ──\n${formatJson(line, limit - length) ?? line}`;
    out.push(record);
    length += record.length + 1;
  }
  return out.join('\n');
}

// note: an optional line shown above the text, such as "Showing the first 2.00 MB".
export function textDocument(text, note = null) {
  const banner = note ? `<p class="note">${escapeHtml(note)}</p>` : '';
  return documentShell(
    `${banner}<pre>${escapeHtml(text)}</pre>`,
    'pre{margin:0;padding:16px;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word}'
      + '.note{margin:0;padding:8px 16px;font:13px/1.4 system-ui,sans-serif;border-bottom:1px solid GrayText}',
  );
}

// An image or a video of the artifact, from a blob URL the viewer made with the type its bytes have. The policy
// allows that one kind from blob: and nothing else; an SVG shown as an image runs no script and loads nothing.
export function mediaDocument(kind, url, name) {
  const source = kind === 'video' ? 'media-src' : 'img-src';
  const policy = `default-src 'none'; ${source} blob:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`;
  const label = escapeHtml(name);
  const element = kind === 'video'
    ? `<video src="${escapeHtml(url)}" controls title="${label}"></video>`
    : `<img src="${escapeHtml(url)}" alt="${label}" title="${label}">`;
  return '<!doctype html><html><head>'
    + `<meta http-equiv="Content-Security-Policy" content="${policy}"><meta charset="utf-8">`
    + '<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas}'
    + 'img,video{max-width:100%;max-height:100vh}'
    + 'img{background:repeating-conic-gradient(#d0d4da 0 25%,#fff 0 50%) 0 0/16px 16px}</style>'
    + `</head><body>${element}</body></html>`;
}

// A JUnit report (see junit.js): the totals, a table of suites, then each suite's cases. Failures and errors are open,
// output is folded. Every value from the XML enters escaped.
export function junitDocument(model) {
  const { totals } = model;
  const seconds = (value) => (value === null || value === undefined ? '' : `${Number(value).toFixed(value < 10 ? 2 : 1)} s`);
  const pill = (status) => `<span class="pill ${status}">${{ passed: 'passed', failed: 'failed', error: 'error', skipped: 'skipped' }[status]}</span>`;
  const card = (label, value, kind = '') => `<div class="card ${kind}"><span>${label}</span><b>${escapeHtml(String(value))}</b></div>`;
  const block = (summary, text, open) => (text ? `<details${open ? ' open' : ''}><summary>${summary}</summary><pre>${escapeHtml(text)}</pre></details>` : '');
  const suiteRows = model.suites.map((suite, index) => `<tr><td><a href="#suite-${index}">${escapeHtml(suite.name)}</a></td>`
    + `<td>${suite.tests}</td><td>${suite.failures}</td><td>${suite.errors}</td><td>${suite.skipped}</td><td>${seconds(suite.time)}</td></tr>`).join('');
  const suiteSections = model.suites.map((suite, index) => {
    const rows = suite.cases.map((item) => {
      const problem = item.status === 'failed' || item.status === 'error';
      const message = item.message ? `<p class="message">${escapeHtml(item.message)}</p>` : '';
      const detail = problem || item.status === 'skipped'
        ? `${message}${block(item.type ? escapeHtml(item.type) : 'Details', item.detail, problem)}` : '';
      return `<tr class="${item.status}"><td><span class="case">${escapeHtml(item.name)}</span>`
        + `${item.classname && item.classname !== item.name ? `<span class="class">${escapeHtml(item.classname)}</span>` : ''}`
        + `${detail}${block('Output', item.systemOut, false)}${block('Errors', item.systemErr, false)}</td>`
        + `<td>${pill(item.status)}</td><td>${seconds(item.time)}</td></tr>`;
    }).join('');
    const cases = suite.cases.length ? `<table><thead><tr><th>Case</th><th>Result</th><th>Time</th></tr></thead><tbody>${rows}</tbody></table>` : '';
    return `<h2 id="suite-${index}">${escapeHtml(suite.name)}</h2><p class="meta">${suite.tests} tests · ${suite.failures} failed · `
      + `${suite.errors} errors · ${suite.skipped} skipped · ${seconds(suite.time)}${suite.timestamp ? ` · ${escapeHtml(suite.timestamp)}` : ''}</p>`
      + `${cases}${block('Suite output', suite.systemOut, false)}${block('Suite errors', suite.systemErr, false)}`;
  }).join('');
  const body = `<h1>${escapeHtml(model.name || 'Test report')}</h1>`
    + `<div class="cards">${card('Tests', totals.tests)}${card('Passed', totals.passed, 'passed')}`
    + `${card('Failed', totals.failures, totals.failures ? 'failed' : '')}${card('Errors', totals.errors, totals.errors ? 'error' : '')}`
    + `${card('Skipped', totals.skipped, totals.skipped ? 'skipped' : '')}${card('Time', seconds(totals.time))}</div>`
    + `<table><thead><tr><th>Suite</th><th>Tests</th><th>Failed</th><th>Errors</th><th>Skipped</th><th>Time</th></tr></thead><tbody>${suiteRows}</tbody></table>`
    + suiteSections;
  return documentShell(body, JUNIT_CSS);
}

const JUNIT_CSS = 'body{padding:24px 32px;font:14px/1.5 system-ui,sans-serif}h1{margin:0 0 12px;font-size:22px}h2{margin:28px 0 4px;font-size:17px}'
  + '.meta{margin:0 0 8px;color:GrayText}.cards{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px;margin:0 0 20px}'
  + '.card{border:1px solid color-mix(in srgb,CanvasText 18%,transparent);border-radius:8px;padding:8px 10px}.card span{display:block;font-size:12px;color:GrayText}'
  + '.card b{font-size:22px}.card.passed b{color:#1f845a}.card.failed b,.card.error b{color:#c9372c}.card.skipped b{color:#a54800}'
  + 'table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:6px 8px;border-bottom:1px solid color-mix(in srgb,CanvasText 14%,transparent)}'
  + 'th{font-size:12px;color:GrayText}a{color:LinkText}.case{display:block;font-weight:600}.class{display:block;font-size:12px;color:GrayText}'
  + '.pill{display:inline-block;padding:0 8px;border-radius:999px;font-size:12px;font-weight:600}.pill.passed{background:#dcfff1;color:#1f845a}'
  + '.pill.failed,.pill.error{background:#ffeceb;color:#c9372c}.pill.skipped{background:#fff7d6;color:#a54800}.message{margin:4px 0;color:#c9372c}'
  + 'details{margin:4px 0}summary{cursor:pointer;font-size:12px;color:GrayText}pre{margin:4px 0;padding:8px;overflow:auto;white-space:pre-wrap;'
  + 'background:color-mix(in srgb,CanvasText 6%,transparent);border-radius:6px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}';

// A Markdown file as a page (see markdown.js), with a style for reading. It then goes through prepareHtml like any
// report: its links and images are rewritten, and the policy is put first.
export function markdownPage(body, title) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${MARKDOWN_CSS}</style></head>`
    + `<body><article class="markdown">${body}</article></body></html>`;
}

const MARKDOWN_CSS = ':root{color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText}'
  + '.markdown{max-width:860px;margin:0 auto;padding:24px 32px;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}'
  + 'h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em}h1{font-size:1.8em;padding-bottom:.3em;border-bottom:1px solid color-mix(in srgb,CanvasText 15%,transparent)}'
  + 'h2{font-size:1.4em}code{padding:.1em .3em;border-radius:4px;background:color-mix(in srgb,CanvasText 8%,transparent);font:.9em ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}'
  + 'pre{padding:12px;overflow:auto;border-radius:6px;background:color-mix(in srgb,CanvasText 6%,transparent)}pre code{padding:0;background:none}'
  + 'table{margin:1em 0;border-collapse:collapse}th,td{padding:6px 10px;border:1px solid color-mix(in srgb,CanvasText 18%,transparent)}'
  + 'th{background:color-mix(in srgb,CanvasText 6%,transparent)}blockquote{margin:1em 0;padding:0 1em;border-left:4px solid color-mix(in srgb,CanvasText 20%,transparent);color:GrayText}'
  + 'img{max-width:100%}a{color:LinkText}hr{border:0;border-top:1px solid color-mix(in srgb,CanvasText 15%,transparent)}'
  + '.markdown>:first-child{margin-top:0}';

export function noteDocument(message) {
  return documentShell(`<p>${escapeHtml(message)}</p>`, 'p{margin:24px;font:14px/1.5 system-ui,sans-serif}');
}

export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function documentShell(body, css) {
  return '<!doctype html><html><head>'
    + `<meta http-equiv="Content-Security-Policy" content="${RENDER_CSP}"><meta charset="utf-8">`
    + `<style>:root{color-scheme:light dark}body{margin:0;background:Canvas;color:CanvasText}${css}</style>`
    + `</head><body>${body}</body></html>`;
}
