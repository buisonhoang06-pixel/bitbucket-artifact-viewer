// Bitbucket pipeline pages and the internal endpoints that the Bitbucket web app uses for artifacts:
//   GET https://bitbucket.org/!api/internal/repositories/{workspace}/{repo}/pipelines/{build}/artifacts
//   GET https://bitbucket.org/!api/internal/repositories/{workspace}/{repo}/pipelines/{build}/artifacts/{uuid}/content
// They are not part of Bitbucket's public API and authenticate with the browser's Bitbucket session.

export const BITBUCKET_ORIGIN = 'https://bitbucket.org';
export const INTERNAL_API_PREFIX = `${BITBUCKET_ORIGIN}/!api/internal/`;

// A workspace or repository slug. Names made only of dots are refused: in a URL, "." and ".." would change the route.
const NAME = /^(?!\.+$)[A-Za-z0-9._-]+$/;
const BUILD = /^[1-9][0-9]{0,9}$/;
const UUID = /^\{?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\}?$/;

// Returns { workspace, repo, build, step } for https://bitbucket.org/<workspace>/<repo>/pipelines/results/<n>, with
// an optional /steps/<uuid> and any trailing segments, or null for any other URL. A step that is not a UUID is
// ignored (step: null) so that the build still opens.
export function parsePipelineUrl(href) {
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.host !== 'bitbucket.org') return null;
  const match = /^\/([^/]+)\/([^/]+)\/pipelines\/results\/([^/]+)(?:\/steps\/([^/]+))?(?:\/.*)?$/.exec(url.pathname);
  if (!match) return null;
  const workspace = decode(match[1]);
  const repo = decode(match[2]);
  if (!validNames(workspace, repo, match[3])) return null;
  return { workspace, repo, build: Number(match[3]), step: normalizeStep(decode(match[4] ?? '')) };
}

// The viewer's address for a build, or for drop mode when `pipeline` is null. `embedded` is for the viewer inside the
// Bitbucket page, which keeps out of the page's history.
export function viewerPath(pipeline, { embedded = false } = {}) {
  if (!pipeline) return 'viewer.html';
  const query = new URLSearchParams({
    workspace: pipeline.workspace,
    repo: pipeline.repo,
    build: String(pipeline.build),
  });
  if (pipeline.step) query.set('step', pipeline.step);
  // The artifact the viewer was showing, so that a new tab opens it rather than the chooser.
  if (pipeline.artifact) query.set('artifact', pipeline.artifact);
  if (embedded) query.set('embedded', '1');
  return `viewer.html?${query}`;
}

// The inverse of viewerPath. Null means drop mode: no build in the query, or a value that fails the checks.
export function readViewerQuery(search) {
  const query = new URLSearchParams(search);
  const workspace = query.get('workspace');
  const repo = query.get('repo');
  const build = query.get('build');
  if (workspace === null && repo === null && build === null) return null;
  if (!validNames(workspace ?? '', repo ?? '', build ?? '')) return null;
  const rawStep = query.get('step');
  const step = rawStep === null || rawStep === '' ? null : normalizeStep(rawStep);
  if (rawStep && step === null) return null;
  const rawArtifact = query.get('artifact');
  const artifact = rawArtifact === null || rawArtifact === '' ? null : bracedUuid(rawArtifact);
  if (rawArtifact && artifact === null) return null;
  return { workspace, repo, build: Number(build), step, ...(artifact ? { artifact } : {}) };
}

export function artifactsUrl(pipeline) {
  const workspace = encodeURIComponent(pipeline.workspace);
  const repo = encodeURIComponent(pipeline.repo);
  return `${BITBUCKET_ORIGIN}/!api/internal/repositories/${workspace}/${repo}/pipelines/${pipeline.build}/artifacts`;
}

export function contentUrl(pipeline, uuid) {
  return `${artifactsUrl(pipeline)}/${encodeURIComponent(uuid)}/content`;
}

// A page link from the list is followed only when it stays on this build's artifacts route.
export function isTrustedNextUrl(pipeline, next) {
  if (typeof next !== 'string' || next === '') return false;
  try {
    const url = new URL(next);
    const expected = new URL(artifactsUrl(pipeline));
    return url.origin === expected.origin && url.pathname === expected.pathname && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

// Artifacts whose uuid is a UUID (it becomes part of a URL), with the uuid in its "{...}" form; when a step is given
// and some artifacts belong to it, only those.
export function pickArtifacts(values, step) {
  const list = (Array.isArray(values) ? values : [])
    .filter((item) => item && typeof item.uuid === 'string' && bracedUuid(item.uuid))
    .map((item) => ({ ...item, uuid: bracedUuid(item.uuid) }));
  if (!step) return list;
  const ofStep = list.filter((item) => normalizeStep(String(item.step_uuid ?? '')) === step);
  return ofStep.length ? ofStep : list;
}

// The service worker's decision for an "open-viewer" or "embedded-viewer" message: the pipeline to show, or null.
// Only this extension's content script in a tab's top frame is answered, and the address comes from Chrome's view of
// the tab (tab.url follows single-page navigation, sender.url does not), never from the message.
export const VIEWER_MESSAGES = new Set(['open-viewer', 'embedded-viewer']);

export function pipelineForViewer(message, sender, extensionId) {
  if (!VIEWER_MESSAGES.has(message?.type) || !sender || sender.id !== extensionId || sender.frameId !== 0 || !sender.tab) return null;
  return parsePipelineUrl(sender.tab.url);
}

// Follows recorded redirects (request URL -> target) from `start` while they stay on bitbucket.org, and returns the
// first address elsewhere, or null when the chain does not leave bitbucket.org.
export function redirectTarget(redirects, start, maxHops = 10) {
  let url = start;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const next = redirects.get(url);
    if (!next) return null;
    let host;
    try {
      host = new URL(next).host;
    } catch {
      return null;
    }
    if (host !== 'bitbucket.org') return next;
    url = next;
  }
  return null;
}

export function looksLikeSignIn(url) {
  try {
    const target = new URL(url);
    return target.hostname === 'id.atlassian.com' || /\/(login|signin|account\/signin)\b/i.test(target.pathname);
  } catch {
    return false;
  }
}

// The host of an https address, or null.
export function httpsHost(url) {
  try {
    const target = new URL(url);
    return target.protocol === 'https:' ? target.hostname : null;
  } catch {
    return null;
  }
}

// "{uuid}" with the case kept, or null when the value is empty or not a UUID.
export function bracedUuid(value) {
  const match = UUID.exec(String(value ?? '').trim());
  return match ? `{${match[1]}}` : null;
}

// "{lowercase-uuid}", or null when the value is empty or not a UUID.
export function normalizeStep(value) {
  return bracedUuid(value)?.toLowerCase() ?? null;
}

function validNames(workspace, repo, build) {
  return NAME.test(workspace) && NAME.test(repo) && BUILD.test(String(build));
}

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}
