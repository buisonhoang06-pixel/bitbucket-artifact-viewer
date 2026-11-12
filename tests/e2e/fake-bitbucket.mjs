// Loads the real extension in Chrome for Testing and answers its requests with a fake Bitbucket. Every request is
// answered locally; a request to any other host is recorded as unexpected and aborted.
//
// bitbucket.org is answered by Playwright routes. Chrome sends a request that follows a redirect made by a route
// to the network instead, and a route adds CORS headers by itself, so a real HTTPS server on 127.0.0.1 answers
// those: the storage host, the next hop of a redirect through bitbucket.org, and Atlassian's sign-in page. Chrome
// reaches it through --host-resolver-rules, so nothing leaves the machine.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { STEP_PAGE_CSP, stepPage } from './step-page.mjs';

// EXTENSION_DIR runs the same tests against another copy, such as the unzipped release package.
export const EXTENSION = process.env.EXTENSION_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');
export const WORKSPACE = 'acme';
export const REPO = 'demo-shop';
export const SESSION = 'cloud.session.token=test-session';
export const STORAGE_COOKIE = 'storage-session=do-not-send';
export const STEP_A = '{0b3c7a52-5f6e-4d7a-9c1e-2a8b9d0e1f23}';
export const STEP_B = '{11111111-2222-3333-4444-555555555555}';
export const SIGNED = 'X-Amz-Signature=do-not-show-this';

// The fake behaves differently by build number.
export const BUILD = {
  ok: 42, // one artifact, served directly
  two: 43, // two artifacts on two steps
  redirect: 44, // content redirects to https://storage.test, which allows no other origin (like S3 without CORS)
  signedOut: 45, // the list answers 401
  expired: 46, // the content answers 404
  signInPage: 47, // the content is an HTML sign-in page
  none: 48, // no artifacts
  redirectCors: 49, // content redirects to https://storage.test, which allows https://bitbucket.org
  pagedTrusted: 50, // the list has a second page on the same route
  pagedUntrusted: 51, // the list's next link points to another host
  storageRefused: 53, // storage answers 403 to the signed address
  storageDown: 54, // content redirects to a storage host that refuses connections
  chain: 55, // content redirects through another bitbucket.org address before storage
  signInRedirect: 56, // content redirects to Atlassian's sign-in page
  large: 57, // a large artifact, served directly
  slow: 59, // the content answers after 2.5 s
  pagedComma: 60, // the list's next link has commas and colons in its query
  listHtml: 61, // the list answers with an HTML page, as after a redirect to the sign-in page
  huge: 62, // the list says the artifact is 600 MB
  running: 63, // the step page shows the bar of a step still running: no Artifacts tab yet
};

// A page with no step tabs, such as a pipeline without a step in its address: the floating button stands in there.
const PIPELINE_PAGE = '<!doctype html><html><head><title>Pipeline</title></head><body><h1>Pipeline</h1></body></html>';
const STEP_URL = /^\/([^/]+)\/([^/]+)\/pipelines\/results\/(\d+)\/steps\/([^/]+)(?:\/(?:metrics|artifacts))?\/?$/;
const uuidOf = (build, letter = 'a') => `{${letter}0000000-0000-0000-0000-0000000000${build}}`;

function artifactsOf(build, archives = {}) {
  if (build === BUILD.none) return [];
  const size = archives[build]?.length ?? 9790;
  const report = { uuid: uuidOf(build), name: 'test-report', path: 'test-report', step_uuid: STEP_A.toUpperCase(), file_size_bytes: size, created_on: '2026-11-11T06:49:19.000Z' };
  if (build === BUILD.two) return [report, { uuid: uuidOf(build, 'b'), name: 'other-report', step_uuid: STEP_B, file_size_bytes: 1234 }];
  if (build === BUILD.huge) return [{ ...report, file_size_bytes: 600 * 1024 * 1024 }];
  return [report];
}

// sameSite: the attribute of the fake session cookie. Chrome sends a Lax cookie only with same-origin requests,
// such as those the content script makes from a bitbucket.org tab.
// archives: { [build]: bytes } overrides the archive served for a build.
export async function launch({ archive, archives = {}, storageGranted = false, sameSite = 'Lax' } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), 'bav-e2e-'));
  // hints: connections to hint.test, a host only a report's resource hints would ever contact.
  const seen = { list: [], content: [], storage: [], tracker: [], unexpected: [], local: [], hints: [] };
  let storage = null;
  let hints = null;
  let context = null;
  try {
    let extension = EXTENSION;
    if (storageGranted) {
      // A copy whose manifest already grants the storage hosts, as Chrome would after "Allow".
      extension = join(scratch, 'extension');
      cpSync(EXTENSION, extension, { recursive: true });
      const manifest = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8'));
      manifest.host_permissions.push('https://storage.test/*', 'https://storage-down.test/*');
      writeFileSync(join(extension, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    storage = await startLocalHosts(scratch, archive, seen);
    const port = storage.address().port;
    hints = createTcpServer((socket) => {
      seen.hints.push(Date.now());
      socket.destroy();
    });
    await new Promise((resolve) => hints.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(join(scratch, 'profile'), {
      channel: 'chromium',
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
        // storage-down.test points at a port where nothing listens.
        `--host-resolver-rules=MAP storage.test 127.0.0.1:${port}, MAP bitbucket.org 127.0.0.1:${port}, MAP id.atlassian.com 127.0.0.1:${port}, MAP hint.test 127.0.0.1:${hints.address().port}, MAP storage-down.test 127.0.0.1:1`,
        '--ignore-certificate-errors',
        // The real hosts are public. Here they resolve to 127.0.0.1, which Chrome's local-network checks would
        // otherwise refuse to a public page such as bitbucket.org.
        '--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights',
      ],
    });
    context.setDefaultTimeout(15000);

    // Routes run in the reverse order of registration, so the catch-all comes first. The extension's own files
    // (chrome-extension://) and the local hosts pass through it.
    await context.route('**/*', (route) => {
      const url = route.request().url();
      // Chrome's own pages, such as its PDF viewer, load their parts from chrome:// and chrome-untrusted://.
      if (/^(chrome-extension|chrome|chrome-untrusted):\/\//.test(url) || /^https:\/\/(storage\.test|storage-down\.test|id\.atlassian\.com)\//.test(url)) return route.continue();
      seen.unexpected.push(url);
      return route.abort();
    });
    await context.route('https://tracker.test/**', (route) => {
      seen.tracker.push(route.request().url());
      return route.fulfill({ status: 204 });
    });
    await context.route('https://example.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<h1>External</h1>' }));
    await context.route('https://bitbucket.org/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = await request.allHeaders();
      const signedIn = (headers.cookie ?? '').includes(SESSION);
      const api = new RegExp(`^/!api/internal/repositories/${WORKSPACE}/${REPO}/pipelines/(\\d+)/artifacts(?:/([^/]+)/content)?$`).exec(url.pathname);
      if (!api) {
        const step = STEP_URL.exec(url.pathname);
        if (step) {
          const page = stepPage({ workspace: step[1], repo: step[2], build: Number(step[3]), step: decodeURIComponent(step[4]), artifacts: Number(step[3]) !== BUILD.running });
          return route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': STEP_PAGE_CSP }, body: page });
        }
        return route.fulfill({ contentType: 'text/html', body: PIPELINE_PAGE });
      }
      const build = Number(api[1]);
      if (!api[2]) {
        seen.list.push({ build, cookie: signedIn, page: url.searchParams.get('page') });
        if (!signedIn || build === BUILD.signedOut) return route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' });
        if (build === BUILD.listHtml) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Log in</title>' });
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(listPage(build, url, archives)) });
      }
      seen.content.push({ build, uuid: decodeURIComponent(api[2]), cookie: signedIn });
      if (!signedIn) return route.fulfill({ status: 401, body: '' });
      if (build === BUILD.expired) return route.fulfill({ status: 404, body: '' });
      if (build === BUILD.signInPage) return route.fulfill({ contentType: 'text/html', body: '<!DOCTYPE html><title>Log in to Bitbucket</title>' });
      const location = {
        [BUILD.redirect]: `https://storage.test/artifacts/${build}.tar.gz?${SIGNED}`,
        [BUILD.redirectCors]: `https://storage.test/artifacts/${build}.tar.gz?${SIGNED}`,
        [BUILD.storageRefused]: `https://storage.test/artifacts/${build}.tar.gz?${SIGNED}`,
        [BUILD.storageDown]: `https://storage-down.test/artifacts/${build}.tar.gz?${SIGNED}`,
        [BUILD.chain]: `https://bitbucket.org/hop/${build}?${SIGNED}`,
        [BUILD.signInRedirect]: 'https://id.atlassian.com/login?continue=https%3A%2F%2Fbitbucket.org',
      }[build];
      if (location) return route.fulfill({ status: 302, headers: { location } });
      if (build === BUILD.slow) await new Promise((resolve) => setTimeout(resolve, 2500));
      return route.fulfill({ contentType: 'application/octet-stream', body: Buffer.from(archives[build] ?? archive) });
    });
    await context.addCookies([
      { name: 'cloud.session.token', value: 'test-session', domain: 'bitbucket.org', path: '/', secure: true, httpOnly: true, sameSite },
      // A cookie of the storage host itself: the viewer must never send it, so no cookie can leak there either.
      { name: 'storage-session', value: 'do-not-send', domain: 'storage.test', path: '/', secure: true, sameSite: 'None' },
    ]);

    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const close = async () => {
      await context.close();
      await new Promise((resolve) => storage.close(resolve));
      await new Promise((resolve) => hints.close(resolve));
      rmSync(scratch, { recursive: true, force: true });
    };
    return {
      context,
      seen,
      extensionId,
      close,
      viewerUrl: (query = '') => `chrome-extension://${extensionId}/viewer.html${query}`,
      // A pipeline page on the fake bitbucket.org, with the content script running in it.
      // A pipeline step page on the fake bitbucket.org, with the content scripts running in it (the Artifact viewer tab
      // shows once they have).
      openBitbucketTab: async (build = BUILD.ok, step = STEP_A) => {
        const page = await context.newPage();
        await page.goto(`https://bitbucket.org/${WORKSPACE}/${REPO}/pipelines/results/${build}/steps/${encodeURIComponent(step)}`);
        await page.locator('a[data-bitbucket-artifact-viewer="tab"]').waitFor();
        return page;
      },
      // A pipeline page without step tabs, where the floating button stands in after about 3 s.
      openPipelinePage: async (build = BUILD.ok) => {
        const page = await context.newPage();
        await page.goto(`https://bitbucket.org/${WORKSPACE}/${REPO}/pipelines/results/${build}`);
        return page;
      },
    };
  } catch (error) {
    await context?.close().catch(() => {});
    if (storage) await new Promise((resolve) => storage.close(resolve));
    if (hints) await new Promise((resolve) => hints.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

function listPage(build, url, archives) {
  const all = artifactsOf(build, archives);
  if (build === BUILD.pagedTrusted) {
    const second = { uuid: uuidOf(build, 'b'), name: 'second-page-report', step_uuid: STEP_B, file_size_bytes: 1 };
    if (url.searchParams.get('page') === '2') return { values: [second], next: null };
    return { values: all, next: `${url.origin}${url.pathname}?page=2` };
  }
  if (build === BUILD.pagedUntrusted) return { values: all, next: 'https://evil.example/!api/internal/next?page=2' };
  if (build === BUILD.pagedComma) {
    const second = { uuid: uuidOf(build, 'b'), name: 'second-page-report', step_uuid: STEP_B, file_size_bytes: 1 };
    if (url.searchParams.get('page') === '2') return { values: [second], next: null };
    return { values: all, next: `${url.origin}${url.pathname}?page=2&fields=values.uuid,values.name,next&cursor=a:b` };
  }
  return { values: all, next: null };
}

// The local HTTPS server for every host a route cannot answer.
async function startLocalHosts(scratch, archive, seen) {
  const key = join(scratch, 'hosts-key.pem');
  const cert = join(scratch, 'hosts-cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=storage.test', '-addext', 'subjectAltName=DNS:storage.test,DNS:bitbucket.org,DNS:id.atlassian.com',
  ], { stdio: 'pipe' });
  const server = createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (request, response) => {
    const host = (request.headers.host ?? '').replace(/:\d+$/, '');
    seen.local.push({ host, path: request.url.replace(/\?.*/, '') });
    if (host === 'storage.test') {
      seen.storage.push({ origin: request.headers.origin ?? null, site: request.headers['sec-fetch-site'] ?? null, referer: request.headers.referer ?? null, cookie: request.headers.cookie ?? null, signed: request.url.includes(SIGNED), path: request.url.replace(/\?.*/, '') });
      if (request.url.startsWith(`/artifacts/${BUILD.storageRefused}.tar.gz`)) {
        response.writeHead(403, { 'content-type': 'application/xml' });
        response.end('<Error><Code>AccessDenied</Code></Error>');
        return;
      }
      const headers = { 'content-type': 'application/x-gzip' };
      if (request.url.startsWith(`/artifacts/${BUILD.redirectCors}.tar.gz`)) headers['access-control-allow-origin'] = 'https://bitbucket.org';
      response.writeHead(200, headers);
      response.end(Buffer.from(archive));
      return;
    }
    if (host === 'bitbucket.org' && request.url.startsWith(`/hop/${BUILD.chain}`)) {
      response.writeHead(302, { location: `https://storage.test/artifacts/${BUILD.chain}.tar.gz?${SIGNED}` });
      response.end();
      return;
    }
    if (host === 'id.atlassian.com') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Log in with Atlassian account</title>');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// Waits until the viewer's iframe shows a document whose <h1> (or <pre>) has the given text.
export async function waitForFrameText(viewer, selector, text) {
  await viewer.waitForFunction(
    ([sel, expected]) => document.getElementById('frame')?.contentDocument?.querySelector(sel)?.textContent?.includes(expected),
    [selector, text],
  );
}

// The panel's settled title: progress titles ("Downloading…") end with an ellipsis and are waited out.
export async function panelTitle(viewer) {
  await viewer.waitForFunction(() => {
    const panel = document.getElementById('panel');
    const title = document.getElementById('panel-title')?.textContent ?? '';
    return panel && !panel.hidden && title !== '' && !title.endsWith('…');
  });
  return viewer.locator('#panel-title').textContent();
}
