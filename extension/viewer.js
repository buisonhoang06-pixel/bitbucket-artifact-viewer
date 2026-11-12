// The viewer. It downloads a build's artifact with the browser's Bitbucket session, or takes a .tar.gz from the
// disk, unpacks it in memory and shows its files. An artifact's HTML is rendered in an iframe that runs no script,
// submits no form, opens no window, cannot navigate itself (frame-src 'none' in the manifest) and loads nothing
// from the network.
import { ArchiveError, DEFAULT_MAX_BYTES, formatBytes, openArchive } from './lib/archive.js';
import {
  artifactsUrl,
  contentUrl,
  httpsHost,
  isTrustedNextUrl,
  looksLikeSignIn,
  normalizeStep,
  pickArtifacts,
  readViewerQuery,
  redirectTarget,
  viewerPath,
} from './lib/bitbucket.js';
import { junitModel, junitSize } from './lib/junit.js';
import { fileKind, fontType } from './lib/kinds.js';
import { markdownToHtml } from './lib/markdown.js';
import { pickEntry, resolveLink } from './lib/links.js';
import { fileTree } from './lib/tree.js';
import {
  ORIGINAL_HREF, formatJson, formatJsonl, junitDocument, markdownPage, mediaDocument, noteDocument, prepareHtml,
  rewriteCss, textDocument,
} from './lib/render.js';

const MAX_LIST_PAGES = 20;
const TEXT_LIMIT = 2 * 1024 * 1024;
// Parsing and rendering a 20 MB page took about 9 s and held up every viewer tab; reports are far smaller.
const HTML_LIMIT = 5 * 1024 * 1024;
// A Bitbucket tab that sends nothing for this long counts as stuck.
const TAB_SILENCE_MS = 60 * 1000;
const XLINK = 'http://www.w3.org/1999/xlink';

const $ = (id) => document.getElementById(id);
const pipeline = readViewerQuery(location.search);
// Embedded: the viewer sits in the Artifact viewer panel on bitbucket.org. Entries a frame adds to the tab's history
// outlive the frame and swallow the page's Back, so the embedded viewer adds none: it replaces its address and keeps
// its own Back stack.
const embedded = new URLSearchParams(location.search).get('embedded') === '1';
// Framed: inside a page, which is the Artifact viewer panel or a frame a page script made. A page can place a frame under
// the user's next click, so a frame never offers the prompt for host access; the viewer's own tab does.
const framed = window.top !== window;
const backStack = [];
// artifact: the uuid of the build's artifact being shown, so that a new tab opens that one and not the chooser.
// raw: the file bar's Raw, for the file shown; another file opens formatted again.
const state = { files: null, current: null, rendered: null, pendingAnchor: null, label: '', artifact: null, raw: false };
// The kinds the file bar can show as they are, with Raw.
const FORMATTED_KINDS = new Set(['json', 'jsonl', 'junit', 'markdown']);
// A JUnit report with more cases, or more suites, than this is shown as its XML.
const MAX_CASES = 20000;
// What one HTML page may take from the archive for its images, stylesheets and fonts.
const PAGE_ASSETS = { count: 500, bytes: 50 * 1024 * 1024, importDepth: 4 };
// Blob URLs of the archive's files: the image or video shown (revoked when another file is shown), and the PDFs
// opened in their own tabs (kept until another archive opens, since those tabs read from them).
const blobs = { media: null, page: [], pdfs: new Map() };
// Every load (a build, an artifact, a local file) takes a new number; a result for an older number is dropped, so a
// slow download cannot replace a file opened meanwhile.
let generation = 0;
// Redirects seen while a download runs: request URL -> target. Only chains that start at a URL this viewer is
// requesting right now are kept, and each is forgotten when its request is done.
const redirects = new Map();
const chainUrls = new Set();
const activeUrls = new Set();
const REDIRECT_FILTER = { urls: ['https://bitbucket.org/*'], types: ['xmlhttprequest'] };
let watching = 0;
// The loader's line under the picture is only for fun; it changes every two seconds while a load lasts.
const BUSY_LINES = ['Sorting the pages…', 'Dusting off the charts…', 'Lining up the tables…', 'Almost there…'];
let busyTimer = 0;

class ViewerError extends Error {
  constructor(title, detail, extra = {}) {
    super(title);
    this.title = title;
    this.detail = detail;
    Object.assign(this, extra);
  }
}

init();

function init() {
  $('open-file').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', () => {
    const file = $('file-input').files?.[0];
    $('file-input').value = '';
    if (file) openLocalFile(file);
  });
  if (embedded) {
    document.body.classList.add('embedded');
    $('open-file').hidden = true;
    $('back').hidden = false;
    $('open-tab').hidden = false;
    $('toggle-files').hidden = false;
    // The panel shows the report alone; Files brings the list when it is needed.
    document.body.classList.add('files-hidden');
    $('toggle-files').setAttribute('aria-pressed', 'false');
    $('back').addEventListener('click', goBack);
    $('open-tab').addEventListener('click', openInNewTab);
    $('toggle-files').addEventListener('click', toggleFiles);
  } else {
    setUpDrop(window);
  }
  $('toggle-raw').addEventListener('click', toggleRaw);
  $('open-pdf').addEventListener('click', openPdf);
  $('download').addEventListener('click', downloadCurrent);
  $('frame').addEventListener('load', onFrameLoad);
  window.addEventListener('hashchange', renderFromHash);
  if (pipeline) {
    loadBuild();
  } else {
    showDropIntro();
  }
}

// --- Downloading from Bitbucket ---------------------------------------------------------------------------------

// A redirect to a host that may not be read makes fetch fail without saying where it went; webRequest sees each
// hop first, whether the Bitbucket tab or this page made the request. The listener is on only while one of this
// viewer's requests runs, and it keeps only the chains that start at such a request.
function onRedirect(details) {
  if (!activeUrls.has(details.url) && !chainUrls.has(details.url)) return;
  redirects.set(details.url, details.redirectUrl);
  chainUrls.add(details.redirectUrl);
}

function watchRedirects(on) {
  const event = chrome.webRequest?.onBeforeRedirect;
  if (!event) return;
  watching += on ? 1 : -1;
  if (on && watching === 1) event.addListener(onRedirect, REDIRECT_FILTER);
  if (!on && watching === 0) event.removeListener(onRedirect);
}

function forgetChain(url) {
  let at = url;
  for (let hop = 0; hop < 10 && redirects.has(at); hop += 1) {
    const next = redirects.get(at);
    redirects.delete(at);
    chainUrls.delete(next);
    at = next;
  }
}

async function loadBuild() {
  const token = ++generation;
  setSource(`${pipeline.workspace}/${pipeline.repo} · build #${pipeline.build}`);
  document.title = `Build #${pipeline.build} · ${pipeline.repo}`;
  showBusy(`Looking for the artifacts of build #${pipeline.build}…`, 'Finding your artifact…');
  let artifacts;
  try {
    artifacts = pickArtifacts(await listArtifacts(), pipeline.step);
  } catch (error) {
    if (token === generation) showFailure(error, loadBuild);
    return;
  }
  if (token !== generation) return;
  if (artifacts.length === 0) {
    showPanel(
      'This build has no artifacts',
      `Bitbucket lists no artifact for build #${pipeline.build}. A step keeps files only when bitbucket-pipelines.yml `
        + 'declares them as artifacts, and Bitbucket deletes them 14 days after the step ran.',
      [openFileAction()],
    );
    return;
  }
  const wanted = pipeline.artifact ? artifacts.find((item) => item.uuid.toLowerCase() === pipeline.artifact.toLowerCase()) : null;
  if (wanted) downloadArtifact(wanted);
  else if (artifacts.length === 1) downloadArtifact(artifacts[0]);
  else showChooser(artifacts);
}

async function listArtifacts() {
  const values = [];
  let url = artifactsUrl(pipeline);
  for (let page = 0; url && page < MAX_LIST_PAGES; page += 1) {
    const reply = await bitbucketGet(url, 'list');
    // An HTML answer is most likely Bitbucket's sign-in page, reached by a same-origin redirect.
    if (reply.contentType.includes('html')) throw signedOutError(reply.viaTab, reply.staleTabs);
    if (!reply.contentType.includes('json')) throw changedError();
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(reply.bytes));
    } catch {
      throw changedError();
    }
    if (!Array.isArray(body?.values)) throw changedError();
    values.push(...body.values);
    url = isTrustedNextUrl(pipeline, body.next) ? new URL(body.next).href : null;
  }
  return values;
}

async function downloadArtifact(artifact) {
  const token = ++generation;
  const name = artifactName(artifact);
  const label = `${pipeline.workspace}/${pipeline.repo} · build #${pipeline.build} · ${name}`;
  setSource(label);
  const size = Number.isFinite(artifact.file_size_bytes) ? ` (${formatBytes(artifact.file_size_bytes)})` : '';
  // The listing gives the size, so an artifact larger than the viewer opens is refused before it is downloaded.
  if (Number.isFinite(artifact.file_size_bytes) && artifact.file_size_bytes > DEFAULT_MAX_BYTES) {
    const error = tooLargeError();
    showPanel(error.title, error.detail, [openFileAction()]);
    return;
  }
  showBusy(`Downloading ${name}${size}…`, 'Fetching your artifact…');
  let reply;
  try {
    const total = Number.isFinite(artifact.file_size_bytes) && artifact.file_size_bytes > 0 ? artifact.file_size_bytes : null;
    reply = await bitbucketGet(contentUrl(pipeline, artifact.uuid), 'content', (received) => {
      if (token === generation && total) showProgress(received / total);
    });
  } catch (error) {
    if (token !== generation) return;
    if (error.storageHost) askForStorage(error.storageHost, artifact);
    else showFailure(error, () => downloadArtifact(artifact));
    return;
  }
  if (token !== generation) return;
  state.artifact = artifact.uuid;
  await showArchive(reply.bytes, name, label, token);
}

// GET from Bitbucket. Returns { status, contentType, bytes, viaTab, staleTabs } for a 2xx answer and throws a
// ViewerError otherwise. An open bitbucket.org tab makes the request when there is one, because only a same-origin
// request carries the session for sure; otherwise this page tries itself.
// onProgress(bytes received so far), as the download goes.
async function bitbucketGet(url, which, onProgress = null) {
  forgetChain(url);
  activeUrls.add(url);
  watchRedirects(true);
  try {
    const accept = which === 'list' ? 'application/json' : null;
    const tabs = await bitbucketTabs();
    let reply = null;
    for (const tabId of tabs) {
      reply = await throughTab(tabId, url, accept, onProgress);
      if (reply) break;
    }
    const viaTab = Boolean(reply);
    const staleTabs = !viaTab && tabs.length > 0;
    if (!reply) reply = await fromThisPage(url, accept, onProgress);
    if (reply.tooLarge) throw tooLargeError();
    if (reply.refused) throw changedError();
    if (reply.stalled) {
      throw new ViewerError('The Bitbucket tab stopped answering', 'Nothing arrived from the Bitbucket tab for a minute. Reload that tab, then retry.');
    }
    if (reply.broken) {
      throw new ViewerError('The download through the Bitbucket tab stopped', 'That tab was closed, reloaded or left during the download. Retry.');
    }
    if (reply.failed) {
      if (!redirects.has(url)) await pause(200);
      const target = redirectTarget(redirects, url);
      if (!target) throw new ViewerError('Bitbucket could not be reached', 'Check your connection, then retry.');
      if (which !== 'content' || looksLikeSignIn(target)) throw signedOutError(viaTab, staleTabs);
      return { ...(await fromStorage(target, onProgress)), viaTab, staleTabs };
    }
    checkStatus(reply, which, viaTab, staleTabs);
    return { ...reply, viaTab, staleTabs };
  } finally {
    activeUrls.delete(url);
    forgetChain(url);
    watchRedirects(false);
  }
}

// The content script in a bitbucket.org tab makes the request and streams the bytes back over a port. It answers
// "accepted" at once, so a port that closes before that means the tab has no live copy of the content script (none
// loaded yet, or an old one after an update), and resolves to null; a port that closes later means the tab was
// closed, reloaded or left.
function throughTab(tabId, url, accept, onProgress) {
  return new Promise((resolve) => {
    let port;
    let accepted = false;
    let head = null;
    let size = 0;
    const chunks = [];
    let settled = false;
    let silence = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(silence);
      try {
        port?.disconnect();
      } catch {
        // already gone
      }
      resolve(value);
    };
    const waitForMore = () => {
      clearTimeout(silence);
      silence = setTimeout(() => finish({ stalled: true }), TAB_SILENCE_MS);
    };
    try {
      port = chrome.tabs.connect(tabId, { name: 'bitbucket-fetch' });
    } catch {
      finish(null);
      return;
    }
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      finish(accepted || head ? { broken: true } : null);
    });
    port.onMessage.addListener((message) => {
      waitForMore();
      if (message?.type === 'accepted') {
        accepted = true;
      } else if (message?.type === 'refused') {
        finish({ refused: true });
      } else if (message?.type === 'head') {
        head = message;
      } else if (message?.type === 'chunk' && head) {
        const bytes = fromBase64(message.data ?? '');
        size += bytes.length;
        if (size > DEFAULT_MAX_BYTES) finish({ tooLarge: true });
        else {
          chunks.push(bytes);
          onProgress?.(size);
        }
      } else if (message?.type === 'end' && head) {
        finish({ status: head.status, contentType: head.contentType ?? '', bytes: joinBytes(chunks, size) });
      } else if (message?.type === 'failed') {
        finish({ failed: true });
      } else if (message?.type === 'broken') {
        finish({ broken: true });
      }
    });
    waitForMore();
    port.postMessage({ url, accept });
  });
}

// The bitbucket.org tab this viewer sits in (embedded) first, then the one it was opened from, then any other
// bitbucket.org tab.
async function bitbucketTabs() {
  const ids = [];
  let incognito = chrome.extension?.inIncognitoContext ?? false;
  // An incognito tab may carry another account; the viewer never reads through one into a normal window, or back.
  const onBitbucket = (tab) => typeof tab?.url === 'string' && tab.url.startsWith('https://bitbucket.org/')
    && Boolean(tab.incognito) === incognito;
  try {
    const self = await chrome.tabs.getCurrent();
    if (self) incognito = Boolean(self.incognito);
    if (onBitbucket(self)) ids.push(self.id);
    const opener = Number.isInteger(self?.openerTabId) ? await chrome.tabs.get(self.openerTabId) : null;
    if (onBitbucket(opener) && !ids.includes(opener.id)) ids.push(opener.id);
  } catch {
    // not in a tab, or the opener is gone
  }
  try {
    for (const tab of await chrome.tabs.query({ url: 'https://bitbucket.org/*' })) {
      if (onBitbucket(tab) && !ids.includes(tab.id)) ids.push(tab.id);
    }
  } catch {
    // no tab can be listed
  }
  return ids;
}

async function fromThisPage(url, accept, onProgress) {
  try {
    const response = await fetch(url, { credentials: 'include', cache: 'no-store', headers: accept ? { Accept: accept } : {} });
    const bytes = await readCapped(response, onProgress);
    if (!bytes) return { tooLarge: true };
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', bytes };
  } catch {
    return { failed: true };
  }
}

// The signed storage address carries its own authorization, so no cookie goes with it. Reading it needs host
// access, which is checked first: without it the viewer asks ("Allow and retry") instead of trying.
async function fromStorage(target, onProgress) {
  const host = httpsHost(target);
  if (!host) {
    throw new ViewerError(
      'Bitbucket sent the download to an address that is not https',
      'The viewer reads only https addresses. Download the artifact from Bitbucket and open it here with "Open a .tar.gz…".',
    );
  }
  const origin = `https://${host}`;
  let allowed = false;
  try {
    allowed = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch {
    allowed = false;
  }
  if (!allowed) throw new ViewerError('', '', { storageHost: host });
  let response;
  try {
    response = await fetch(target, { credentials: 'omit', cache: 'no-store' });
  } catch {
    throw new ViewerError(`${origin} could not be reached`, 'Bitbucket keeps the artifact there, but the connection failed. Check your connection, then retry.');
  }
  if (response.status === 401 || response.status === 403) {
    throw new ViewerError(
      'The storage host refused the download',
      `${origin} refused Bitbucket's signed address for this file. It may have expired; retrying asks Bitbucket for a new one.`,
    );
  }
  if (response.status === 404 || response.status === 410) throw expiredError();
  if (!response.ok) throw new ViewerError(`${origin} answered with HTTP ${response.status}`, 'Retry in a moment.');
  const bytes = await readCapped(response, onProgress);
  if (!bytes) throw tooLargeError();
  return { status: response.status, contentType: response.headers.get('content-type') ?? '', bytes };
}

// A response body, or null as soon as it passes the size limit: it is never read whole first.
async function readCapped(response, onProgress = null) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > DEFAULT_MAX_BYTES) {
    response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > DEFAULT_MAX_BYTES) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
    onProgress?.(size);
  }
  return joinBytes(chunks, size);
}

function checkStatus(reply, which, viaTab, staleTabs) {
  if (reply.status >= 200 && reply.status < 300) return;
  if (reply.status === 401 || reply.status === 403) throw signedOutError(viaTab, staleTabs);
  if (reply.status === 404 || reply.status === 410) {
    if (which === 'content') throw expiredError();
    throw new ViewerError(
      `Build #${pipeline.build} was not found`,
      `Bitbucket did not find build #${pipeline.build} of ${pipeline.workspace}/${pipeline.repo}. Check that you can `
        + 'open it on bitbucket.org in this Chrome profile.',
    );
  }
  throw new ViewerError(`Bitbucket answered with HTTP ${reply.status}`, 'Retry in a moment.');
}

function askForStorage(host, artifact) {
  const origin = `https://${host}`;
  if (framed) {
    showPanel(
      `Bitbucket keeps this file on ${origin}`,
      `The extension reads files only from hosts you allow. Open the viewer in its own tab and allow ${origin} there; `
        + 'Chrome then keeps that access for the extension, and the report opens here too.',
      [{ label: 'Open in new tab', primary: true, onClick: openInNewTab }],
    );
    return;
  }
  showPanel(
    `Bitbucket keeps this file on ${origin}`,
    `The extension reads files only from hosts you allow. Allow it to read from ${origin}; once allowed, Chrome keeps `
      + 'that access for the extension. The download then starts again.',
    [{ label: 'Allow and retry', primary: true, onClick: () => requestStorage(origin, artifact) }, openFileAction()],
  );
}

async function requestStorage(origin, artifact) {
  let granted = false;
  try {
    // Must run straight from the click: Chrome accepts a permission request only during a user gesture.
    granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  } catch (error) {
    showPanel('Chrome did not ask for access', String(error?.message ?? error), [openFileAction()]);
    return;
  }
  if (granted) {
    await downloadArtifact(artifact);
    return;
  }
  showPanel(
    `Access to ${origin} was not allowed`,
    'Without it the artifact cannot be downloaded here. Allow it, or download the artifact from Bitbucket and open it '
      + 'with "Open a .tar.gz…".',
    [{ label: 'Allow and retry', primary: true, onClick: () => requestStorage(origin, artifact) }, openFileAction()],
  );
}

// viaTab: an open bitbucket.org tab made the request. staleTabs: bitbucket.org tabs are open, but none has a live
// copy of the content script, which happens in tabs opened before the extension was installed or updated.
function signedOutError(viaTab, staleTabs) {
  if (viaTab) {
    return new ViewerError(
      'Bitbucket did not accept your session',
      'Sign in to bitbucket.org in this Chrome profile, then retry.\n'
        + 'You can also download the artifact from Bitbucket and open it here with "Open a .tar.gz…".',
    );
  }
  if (staleTabs) {
    return new ViewerError(
      'Reload the Bitbucket tab',
      'A bitbucket.org tab is open, but it was opened before the extension was installed or updated, so the extension '
        + 'cannot use it yet. Reload that tab, then retry.',
    );
  }
  return new ViewerError(
    'Open this build from its Bitbucket page',
    'The viewer reads artifacts through an open bitbucket.org tab, because Chrome does not send your Bitbucket '
      + 'session with the extension\'s own requests.\n'
      + 'Open the pipeline step on bitbucket.org in this Chrome profile, keep that tab open, then retry or click '
      + '"Artifact viewer" next to its Artifacts tab. You can also download the artifact from Bitbucket and open it here '
      + 'with "Open a .tar.gz…".',
  );
}

function changedError() {
  return new ViewerError(
    'Bitbucket answered in an unexpected way',
    'Bitbucket may have changed how it serves artifacts. Download the artifact from Bitbucket and open it here with '
      + '"Open a .tar.gz…", and tell whoever maintains this extension.',
  );
}

function expiredError() {
  return new ViewerError(
    'The artifact is no longer available',
    'Bitbucket deletes artifacts 14 days after the step that made them. Run the pipeline again to get a new one.',
  );
}

function tooLargeError() {
  return new ViewerError(
    'The artifact is too large to open here',
    `The viewer opens artifacts up to ${formatBytes(DEFAULT_MAX_BYTES)}. Download it from Bitbucket and unpack it instead.`,
  );
}

function showChooser(artifacts) {
  showPanel(`Build #${pipeline.build} has ${artifacts.length} artifacts`, 'Choose the one to open.');
  $('chooser').replaceChildren(...artifacts.map((artifact) => {
    const button = document.createElement('button');
    button.type = 'button';
    const name = document.createElement('span');
    name.textContent = artifactName(artifact);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = artifactMeta(artifact);
    button.append(name, meta);
    button.addEventListener('click', () => downloadArtifact(artifact));
    const item = document.createElement('li');
    item.append(button);
    return item;
  }));
  $('chooser').hidden = false;
}

function artifactName(artifact) {
  return artifact.name || artifact.path || 'artifact';
}

function artifactMeta(artifact) {
  const parts = [];
  const step = normalizeStep(artifact.step_uuid);
  if (step) parts.push(`step ${step.slice(1, 9)}`);
  if (Number.isFinite(artifact.file_size_bytes)) parts.push(formatBytes(artifact.file_size_bytes));
  const created = Date.parse(artifact.created_on ?? '');
  if (!Number.isNaN(created)) parts.push(new Date(created).toLocaleString());
  return parts.join(' · ');
}

// --- Opening an archive -----------------------------------------------------------------------------------------

async function openLocalFile(file) {
  const token = ++generation;
  setSource(file.name);
  document.title = `${file.name} · Artifact Viewer for Bitbucket Pipelines`;
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (error) {
    if (token === generation) showPanel(`${file.name} could not be read`, String(error?.message ?? error), [openFileAction()]);
    return;
  }
  if (token !== generation) return;
  await showArchive(bytes, file.name, file.name, token);
}

async function showArchive(bytes, name, label, token) {
  revokeAll();
  state.files = null;
  state.current = null;
  state.rendered = null;
  showBusy(`Unpacking ${name}…`, 'Unpacking the files…');
  let files;
  try {
    files = await openArchive(bytes);
  } catch (error) {
    if (token !== generation) return;
    const detail = error instanceof ArchiveError ? error.message : String(error?.message ?? error);
    showPanel(`${name} could not be opened`, detail, [openFileAction()]);
    return;
  }
  if (token !== generation) return;
  if (files.size === 0) {
    showPanel(`${name} is empty`, 'The archive holds no files.', [openFileAction()]);
    return;
  }
  state.files = files;
  state.label = label;
  setSource(label);
  backStack.length = 0;
  updateBack();
  buildFileList();
  showWorkspace();
  const wanted = hashTarget();
  if (wanted && files.has(wanted.path)) renderFromHash();
  else navigate(pickEntry(files.keys()) ?? [...files.keys()].sort()[0], null, { replace: true });
}

// --- Showing files ----------------------------------------------------------------------------------------------

// The files as a folder tree (see tree.js). Every folder starts open, and each one closes and opens with a click.
function buildFileList() {
  const paths = [...state.files.keys()];
  const heading = document.createElement('p');
  heading.className = 'files-heading';
  heading.textContent = `${paths.length} file${paths.length === 1 ? '' : 's'}`;
  $('toggle-files').textContent = `Files (${paths.length})`;
  $('files').replaceChildren(heading, treeList(fileTree(paths)));
}

// One level of the tree. depth sets each row's indent and guides (see .files summary in viewer.css).
function treeList(node, depth = 0) {
  const list = document.createElement('ul');
  for (const folder of node.folders) {
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary');
    summary.style.setProperty('--depth', depth);
    summary.title = folder.path;
    summary.append(nameOf(folder.name));
    details.append(summary, treeList(folder, depth + 1));
    const item = document.createElement('li');
    item.append(details);
    list.append(item);
  }
  for (const file of node.files) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.path = file.path;
    button.dataset.icon = file.icon;
    button.style.setProperty('--depth', depth);
    button.append(nameOf(file.name));
    button.title = `${file.path} (${formatBytes(state.files.get(file.path).length)})`;
    button.addEventListener('click', () => navigate(file.path, null));
    const item = document.createElement('li');
    item.append(button);
    list.append(item);
  }
  return list;
}

// A row's name, as text on one line: one too long for the row ends in an ellipsis (see .name in viewer.css), and the
// row's tooltip has the full path.
function nameOf(text) {
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = text;
  return name;
}

// Each file has its own address (#file=...&anchor=...), so Back and Forward move between the files opened. Embedded,
// the address is replaced and the previous one goes onto the viewer's own Back stack.
function navigate(path, anchor, { replace = false } = {}) {
  const hash = hashFor(path, anchor);
  if (embedded) {
    if (!replace && location.hash && location.hash !== hash) backStack.push(location.hash);
    history.replaceState(null, '', hash);
    updateBack();
    renderFromHash();
  } else if (replace) {
    history.replaceState(null, '', hash);
    renderFromHash();
  } else if (location.hash === hash) {
    renderFromHash();
  } else {
    location.hash = hash;
  }
}

function hashFor(path, anchor) {
  const params = new URLSearchParams({ file: path });
  if (anchor) params.set('anchor', anchor);
  return `#${params}`;
}

function goBack() {
  const previous = backStack.pop();
  if (!previous) return;
  history.replaceState(null, '', previous);
  updateBack();
  renderFromHash();
}

function updateBack() {
  $('back').disabled = backStack.length === 0;
}

// The full viewer in its own tab, at the file shown here. Its opener is this Bitbucket tab, which it fetches through.
async function openInNewTab() {
  let self = null;
  try {
    self = await chrome.tabs.getCurrent();
  } catch {
    // not in a tab
  }
  chrome.tabs
    .create({ url: fullViewerUrl(location.hash), ...(self ? { index: self.index + 1, openerTabId: self.id } : {}) })
    .catch((error) => showNotice(`The viewer could not open a new tab: ${error?.message ?? error}`));
}

function hashTarget() {
  const params = new URLSearchParams(location.hash.slice(1));
  const path = params.get('file');
  return path ? { path, anchor: params.get('anchor') } : null;
}

function renderFromHash() {
  const target = hashTarget();
  if (state.files && target && state.files.has(target.path)) render(target.path, target.anchor);
}

function render(path, anchor) {
  hideNotice();
  markCurrent(path);
  if (path !== state.current) state.raw = false;
  const bytes = state.files.get(path);
  const { kind, type } = fileKind(path, bytes);
  updateFileBar(path, bytes, kind);
  if (path === state.rendered) {
    scrollToAnchor(anchor ?? '');
    return;
  }
  state.current = path;
  state.rendered = null;
  state.pendingAnchor = anchor;
  try {
    revokeMedia();
    state.assetsCut = false;
    $('frame').srcdoc = documentFor(path, bytes, kind, type);
    if (state.assetsCut) {
      showNotice(`Some of this page's images, stylesheets or fonts were not loaded: a page may take ${PAGE_ASSETS.count} files `
        + `or ${formatBytes(PAGE_ASSETS.bytes)} from the artifact.`);
    }
  } catch (error) {
    $('frame').srcdoc = noteDocument(`${basename(path)} could not be shown.`);
    showNotice(`${path} could not be shown: ${error?.message ?? error}`);
  }
  document.title = `${basename(path)} · ${state.label}`;
}

// Large files are cut, so that one file cannot freeze or crash the tab.
function documentFor(path, bytes, kind, type) {
  if (kind === 'html') {
    if (bytes.length > HTML_LIMIT) return noteDocument(`${basename(path)} is ${formatBytes(bytes.length)}, too large to show here.`);
    return prepareHtml(new TextDecoder().decode(bytes), (href) => linkAddress(path, href), reportAssets(path));
  }
  if (kind === 'markdown' && !state.raw && bytes.length <= TEXT_LIMIT) {
    const page = markdownPage(markdownToHtml(new TextDecoder().decode(bytes)), basename(path));
    return prepareHtml(page, (href) => linkAddress(path, href), reportAssets(path));
  }
  if (kind === 'junit' && !state.raw) {
    const report = junitReport(bytes);
    if (report.document) return report.document;
    return textDocument(new TextDecoder().decode(bytes.subarray(0, TEXT_LIMIT)), report.note);
  }
  if ((kind === 'json' || kind === 'jsonl') && !state.raw && bytes.length <= TEXT_LIMIT) {
    const text = new TextDecoder().decode(bytes);
    const formatted = kind === 'json' ? formatJson(text, TEXT_LIMIT) : formatJsonl(text, TEXT_LIMIT);
    if (formatted === null) return textDocument(text, 'This is not valid JSON, so it is shown as it is.');
    if (formatted.length <= TEXT_LIMIT) return textDocument(formatted);
    return textDocument(formatted.slice(0, TEXT_LIMIT), `Showing the first ${formatBytes(TEXT_LIMIT)} of the formatted file.`);
  }
  if (['text', 'json', 'jsonl', 'junit', 'markdown'].includes(kind)) return plainText(bytes);
  if (kind === 'image' || kind === 'video') {
    blobs.media = URL.createObjectURL(new Blob([bytes], { type }));
    return mediaDocument(kind, blobs.media, basename(path));
  }
  if (kind === 'pdf') {
    return noteDocument(`${basename(path)} is a PDF (${formatBytes(bytes.length)}). Open PDF shows it in Chrome's PDF viewer, in a new tab.`);
  }
  return noteDocument(`${basename(path)} cannot be shown here (${formatBytes(bytes.length)}). Download saves it.`);
}

// A JUnit file as a report, or the reason it is shown as its XML instead. XML mode parses without running or loading
// anything. Only a file whose prolog holds no DOCTYPE gets here (see JUNIT_ROOT in kinds.js), and a document that has
// one anyway is refused.
function junitReport(bytes) {
  if (bytes.length > HTML_LIMIT) {
    return { note: `This test report is ${formatBytes(bytes.length)}, too large to show as a report; here is its XML.` };
  }
  const doc = new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.doctype) {
    return { note: 'This XML could not be read as a test report; here is its text.' };
  }
  const size = junitSize(doc);
  if (size.cases > MAX_CASES || size.suites > MAX_CASES) {
    return { note: `This test report has more than ${MAX_CASES.toLocaleString('en-US')} cases or suites, too many to show as a report; here is its XML.` };
  }
  return { document: junitDocument(junitModel(doc)) };
}

function plainText(bytes) {
  if (bytes.length <= TEXT_LIMIT) return textDocument(new TextDecoder().decode(bytes));
  return textDocument(
    new TextDecoder().decode(bytes.subarray(0, TEXT_LIMIT)),
    `Showing the first ${formatBytes(TEXT_LIMIT)} of ${formatBytes(bytes.length)}.`,
  );
}

// The bar above the file: its path and size, Raw where the viewer formats the file, and Download for every file.
function updateFileBar(path, bytes, kind) {
  $('file-name').textContent = path;
  $('file-name').title = path;
  $('file-size').textContent = formatBytes(bytes.length);
  $('toggle-raw').hidden = !FORMATTED_KINDS.has(kind);
  $('toggle-raw').setAttribute('aria-pressed', String(state.raw));
  $('open-pdf').hidden = kind !== 'pdf';
}

function revokeMedia() {
  if (blobs.media) URL.revokeObjectURL(blobs.media);
  blobs.media = null;
  for (const url of blobs.page) URL.revokeObjectURL(url);
  blobs.page = [];
}

// The images, stylesheets and fonts an HTML page of the artifact names, from the artifact itself (see prepareHtml).
// An address is resolved like a link, against the file that names it. A file is served only as what its bytes are:
// an image, or a font for a stylesheet's url(). Beyond the page's allowance the rest is left out, and the viewer says
// so. An image or a font gets one blob for the page however often it is used, and is charged once; a stylesheet is
// charged at each use, since each use puts its text into the page again.
function reportAssets(htmlPath) {
  const urls = new Map();
  const used = { count: 0, bytes: 0 };
  const take = (bytes) => {
    if (used.count + 1 > PAGE_ASSETS.count || used.bytes + bytes.length > PAGE_ASSETS.bytes) {
      state.assetsCut = true;
      return false;
    }
    used.count += 1;
    used.bytes += bytes.length;
    return true;
  };
  const archivePath = (fromPath, address) => {
    const result = resolveLink(fromPath, address, state.files);
    return result.kind === 'file' ? result.path : null;
  };
  const blobFor = (path, { fonts }) => {
    const key = `${fonts ? 'font' : 'image'} ${path}`;
    if (urls.has(key)) return urls.get(key);
    const bytes = state.files.get(path);
    const kind = fileKind(path, bytes);
    const type = kind.kind === 'image' ? kind.type : fonts ? fontType(bytes) : null;
    let url = null;
    if (type && take(bytes)) {
      url = URL.createObjectURL(new Blob([bytes], { type }));
      blobs.page.push(url);
    }
    urls.set(key, url);
    return url;
  };
  const css = (text, fromPath, depth) => rewriteCss(text, {
    resolve: (address) => {
      const path = archivePath(fromPath, address);
      return path ? blobFor(path, { fonts: true }) : null;
    },
    load: (address) => {
      const path = depth < PAGE_ASSETS.importDepth ? archivePath(fromPath, address) : null;
      if (!path || !take(state.files.get(path))) return null;
      return css(new TextDecoder().decode(state.files.get(path)), path, depth + 1);
    },
  });
  return {
    image: (address) => {
      const path = archivePath(htmlPath, address);
      return path ? blobFor(path, { fonts: false }) : null;
    },
    stylesheet: (address) => {
      const path = archivePath(htmlPath, address);
      if (!path || !take(state.files.get(path))) return null;
      return css(new TextDecoder().decode(state.files.get(path)), path, 0);
    },
    css: (text) => css(text, htmlPath, 0),
  };
}

function revokeAll() {
  revokeMedia();
  for (const url of blobs.pdfs.values()) URL.revokeObjectURL(url);
  blobs.pdfs.clear();
}

// A PDF goes to Chrome's PDF viewer in a tab of its own, next to this one. Only a file whose bytes start like a PDF
// gets here, and its blob says application/pdf, so the tab can show nothing else.
async function openPdf() {
  const path = state.current;
  const bytes = path && state.files?.get(path);
  if (!bytes || fileKind(path, bytes).kind !== 'pdf') return;
  let url = blobs.pdfs.get(path);
  if (!url) {
    url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    blobs.pdfs.set(path, url);
  }
  let self = null;
  try {
    self = await chrome.tabs.getCurrent();
  } catch {
    // not in a tab
  }
  chrome.tabs
    .create({ url, ...(self ? { index: self.index + 1, openerTabId: self.id } : {}) })
    .catch((error) => showNotice(`The PDF could not be opened in a new tab: ${error?.message ?? error}`));
}

function toggleRaw() {
  if (!state.current) return;
  state.raw = !state.raw;
  state.rendered = null;
  render(state.current, null);
}

// Saves the file shown, under its own name. The blob's type says only "bytes", so nothing opens it as a page.
function downloadCurrent() {
  const bytes = state.current && state.files?.get(state.current);
  if (!bytes) return;
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = basename(state.current);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

// The full viewer, never the embedded one, at `hash`.
function fullViewerUrl(hash) {
  const target = pipeline && state.artifact ? { ...pipeline, artifact: state.artifact } : pipeline;
  return chrome.runtime.getURL(viewerPath(target)) + hash;
}

// The address a link of the file at `fromPath` carries, so that opening it in a new tab shows what it points to:
// the full viewer at that file, or the website itself. A missing or blocked link carries the file it is in.
function linkAddress(fromPath, href) {
  const result = resolveLink(fromPath, href, state.files);
  if (result.kind === 'external') return result.url;
  if (result.kind === 'file') return fullViewerUrl(hashFor(result.path, result.anchor));
  if (result.kind === 'anchor') return fullViewerUrl(hashFor(fromPath, result.anchor || null));
  return fullViewerUrl(hashFor(fromPath, null));
}

// The report's own names can shadow its document's methods (<img name="addEventListener">) and a form's properties
// (<input name="parentElement">), so the viewer calls its own copies of the methods it uses on the report.
function listen(target, type, listener, capture) {
  EventTarget.prototype.addEventListener.call(target, type, listener, capture);
}

function onFrameLoad() {
  const doc = $('frame').contentDocument;
  if (!doc) return;
  listen(doc, 'click', onFrameClick, true);
  if (!embedded) setUpDrop(doc);
  state.rendered = state.current;
  if (state.pendingAnchor) scrollToAnchor(state.pendingAnchor);
  state.pendingAnchor = null;
}

// Links inside the artifact are followed by the viewer, never by the frame. composedPath() finds links inside
// shadow roots too, and image-map areas and SVG links count as links.
function onFrameClick(event) {
  const link = linkOf(event);
  if (!link) return;
  event.preventDefault();
  const result = resolveLink(state.current, link, state.files);
  if (result.kind === 'file') navigate(result.path, result.anchor);
  else if (result.kind === 'anchor') scrollToAnchor(result.anchor);
  else if (result.kind === 'external') window.open(result.url, '_blank', 'noopener,noreferrer');
  else if (result.kind === 'blocked') showNotice(`This link was blocked: ${shorten(result.url)}`);
  else showNotice(`Not in this artifact: ${result.path}`);
}

function linkOf(event) {
  for (const node of event.composedPath()) {
    if (node?.nodeType !== 1 || (node.localName !== 'a' && node.localName !== 'area')) continue;
    const href = node.getAttribute(ORIGINAL_HREF) ?? node.getAttribute('href') ?? node.getAttributeNS(XLINK, 'href');
    if (href !== null) return href;
  }
  return null;
}

// Opens any closed <details> around the target, since the tool's report folds its sections.
function scrollToAnchor(anchor) {
  const doc = $('frame').contentDocument;
  if (!doc) return;
  const target = anchor
    ? Document.prototype.getElementById.call(doc, anchor) ?? Document.prototype.getElementsByName.call(doc, anchor)[0]
    : null;
  if (!target) {
    if (!anchor || anchor.toLowerCase() === 'top') $('frame').contentWindow?.scrollTo(0, 0);
    return;
  }
  for (const details of Document.prototype.querySelectorAll.call(doc, 'details')) {
    if (Node.prototype.contains.call(details, target)) details.open = true;
  }
  Element.prototype.scrollIntoView.call(target, { block: 'start' });
}

function markCurrent(path) {
  for (const button of $('files').querySelectorAll('button[data-path]')) {
    const current = button.dataset.path === path;
    button.classList.toggle('current', current);
    if (current) {
      // A folder closed by hand opens again when one of its files is shown, from a link or Back.
      for (let folder = button.closest('details'); folder; folder = folder.parentElement.closest('details')) folder.open = true;
      button.setAttribute('aria-current', 'page');
      button.scrollIntoView({ block: 'nearest' });
    } else {
      button.removeAttribute('aria-current');
    }
  }
}

// --- Panels, notices and drop -----------------------------------------------------------------------------------

function showDropIntro() {
  setSource('');
  showPanel(
    'Open a downloaded artifact',
    'Drop a .tar.gz anywhere on this page, or choose one with "Open a .tar.gz…". Nothing is uploaded: the file is '
      + 'unpacked in this tab.\nTo open a pipeline\'s artifact without downloading it, click "Artifact viewer" next to the '
      + 'Artifacts tab of a pipeline step on bitbucket.org.',
    [openFileAction()],
  );
}

function showPanel(title, detail = '', actions = []) {
  stopBusy();
  $('workspace').hidden = true;
  $('panel').hidden = false;
  $('panel-title').textContent = title;
  $('panel-detail').textContent = detail;
  $('panel-detail').hidden = !detail;
  $('chooser').hidden = true;
  $('panel-actions').replaceChildren(...actions.map(({ label, primary, onClick }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    if (primary) button.className = 'primary';
    button.addEventListener('click', onClick);
    return button;
  }));
}

function showFailure(error, retry) {
  const title = error instanceof ViewerError ? error.title : 'Something went wrong';
  const detail = error instanceof ViewerError ? error.detail : String(error?.message ?? error);
  showPanel(title, detail, [{ label: 'Retry', primary: true, onClick: retry }, openFileAction()]);
}

// A load in progress: the panel with the loader. The title says what happens.
function showBusy(title, line) {
  showPanel(title);
  $('panel').classList.add('busy');
  $('loader').hidden = false;
  $('loader-bar').classList.remove('known');
  $('loader-bar').style.removeProperty('--done');
  $('loader-line').hidden = false;
  $('loader-line').textContent = line;
  let next = 0;
  busyTimer = setInterval(() => {
    $('loader-line').textContent = BUSY_LINES[next % BUSY_LINES.length];
    next += 1;
  }, 2000);
}

// The bar fills to `fraction` (0 to 1) once the size is known; until then it runs back and forth.
function showProgress(fraction) {
  const bar = $('loader-bar');
  bar.classList.add('known');
  bar.style.setProperty('--done', `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`);
}

function stopBusy() {
  clearInterval(busyTimer);
  busyTimer = 0;
  $('panel').classList.remove('busy');
  $('loader').hidden = true;
  $('loader-line').hidden = true;
}

function showWorkspace() {
  stopBusy();
  $('panel').hidden = true;
  $('workspace').hidden = false;
}

// Embedded only: the report can take the panel's whole width.
function toggleFiles() {
  const hidden = document.body.classList.toggle('files-hidden');
  $('toggle-files').setAttribute('aria-pressed', String(!hidden));
}

function openFileAction() {
  if (framed) return { label: 'Open in new tab', onClick: openInNewTab };
  return { label: 'Open a .tar.gz…', onClick: () => $('file-input').click() };
}

function showNotice(text) {
  $('notice').textContent = text;
  $('notice').hidden = false;
}

function hideNotice() {
  $('notice').hidden = true;
}

function setSource(text) {
  $('source').textContent = text;
}

// Files dragged over the page or over the frame show the overlay; the drop itself lands on the overlay.
function setUpDrop(target) {
  listen(target, 'dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    $('drop-overlay').hidden = false;
  }, false);
  if (target !== window) return;
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    $('drop-overlay').hidden = true;
    const file = event.dataTransfer.files[0];
    if (file) openLocalFile(file);
  });
  $('drop-overlay').addEventListener('dragleave', (event) => {
    if (event.target === $('drop-overlay')) $('drop-overlay').hidden = true;
  });
}

function hasFiles(event) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function joinBytes(chunks, size) {
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function basename(path) {
  return path.split('/').pop();
}

function shorten(text) {
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

function pause(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
