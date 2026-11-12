// The real extension in Chrome for Testing, against a fake Bitbucket (see fake-bitbucket.mjs).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';

import { cleanup, makeTree, tarWithGnuTar } from '../helpers/archives.mjs';
import {
  BE, BENCH_RUN, FE, assetsArchive, benchmarkArchive, junitArchive, junitFixture, logArchive, markdownArchive, mediaArchive,
  reportArchive,
} from '../helpers/report-fixture.mjs';
import { BUILD, SIGNED, STEP_A, STEP_B, STORAGE_COOKIE, launch, panelTitle, waitForFrameText } from './fake-bitbucket.mjs';
import { SELECTED_CLASS, UNSELECTED_CLASS } from './step-page.mjs';

const archive = reportArchive();
const SUMMARY_TITLE = 'Test results: summary';
const uuidOf = (build, letter = 'a') => `{${letter}0000000-0000-0000-0000-0000000000${build}}`;
const buildUrl = (browser, build, extra = '') => browser.viewerUrl(`?workspace=acme&repo=demo-shop&build=${build}${extra}`);

// A real mouse click on an element inside the viewer's frame, which the viewer handles from outside the frame.
// "host >> inner" reaches into an open shadow root.
async function clickInFrame(viewer, selector, { button = 'left' } = {}) {
  const point = await viewer.evaluate((sel) => {
    const frame = document.getElementById('frame');
    const [outer, inner] = sel.split(' >> ');
    let element = frame.contentDocument.querySelector(outer);
    if (element && inner) element = element.shadowRoot.querySelector(inner);
    if (!element) throw new Error(`${sel} is not in the frame`);
    element.scrollIntoView({ block: 'center' });
    const frameBox = frame.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { x: frameBox.left + box.left + Math.min(box.width / 2, 20), y: frameBox.top + box.top + box.height / 2 };
  }, selector);
  await viewer.mouse.click(point.x, point.y, { button });
}

// Where each link of the file shown in the viewer's frame leads when Chrome opens it by itself (a middle click,
// "Open link in new tab", dragging): its href resolved against the frame, shadow roots included.
function linkAddresses(viewer) {
  return viewer.evaluate(() => {
    const doc = document.getElementById('frame').contentDocument;
    const roots = [doc, ...[...doc.querySelectorAll('*')].map((element) => element.shadowRoot).filter(Boolean)];
    return roots.flatMap((root) => [...root.querySelectorAll('a, area')]).flatMap((link) => {
      const href = link.getAttribute('href') ?? link.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      return href === null ? [] : [{ text: link.textContent.trim() || link.localName, url: new URL(href, doc.baseURI).href }];
    });
  });
}

// Every address must open something real: the full viewer at a file of the artifact, or a website.
function assertAddressesOpen(links, extensionOrigin) {
  assert.ok(links.length > 0);
  for (const { text, url } of links) {
    const address = new URL(url);
    if (address.origin === extensionOrigin) {
      assert.equal(address.pathname, '/viewer.html', `${text}: ${url}`);
      assert.ok(new URLSearchParams(address.hash.slice(1)).get('file'), `${text}: ${url} names a file`);
      assert.equal(address.searchParams.get('embedded'), null, `${text}: the full viewer`);
    } else {
      assert.match(address.protocol, /^(https?|mailto):$/, `${text}: ${url}`);
    }
  }
}

function frameState(viewer) {
  return viewer.evaluate(() => {
    const doc = document.getElementById('frame').contentDocument;
    return { url: doc.URL, title: doc.title, h1: doc.querySelector('h1')?.textContent ?? null, scrollY: doc.defaultView.scrollY, parentTitle: document.title };
  });
}

describe('the extension as shipped, with a bitbucket.org tab open', () => {
  let browser;
  before(async () => {
    const large = reportArchive({ extra: { 'projects/demo/be/evals/results/big.bin': randomBytes(60 * 1024 * 1024) } });
    browser = await launch({ archive, archives: { [BUILD.large]: large } });
    // Kept open for the whole group: viewers opened directly reach Bitbucket through it.
    await browser.openBitbucketTab();
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  test('the floating button (no step tabs) opens the summary; links and Back work; the session cookie is sent', async () => {
    const page = await browser.openPipelinePage(BUILD.ok);
    const [viewer] = await Promise.all([
      browser.context.waitForEvent('page'),
      page.getByRole('button', { name: 'Open report' }).click(),
    ]);
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    assert.match(await viewer.locator('#source').textContent(), /^acme\/demo-shop · build #42 · test-report$/);
    assert.ok(browser.seen.list.some((request) => request.build === BUILD.ok && request.cookie), 'the list request carried the session');
    assert.ok(browser.seen.content.some((request) => request.build === BUILD.ok && request.cookie), 'the download carried the session');

    await clickInFrame(viewer, '#link-report-be');
    await waitForFrameText(viewer, 'h1', 'demo-be report');
    await clickInFrame(viewer, '#to-transcript');
    await waitForFrameText(viewer, 'pre', 'Transcript of run 1');
    const transcript = await viewer.evaluate(() => {
      const doc = document.getElementById('frame').contentDocument;
      return { text: doc.querySelector('pre').textContent, bold: Boolean(doc.querySelector('b')) };
    });
    assert.match(transcript.text, /<b>not bold<\/b>/);
    assert.equal(transcript.bold, false, 'text files are escaped');

    await viewer.goBack();
    await waitForFrameText(viewer, 'h1', 'demo-be report');
    await viewer.goBack();
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    await viewer.goForward();
    await waitForFrameText(viewer, 'h1', 'demo-be report');
    await Promise.all([page.close(), viewer.close()]);
  });

  test('a link with "%2B" and an anchor opens the other report at the folded case', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok));
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    await clickInFrame(viewer, '#link-report-fe');
    await waitForFrameText(viewer, 'h1', 'demo-fe report');
    await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.querySelector('details').open);
    assert.ok((await frameState(viewer)).scrollY > 0, 'scrolled to the case');
    assert.ok(new URL(viewer.url()).hash.includes(encodeURIComponent(`${FE}/report.html`)));

    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(`${BE}/report.html`)}`));
    await waitForFrameText(viewer, 'h1', 'demo-be report');
    await clickInFrame(viewer, '#to-case-1');
    await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.querySelector('details').open);
    await viewer.close();
  });

  test('nothing in the artifact runs, submits or loads', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(`${BE}/report.html`)}`));
    await waitForFrameText(viewer, 'h1', 'demo-be report');
    // Three layers block scripts: this sandbox, the extension page's own policy and the policy added to the file.
    // Each is enough alone, so the sandbox is also checked directly.
    assert.equal(await viewer.locator('#frame').getAttribute('sandbox'), 'allow-same-origin');
    await clickInFrame(viewer, '#handler');
    await clickInFrame(viewer, '#submit');
    await viewer.waitForTimeout(800);
    const state = await frameState(viewer);
    assert.equal(state.title, 'demo-be report', 'no script or handler ran in the frame');
    assert.doesNotMatch(state.parentTitle, /RAN/, 'nothing reached the viewer');
    assert.equal(state.h1, 'demo-be report', 'the form did not navigate the frame, nor did the meta refresh');
    assert.deepEqual(browser.seen.tracker, [], 'no request left for the tracker host');
    await viewer.close();
  });

  test('image-map, SVG and shadow-DOM links are followed by the viewer, never by the frame', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(`${BE}/report.html`)}`));
    await waitForFrameText(viewer, 'h1', 'demo-be report');
    // The closed shadow root is opened by prepareHtml, so its link is handled like the others.
    for (const [selector, url] of [
      ['#map-image', 'https://example.com/area'],
      ['#svg-box', 'https://example.com/svg'],
      ['#open-host >> #shadow-link', 'https://example.com/shadow'],
      ['#closed-host', 'https://example.com/closed'],
    ]) {
      const [tab] = await Promise.all([browser.context.waitForEvent('page'), clickInFrame(viewer, selector)]);
      await tab.waitForLoadState();
      assert.equal(tab.url(), url, selector);
      await tab.close();
      assert.equal((await frameState(viewer)).h1, 'demo-be report', `${selector}: the frame stayed`);
    }
    assert.deepEqual(browser.seen.tracker, [], 'no request left for the tracker host');
    // frame-src 'none' is the backstop for any link the click handling might miss: the frame cannot be sent anywhere,
    // whoever starts the navigation.
    await viewer.evaluate(() => {
      document.getElementById('frame').contentWindow.location.href = 'https://tracker.test/backstop';
    });
    await viewer.waitForTimeout(800);
    assert.deepEqual(browser.seen.tracker, [], 'the frame could not load the tracker');
    await viewer.close();
  });

  test('prepareHtml removes refresh and resource hints and puts the policy first; text is escaped', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(browser.viewerUrl());
    const result = await viewer.evaluate(async () => {
      const { prepareHtml, textDocument } = await import('./lib/render.js');
      const html = prepareHtml('<html><head><link rel="preconnect" href="https://t.test/"><link rel="DNS-Prefetch icon" href="https://t.test/">'
        + '<link rel="stylesheet" href="x.css"><meta http-equiv="Refresh" content="0;url=https://t.test/"></head><body><p>x</p></body></html>');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      // A <template> inside SVG has no content to walk, and a shadow root's own hints and refresh go too.
      const svgPage = prepareHtml('<svg><template><rect/></template></svg><p>svg page</p>');
      const shadowPage = new DOMParser().parseFromString(prepareHtml('<div><template shadowrootmode="closed">'
        + '<link rel="preconnect" href="https://t.test/"><meta http-equiv="refresh" content="0"><a href="#x">x</a></template></div>'), 'text/html');
      const shadowTemplate = shadowPage.querySelector('template');
      return {
        first: doc.head.firstElementChild?.getAttribute('http-equiv'),
        refresh: [...doc.querySelectorAll('meta')].filter((meta) => meta.httpEquiv.toLowerCase() === 'refresh').length,
        links: [...doc.querySelectorAll('link')].map((link) => link.getAttribute('rel')),
        text: textDocument('<b>x</b>'),
        svgPage,
        shadowMode: shadowTemplate.getAttribute('shadowrootmode'),
        shadowLeft: shadowTemplate.content.querySelectorAll('link, meta').length,
        shadowLinks: shadowTemplate.content.querySelectorAll('a').length,
      };
    });
    assert.equal(result.first, 'Content-Security-Policy');
    assert.equal(result.refresh, 0);
    assert.deepEqual(result.links, ['stylesheet']);
    assert.match(result.text, /<pre>&lt;b&gt;x&lt;\/b&gt;<\/pre>/);
    assert.match(result.svgPage, /svg page/);
    assert.equal(result.shadowMode, 'open');
    assert.equal(result.shadowLeft, 0);
    assert.equal(result.shadowLinks, 1);
    await viewer.close();
  });

  test('every link carries an address that opens, so a middle click shows the file in a new viewer tab', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok));
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    const origin = new URL(viewer.url()).origin;
    assertAddressesOpen(await linkAddresses(viewer), origin);

    const [opened] = await Promise.all([browser.context.waitForEvent('page'), clickInFrame(viewer, '#link-report-be', { button: 'middle' })]);
    await waitForFrameText(opened, 'h1', 'demo-be report');
    assert.equal(new URL(opened.url()).pathname, '/viewer.html');
    assert.equal(await frameState(viewer).then((state) => state.h1), SUMMARY_TITLE, 'the first tab stays where it was');
    // The report holds the image-map, SVG, shadow-DOM and same-file links.
    assertAddressesOpen(await linkAddresses(opened), origin);
    await Promise.all([opened.close(), viewer.close()]);
  });

  test('the artifact chosen in the chooser stays chosen in a new tab, so the chooser does not come back', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.two));
    await viewer.getByRole('button', { name: /other-report/ }).click();
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    const link = (await linkAddresses(viewer)).find(({ text }) => text.includes('demo-be'));
    const carried = new URL(link.url);
    assert.equal(carried.searchParams.get('artifact'), uuidOf(BUILD.two, 'b'));
    const again = await browser.context.newPage();
    await again.goto(carried.href);
    await waitForFrameText(again, 'h1', 'demo-be report');
    assert.equal(browser.seen.content.at(-1).uuid, uuidOf(BUILD.two, 'b'), 'the chosen artifact, downloaded at once');
    assert.equal(await again.locator('#chooser').isHidden(), true);
    await Promise.all([again.close(), viewer.close()]);
  });

  test('while the artifact downloads, the loader shows; it goes when the report shows, and failures have none', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.slow));
    await viewer.locator('#panel-title', { hasText: 'Downloading test-report' }).waitFor();
    assert.equal(await viewer.locator('#loader').isVisible(), true, 'the loader is on');
    assert.equal(await viewer.locator('#loader-bar').isVisible(), true, 'with its bar');
    const status = await viewer.locator('#panel-title').boundingBox();
    assert.ok(status.width <= 1 && status.height <= 1, 'the status line is for screen readers only');
    assert.ok((await viewer.locator('#loader-line').textContent()).length > 0, 'with a line under it');
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    assert.equal(await viewer.locator('#loader').isVisible(), false, 'gone with the report');

    const failed = await browser.context.newPage();
    await failed.goto(buildUrl(browser, BUILD.expired));
    await failed.locator('#panel-title', { hasText: 'The artifact is no longer available' }).waitFor();
    assert.equal(await failed.locator('#loader').isVisible(), false, 'no loader on a failure');
    await Promise.all([failed.close(), viewer.close()]);
  });

  test('an artifact the listing says is too large is refused before any download', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.huge));
    await viewer.locator('#panel-title', { hasText: 'The artifact is too large to open here' }).waitFor();
    assert.equal(browser.seen.content.some((request) => request.build === BUILD.huge), false);
    await viewer.close();
  });

  test('blocked, missing and external links', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok));
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    // After each click the frame must still show the summary: the viewer handles links, the frame never follows one.
    const stillOnSummary = async () => {
      await viewer.waitForTimeout(400);
      const state = await frameState(viewer);
      assert.equal(state.h1, SUMMARY_TITLE);
      assert.equal(state.title, SUMMARY_TITLE);
    };

    await clickInFrame(viewer, '#link-js');
    assert.match(await viewer.locator('#notice').textContent(), /^This link was blocked: javascript:/);
    await stillOnSummary();

    await clickInFrame(viewer, '#link-missing');
    assert.match(await viewer.locator('#notice').textContent(), /^Not in this artifact: projects\/demo\/be\/evals\/results\/.+\/missing\.html$/);
    await stillOnSummary();

    const [external] = await Promise.all([browser.context.waitForEvent('page'), clickInFrame(viewer, '#link-external')]);
    await external.waitForLoadState();
    assert.equal(external.url(), 'https://example.com/docs');
    await stillOnSummary();

    // The viewer keeps each link's original address in an attribute of its own. One the artifact planted on an
    // element without href is removed, so the element stays plain text.
    const planted = browser.context.waitForEvent('page', { timeout: 1500 }).then(() => true, () => false);
    await clickInFrame(viewer, '#link-spoofed');
    assert.equal(await planted, false, 'no tab opened');
    await stillOnSummary();
    await Promise.all([external.close(), viewer.close()]);
  });

  test('failures say what happened', async () => {
    const viewer = await browser.context.newPage();
    const expectations = [
      [BUILD.signedOut, 'Bitbucket did not accept your session'],
      [BUILD.expired, 'The artifact is no longer available'],
      [BUILD.none, 'This build has no artifacts'],
      [BUILD.signInRedirect, 'Bitbucket did not accept your session'],
      [BUILD.listHtml, 'Bitbucket did not accept your session'],
      [BUILD.signInPage, 'test-report could not be opened'],
    ];
    for (const [build, title] of expectations) {
      await viewer.goto(buildUrl(browser, build));
      assert.equal(await panelTitle(viewer), title, `build ${build}`);
    }
    assert.match(await viewer.locator('#panel-detail').textContent(), /sign-in page/);
    assert.ok(browser.seen.local.some((request) => request.host === 'id.atlassian.com'), 'the sign-in redirect was followed locally');
    await viewer.close();
  });

  test('a redirect to a storage host that allows bitbucket.org opens without asking for anything', async () => {
    const before = browser.seen.storage.length;
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.redirectCors));
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    const requests = browser.seen.storage.slice(before);
    assert.deepEqual(requests.map((request) => request.origin), ['https://bitbucket.org'], 'only the Bitbucket tab went to storage');
    assert.ok(requests.every((request) => request.signed && !request.cookie), 'the signed address, and no cookie');
    assert.ok(!(await viewer.content()).includes(SIGNED));
    await viewer.close();
  });

  test('a storage host that allows no other origin is asked for once, and the viewer does not try it before', async () => {
    for (const build of [BUILD.redirect, BUILD.chain]) {
      const before = browser.seen.storage.length;
      const viewer = await browser.context.newPage();
      await viewer.goto(buildUrl(browser, build));
      assert.equal(await panelTitle(viewer), 'Bitbucket keeps this file on https://storage.test', `build ${build}: the host after every bitbucket.org hop`);
      assert.ok(!(await viewer.content()).includes(SIGNED), 'the signed address is not on the page');
      // The requester is told by the Referer: after two hops Chrome sends Origin: null even from the Bitbucket tab.
      assert.deepEqual(browser.seen.storage.slice(before).map((request) => request.referer), ['https://bitbucket.org/'], 'only the Bitbucket tab tried; the viewer waits for access');
      if (build === BUILD.chain) assert.ok(browser.seen.local.some((request) => request.host === 'bitbucket.org' && request.path === `/hop/${BUILD.chain}`));

      // Chrome's permission prompt cannot be answered from a test, so the request is answered with a refusal here;
      // the granted path runs in the group "after the storage hosts are allowed".
      await viewer.evaluate(() => {
        chrome.permissions.request = async () => false;
      });
      await viewer.getByRole('button', { name: 'Allow and retry' }).click();
      assert.equal(await panelTitle(viewer), 'Access to https://storage.test was not allowed');
      await viewer.getByRole('button', { name: 'Allow and retry' }).waitFor();
      await viewer.close();
    }
    assert.ok(browser.seen.storage.every((request) => !request.cookie), `no cookie went to storage (${STORAGE_COOKIE} exists for it)`);
  });

  test('two artifacts give a chooser; the step in the address picks one', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.two));
    assert.equal(await panelTitle(viewer), 'Build #43 has 2 artifacts');
    const names = await viewer.locator('#chooser button > span:first-child').allTextContents();
    assert.deepEqual(names, ['test-report', 'other-report']);
    await viewer.getByRole('button', { name: /other-report/ }).click();
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    assert.equal(browser.seen.content.at(-1).uuid, uuidOf(BUILD.two, 'b'));

    await viewer.goto(buildUrl(browser, BUILD.two, `&step=${encodeURIComponent(STEP_A)}`));
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    assert.equal(browser.seen.content.at(-1).uuid, uuidOf(BUILD.two));
    await viewer.close();
  });

  test('the artifact list follows a next page on the same route, and no other', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.pagedTrusted));
    assert.equal(await panelTitle(viewer), 'Build #50 has 2 artifacts');
    assert.deepEqual(await viewer.locator('#chooser button > span:first-child').allTextContents(), ['test-report', 'second-page-report']);
    assert.deepEqual(browser.seen.list.filter((request) => request.build === BUILD.pagedTrusted).map((request) => request.page), [null, '2']);

    await viewer.goto(buildUrl(browser, BUILD.pagedUntrusted));
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    assert.deepEqual(browser.seen.list.filter((request) => request.build === BUILD.pagedUntrusted).map((request) => request.page), [null]);
    assert.ok(!browser.seen.unexpected.some((url) => url.includes('evil.example')), 'the untrusted next link was not requested');

    await viewer.goto(buildUrl(browser, BUILD.pagedComma));
    assert.equal(await panelTitle(viewer), 'Build #60 has 2 artifacts', 'a next link with commas and colons is followed');
    await viewer.close();
  });

  test('a 60 MiB artifact comes through the Bitbucket tab in pieces, and the bar fills as they arrive', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.large));
    // Each fill of the bar, recorded as it changes, until the archive is shown.
    const fills = await viewer.evaluate(() => new Promise((resolve) => {
      const values = [];
      const bar = document.getElementById('loader-bar');
      const observer = new MutationObserver(() => {
        const value = bar.style.getPropertyValue('--done');
        if (bar.classList.contains('known') && value && values.at(-1) !== value) values.push(value);
      });
      observer.observe(bar, { attributes: true, attributeFilter: ['style', 'class'] });
      const done = () => {
        observer.disconnect();
        resolve(values);
      };
      const check = setInterval(() => {
        if (!document.getElementById('workspace').hidden) {
          clearInterval(check);
          done();
        }
      }, 20);
      setTimeout(done, 30000);
    }));
    const numbers = fills.map((value) => Number.parseInt(value, 10));
    assert.ok(numbers.length >= 3, `the bar filled in steps: ${fills.join(', ')}`);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b), 'only forward');
    assert.equal(numbers.at(-1), 100, 'up to the end');
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    assert.equal(browser.seen.content.filter((request) => request.build === BUILD.large).length, 1, 'downloaded once');
    assert.ok(await viewer.locator('#files button[data-path$="big.bin"]').count());
    await viewer.close();
  });

  test('a file opened while a download is still running is not replaced by it', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.slow));
    await viewer.waitForFunction(() => document.getElementById('panel-title').textContent.startsWith('Downloading'));
    await viewer.setInputFiles('#file-input', { name: 'local-copy.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from(reportArchive({ title: 'Local copy' })) });
    await waitForFrameText(viewer, 'h1', 'Local copy');
    await viewer.waitForTimeout(3500);
    assert.equal((await frameState(viewer)).h1, 'Local copy');
    assert.equal(await viewer.locator('#source').textContent(), 'local-copy.tar.gz');
    await viewer.close();
  });

  test('closing the Bitbucket tab during a download says the download stopped', async () => {
    const page = await browser.openPipelinePage(BUILD.slow);
    const requested = () => browser.seen.content.filter((request) => request.build === BUILD.slow).length;
    const before = requested();
    const [viewer] = await Promise.all([browser.context.waitForEvent('page'), page.getByRole('button', { name: 'Open report' }).click()]);
    // Close the tab only once it has taken the request: a tab closed before that is simply skipped, and the viewer
    // downloads through the other open bitbucket.org tab instead.
    for (let i = 0; i < 200 && requested() === before; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(requested() > before, 'the slow download started');
    await page.close();
    assert.equal(await panelTitle(viewer), 'The download through the Bitbucket tab stopped');
    await viewer.close();
  });

  test('a downloaded .tar.gz opens from the file picker or by dropping it, with no request to Bitbucket', async () => {
    const before = browser.seen.list.length + browser.seen.content.length;
    const viewer = await browser.context.newPage();
    await viewer.goto(browser.viewerUrl());
    assert.equal(await panelTitle(viewer), 'Open a downloaded artifact');
    await viewer.setInputFiles('#file-input', { name: 'test-report.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from(archive) });
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    assert.equal(await viewer.locator('#source').textContent(), 'test-report.tar.gz');

    await viewer.goto(browser.viewerUrl());
    await viewer.evaluate((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.tar.gz', { type: 'application/gzip' }));
      window.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, cancelable: true }));
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, cancelable: true }));
    }, [...archive]);
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    assert.equal(await viewer.locator('#source').textContent(), 'dropped.tar.gz');
    assert.equal(await viewer.locator('#drop-overlay').isHidden(), true);
    assert.equal(browser.seen.list.length + browser.seen.content.length, before);
    await viewer.close();
  });

  test('a large text file shows its first 2 MB with a note', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(browser.viewerUrl());
    await viewer.setInputFiles('#file-input', { name: 'logs.tar.gz', mimeType: 'application/gzip', buffer: Buffer.from(logArchive(3 * 1024 * 1024)) });
    await waitForFrameText(viewer, '.note', 'Showing the first 2.00 MB of 3.00 MB.');
    const length = await viewer.evaluate(() => document.getElementById('frame').contentDocument.querySelector('pre').textContent.length);
    assert.equal(length, 2 * 1024 * 1024);
    await viewer.close();
  });

  test('the button follows single-page navigation and opens the build and step of the current address', async () => {
    const page = await browser.context.newPage();
    await page.goto('https://bitbucket.org/acme/demo-shop/pipelines');
    const button = page.getByRole('button', { name: /Open report|No build/ });
    await page.waitForTimeout(1200);
    assert.equal(await button.count(), 0, 'no button on the pipelines list');

    await page.evaluate(() => history.pushState({}, '', '/acme/demo-shop/pipelines/results/42'));
    await button.waitFor({ timeout: 10000 });
    const [first] = await Promise.all([browser.context.waitForEvent('page'), button.click()]);
    await waitForFrameText(first, 'h1', SUMMARY_TITLE);
    assert.equal(new URL(first.url()).searchParams.get('build'), '42');
    await first.close();

    await page.evaluate((step) => history.pushState({}, '', `/acme/demo-shop/pipelines/results/43/steps/${encodeURIComponent(step)}`), STEP_B);
    const [second] = await Promise.all([browser.context.waitForEvent('page'), button.click()]);
    await waitForFrameText(second, 'h1', SUMMARY_TITLE);
    const query = new URL(second.url()).searchParams;
    assert.equal(query.get('build'), '43');
    assert.equal(query.get('step'), STEP_B);
    assert.equal(browser.seen.content.at(-1).uuid, uuidOf(BUILD.two, 'b'), "step B's artifact, without a chooser");
    await second.close();

    await page.evaluate(() => history.pushState({}, '', '/acme/demo-shop/src/main/README.md'));
    await button.waitFor({ state: 'detached', timeout: 5000 });
    await page.goto('https://bitbucket.org/acme/demo-shop/pull-requests/7');
    await page.waitForTimeout(1500);
    assert.equal(await button.count(), 0);
    await page.close();
  });

  test('no request went to an unknown host', () => {
    assert.deepEqual(browser.seen.unexpected, []);
  });
});

// --- The Artifact viewer tab inside Bitbucket's step tabs ---------------------------------------------------------------

const TAB = 'a[data-bitbucket-artifact-viewer="tab"]';
const PANEL = '[data-bitbucket-artifact-viewer="panel"]';
const nativeTab = (page, text) => page.locator('[aria-label="Log navigation"] a[role="tab"][href]', { hasText: text });

// The viewer inside the panel, once it shows `text` in `selector` of its own frame.
async function waitForEmbedded(page, selector, text) {
  await page.locator(`${PANEL} iframe`).waitFor();
  let frame = null;
  for (let i = 0; i < 200 && !frame; i += 1) {
    frame = page.frame({ url: /viewer\.html\?.*embedded=1/ });
    if (!frame) await page.waitForTimeout(25);
  }
  assert.ok(frame, 'the embedded viewer loaded');
  await frame.waitForFunction(
    ([sel, expected]) => document.getElementById('frame')?.contentDocument?.querySelector(sel)?.textContent?.includes(expected),
    [selector, text],
  );
  return frame;
}

// A real click on an element of the artifact shown in the panel: page, then panel frame, then the viewer's frame.
async function clickInEmbedded(page, frame, selector, { button = 'left' } = {}) {
  const inner = await frame.evaluate((sel) => {
    const view = document.getElementById('frame');
    const element = view.contentDocument.querySelector(sel);
    element.scrollIntoView({ block: 'center' });
    const viewBox = view.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    return { x: viewBox.left + box.left + Math.min(box.width / 2, 20), y: viewBox.top + box.top + box.height / 2 };
  }, selector);
  const outer = await page.evaluate((sel) => {
    const box = document.querySelector(sel).getBoundingClientRect();
    return { x: box.left, y: box.top };
  }, `${PANEL} iframe`);
  await page.mouse.click(outer.x + inner.x, outer.y + inner.y, { button });
}

function tabState(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[role="group"][aria-label="Log navigation"]');
    const links = [...bar.querySelectorAll('a[role="tab"]')];
    const read = (link) => link && {
      className: link.className,
      selected: link.getAttribute('aria-selected'),
      current: link.getAttribute('aria-current'),
      href: link.getAttribute('href'),
    };
    const named = (text) => read(links.find((link) => link.textContent.trim() === text && !link.hasAttribute('data-bitbucket-artifact-viewer')));
    return {
      order: links.map((link) => link.textContent.trim()),
      ours: read(bar.querySelector('a[data-bitbucket-artifact-viewer="tab"]')),
      build: named('Build'),
      metrics: named('Metrics'),
      inHiddenCopy: Boolean(document.querySelector('[aria-hidden="true"] [data-bitbucket-artifact-viewer]')),
      panel: Boolean(document.querySelector('[data-bitbucket-artifact-viewer="panel"]')),
      floating: Boolean(document.querySelector('div[data-bitbucket-artifact-viewer=""]')),
    };
  });
}

// --- Tabs that are open when the extension is installed or updated -------------------------------------------------

describe('bitbucket.org tabs that are open when the extension is installed or updated', () => {
  let browser;
  before(async () => {
    browser = await launch({ archive: reportArchive() });
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  // The report in the panel, through the tab's own scripts: the embedded viewer downloads through content-fetch.js.
  const reportInPanel = async (page) => {
    await page.locator(TAB).click();
    return waitForEmbedded(page, 'h1', SUMMARY_TITLE);
  };

  test('a second copy of the scripts in a page makes no second tab and no second download', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).waitFor();
    const [worker] = browser.context.serviceWorkers();
    await worker.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-fetch.js', 'content.js'] });
    }, page.url());
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(TAB).count(), 1);
    const before = browser.seen.content.filter((request) => request.build === BUILD.ok).length;
    await reportInPanel(page);
    assert.equal(browser.seen.content.filter((request) => request.build === BUILD.ok).length, before + 1, 'downloaded once');
    await page.close();
  });

  test('after an update, an open step tab gets the Artifact viewer tab again, without a reload, and only one', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).waitFor();
    // Marks in the page's own world: a reload would drop them, and the tab of the old copy keeps its mark.
    await page.evaluate((tab) => {
      window.notReloaded = true;
      document.querySelector(tab).dataset.oldCopy = 'yes';
    }, TAB);
    // Chrome reloads an unpacked extension only in developer mode, which "Load unpacked" needs anyway.
    const settings = await browser.context.newPage();
    await settings.goto('chrome://extensions');
    await settings.evaluate(() => new Promise((resolve) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, resolve)));
    await settings.close();
    const [worker] = browser.context.serviceWorkers();
    await worker.evaluate(() => chrome.runtime.reload()).catch(() => {});
    await page.waitForFunction((tab) => {
      const tabs = document.querySelectorAll(tab);
      return tabs.length === 1 && !tabs[0].dataset.oldCopy;
    }, TAB, { timeout: 15000 });
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(TAB).count(), 1, 'the old copy took its tab away');
    assert.equal(await page.evaluate(() => window.notReloaded), true, 'the page was not reloaded');
    await reportInPanel(page);
    await page.close();
  });

  test('no request went to an unknown host', () => {
    assert.deepEqual(browser.seen.unexpected, []);
  });
});

// --- The benchmark's artifact, and the kinds of file it holds ----------------------------------------------------------

describe("the benchmark's artifact and the kinds of file it holds", () => {
  let browser;
  before(async () => {
    const crafted = tarWithGnuTar(makeTree({
      '<b>x</b>/<img src=x onerror=alert(1)>.txt': 'x',
      [`${'-a'.repeat(120)}.txt`]: 'x',
      'index.html': '<h1>Crafted</h1>',
    }), { entries: ['.'] });
    browser = await launch({ archive: benchmarkArchive(), archives: { [BUILD.large]: crafted } });
    await browser.openBitbucketTab(BUILD.ok);
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  const openAt = async (path = null) => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok, path ? `#file=${encodeURIComponent(path)}` : ''));
    return viewer;
  };
  const shown = (viewer) => viewer.evaluate(() => document.getElementById('frame').contentDocument.body?.textContent ?? '');

  const rows = (viewer) => viewer.evaluate(() => [...document.querySelectorAll('#files summary, #files button')]
    .filter((row) => row.checkVisibility())
    .map((row) => (row.tagName === 'SUMMARY' ? `${row.textContent}/` : `${row.textContent} ${row.dataset.icon}`)));
  // Which folder icon the list's first folder shows, from the icons the stylesheet defines.
  const folderIcon = (viewer) => viewer.evaluate(() => {
    const icons = getComputedStyle(document.getElementById('files'));
    const icon = getComputedStyle(document.querySelector('#files summary'), '::after').getPropertyValue('--icon').trim();
    if (icon === icons.getPropertyValue('--icon-folder-open').trim()) return 'open';
    return icon === icons.getPropertyValue('--icon-folder').trim() ? 'closed' : icon;
  });

  test('the list is a folder tree: a chain of single folders on one row, its files under it, each with the icon of its kind', async () => {
    const viewer = await openAt();
    await waitForFrameText(viewer, 'h1', 'Benchmark results');
    const inRun = ['diff.patch file-diff', 'final.md file-text', 'notes.html file-code', 'run.json file-data', 'screenshot.bin file',
      'stream.jsonl file-data', 'transcript.txt file-text'];
    const top = ['benchmark.html file-code', 'benchmark.json file-data', 'benchmark.md file-text'];
    assert.deepEqual(await rows(viewer), [`${BENCH_RUN}/`, ...inRun, ...top]);
    assert.equal(await viewer.locator('#files summary').getAttribute('title'), BENCH_RUN);
    assert.equal(await folderIcon(viewer), 'open');

    // A click closes the folder, and its icon with it.
    await viewer.locator('#files summary').click();
    assert.equal(await folderIcon(viewer), 'closed');
    assert.deepEqual(await rows(viewer), [`${BENCH_RUN}/`, ...top]);

    // A link to a file inside the closed folder opens it again, the file marked.
    await clickInFrame(viewer, '#to-stream');
    await waitForFrameText(viewer, 'pre', '── line 1 ──');
    assert.equal(await folderIcon(viewer), 'open');
    assert.equal(await viewer.locator('#files button[aria-current="page"]').getAttribute('data-path'), `${BENCH_RUN}/stream.jsonl`);
    await viewer.close();
  });

  test("names in the list are text: a file's name cannot add markup to the viewer; a long one is cut, its path in the tooltip", async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.large));
    await waitForFrameText(viewer, 'h1', 'Crafted');
    const long = `${'-a'.repeat(120)}.txt`;
    assert.deepEqual(await rows(viewer), ['<b>x</b>/', '<img src=x onerror=alert(1)>.txt file-text', `${long} file-text`, 'index.html file-code']);
    assert.equal(await viewer.locator('#files b, #files img').count(), 0);
    const row = await viewer.evaluate((path) => {
      const button = document.querySelector(`#files button[data-path="${path}"]`);
      const name = button.querySelector('.name');
      return {
        elements: button.querySelectorAll('*').length,
        cut: name.scrollWidth > name.clientWidth,
        ellipsis: getComputedStyle(name).textOverflow,
        oneLine: button.getBoundingClientRect().height < 30,
        title: button.title,
      };
    }, long);
    assert.deepEqual(row, { elements: 1, cut: true, ellipsis: 'ellipsis', oneLine: true, title: `${long} (1 B)` });
    await viewer.close();
  });

  test('it opens on benchmark.html at the top, not on an HTML page deeper in a run', async () => {
    const viewer = await openAt();
    await waitForFrameText(viewer, 'h1', 'Benchmark results');
    assert.equal(await viewer.locator('#file-name').textContent(), 'benchmark.html');
    await viewer.close();
  });

  test("a session's events show one formatted record per line; Raw shows the file as it is", async () => {
    const viewer = await openAt(`${BENCH_RUN}/stream.jsonl`);
    await waitForFrameText(viewer, 'pre', '── line 1 ──');
    let text = await shown(viewer);
    assert.match(text, /── line 2 ──\n\{\n {2}"type": "assistant"/);
    assert.match(text, /── line 3 ──\nnot json/);
    assert.equal(await viewer.locator('#toggle-raw').isVisible(), true);
    assert.equal(await viewer.locator('#toggle-raw').getAttribute('aria-pressed'), 'false');

    await viewer.locator('#toggle-raw').click();
    await waitForFrameText(viewer, 'pre', '{"type":"system","subtype":"init"}');
    assert.equal(await viewer.locator('#toggle-raw').getAttribute('aria-pressed'), 'true');

    // Another file, then back: it opens formatted again.
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(`${BENCH_RUN}/run.json`)}`));
    await waitForFrameText(viewer, 'pre', '"model": "model-a"');
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(`${BENCH_RUN}/stream.jsonl`)}`));
    await waitForFrameText(viewer, 'pre', '── line 1 ──');
    await viewer.close();
  });

  test('a patch and a transcript show as text, with no Raw; Markdown shows as a page; a binary file says it cannot be shown', async () => {
    const viewer = await openAt(`${BENCH_RUN}/diff.patch`);
    await waitForFrameText(viewer, 'pre', 'diff --git a/src/cart.js');
    assert.equal(await viewer.locator('#toggle-raw').isVisible(), false);
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(`${BENCH_RUN}/final.md`)}`));
    await waitForFrameText(viewer, 'h1', 'Final answer');
    // benchmark.md, the table for the pull request, as a table.
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent('benchmark.md')}`));
    await waitForFrameText(viewer, 'td', 'case-a');
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(`${BENCH_RUN}/screenshot.bin`)}`));
    await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.body?.textContent.includes('cannot be shown here'));
    await viewer.close();
  });

  test('Download saves the file shown under its own name, a text file and a binary one alike', async () => {
    const viewer = await openAt(`${BENCH_RUN}/screenshot.bin`);
    await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.body?.textContent.includes('cannot be shown here'));
    const [binary] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('#download').click()]);
    assert.equal(binary.suggestedFilename(), 'screenshot.bin');
    assert.equal((await binary.createReadStream().then((stream) => stream.toArray())).reduce((n, chunk) => n + chunk.length, 0), 512);
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(`${BENCH_RUN}/diff.patch`)}`));
    await waitForFrameText(viewer, 'pre', 'diff --git');
    const [text] = await Promise.all([viewer.waitForEvent('download'), viewer.locator('#download').click()]);
    assert.equal(text.suggestedFilename(), 'diff.patch');
    await viewer.close();
  });

  test('in the Artifact viewer panel too, the file bar names the file and Download works', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator('a[data-bitbucket-artifact-viewer="tab"]').click();
    await page.locator('[data-bitbucket-artifact-viewer="panel"] iframe').waitFor();
    let frame = null;
    for (let i = 0; i < 200 && !frame; i += 1) {
      frame = page.frame({ url: /viewer\.html\?.*embedded=1/ });
      if (!frame) await page.waitForTimeout(25);
    }
    await frame.waitForFunction(() => document.getElementById('frame')?.contentDocument?.querySelector('h1')?.textContent === 'Benchmark results');
    assert.equal(await frame.locator('#file-name').textContent(), 'benchmark.html');
    const [download] = await Promise.all([page.waitForEvent('download'), frame.locator('#download').click()]);
    assert.equal(download.suggestedFilename(), 'benchmark.html');
    await page.close();
  });
});

// --- Images, video and PDF -----------------------------------------------------------------------------------------

describe('images, video and PDF from the artifact', () => {
  let browser;
  before(async () => {
    browser = await launch({ archive: mediaArchive() });
    await browser.openBitbucketTab(BUILD.ok);
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  const go = (viewer, path) => viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(path)}`));
  // The frame's image or video once it has loaded, with the policy its document carries.
  const media = (target, selector, ready) => target.waitForFunction(([sel, check]) => {
    const doc = document.getElementById('frame').contentDocument;
    const element = doc?.querySelector(sel);
    if (!element) return null;
    const loaded = check === 'image' ? element.complete && element.naturalWidth > 0 : element.readyState >= 2;
    return loaded && { src: element.currentSrc || element.src, policy: doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content };
  }, [selector, ready], { timeout: 10000 }).then((handle) => handle.jsonValue());

  test('every image kind shows from a blob URL, under a policy that allows blob: images and nothing else', async () => {
    const viewer = await browser.context.newPage();
    await go(viewer, 'media/shot.png');
    for (const name of ['shot.png', 'shot.jpg', 'shot.gif', 'shot.webp', 'shot.bmp', 'logo.svg']) {
      await go(viewer, `media/${name}`);
      await viewer.waitForFunction((file) => document.getElementById('file-name').textContent === `media/${file}`, name);
      const shown = await media(viewer, 'img', 'image');
      assert.match(shown.src, /^blob:chrome-extension:\/\//, name);
      assert.equal(shown.policy, "default-src 'none'; img-src blob:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'", name);
    }
    await viewer.waitForTimeout(500);
    assert.deepEqual(browser.seen.hints, [], "the SVG's script and external image reach no host");
    await viewer.close();
  });

  test('webm and mp4 videos load in the frame, under a policy that allows blob: media only', async () => {
    const viewer = await browser.context.newPage();
    for (const name of ['clip.webm', 'clip.mp4']) {
      await go(viewer, `media/${name}`);
      const shown = await media(viewer, 'video', 'video');
      assert.match(shown.src, /^blob:chrome-extension:\/\//, name);
      assert.match(shown.policy, /media-src blob:/, name);
      assert.doesNotMatch(shown.policy, /img-src/, name);
    }
    await viewer.close();
  });

  test("Open PDF shows the PDF in a new tab as application/pdf; the frame only says so", async () => {
    const viewer = await browser.context.newPage();
    await go(viewer, 'media/doc.pdf');
    await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.body?.textContent.includes('is a PDF'));
    assert.equal(await viewer.locator('#open-pdf').isVisible(), true);
    const [tab] = await Promise.all([browser.context.waitForEvent('page'), viewer.locator('#open-pdf').click()]);
    await tab.waitForLoadState().catch(() => {});
    await tab.waitForTimeout(500);
    assert.match(tab.url(), /^blob:chrome-extension:\/\//);
    assert.equal(await tab.evaluate(() => document.contentType), 'application/pdf');
    await Promise.all([tab.close(), viewer.close()]);
  });

  test('files whose names lie show as text, never as what their names claim', async () => {
    const viewer = await browser.context.newPage();
    await go(viewer, 'media/fake.pdf');
    await waitForFrameText(viewer, 'pre', '<h1>Not a PDF</h1>');
    assert.equal(await viewer.locator('#open-pdf').isVisible(), false, 'no Open PDF');
    assert.equal(await viewer.locator('#download').isVisible(), true);
    await go(viewer, 'media/fake.png');
    await waitForFrameText(viewer, 'pre', '<h1>Not an image</h1>');
    assert.equal(await viewer.evaluate(() => document.getElementById('frame').contentDocument.querySelector('img')), null);
    assert.notEqual(await viewer.evaluate(() => document.getElementById('frame').contentDocument.title), 'RAN');
    await viewer.close();
  });

  test('in the Artifact viewer panel too: an image, a video and Open PDF', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator('a[data-bitbucket-artifact-viewer="tab"]').click();
    await page.locator('[data-bitbucket-artifact-viewer="panel"] iframe').waitFor();
    let frame = null;
    for (let i = 0; i < 200 && !frame; i += 1) {
      frame = page.frame({ url: /viewer\.html\?.*embedded=1/ });
      if (!frame) await page.waitForTimeout(25);
    }
    await frame.waitForFunction(() => document.getElementById('file-name')?.textContent === 'index.html');
    await frame.locator('#toggle-files').click();
    await frame.locator('#files button[data-path="media/shot.webp"]').click();
    assert.match((await media(frame, 'img', 'image')).src, /^blob:chrome-extension:/);
    await frame.locator('#files button[data-path="media/clip.webm"]').click();
    await media(frame, 'video', 'video');
    await frame.locator('#files button[data-path="media/doc.pdf"]').click();
    const [tab] = await Promise.all([browser.context.waitForEvent('page'), frame.locator('#open-pdf').click()]);
    await tab.waitForTimeout(500);
    assert.equal(await tab.evaluate(() => document.contentType), 'application/pdf');
    await Promise.all([tab.close(), page.close()]);
  });

  test('no request went to an unknown host', () => {
    assert.deepEqual(browser.seen.unexpected, []);
    assert.deepEqual(browser.seen.hints, []);
  });
});

// --- JUnit test reports ---------------------------------------------------------------------------------------------

describe('JUnit XML as a test report', () => {
  let browser;
  before(async () => {
    browser = await launch({ archive: junitArchive() });
    await browser.openBitbucketTab(BUILD.ok);
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  const go = (viewer, path) => viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(path)}`));
  const shown = (viewer) => viewer.evaluate(() => document.getElementById('frame').contentDocument.body?.textContent ?? '');

  test("the model reads each tool's layout, with the totals the tool wrote or the cases add up to", async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(browser.viewerUrl(''));
    const model = (name) => viewer.evaluate(async (xml) => {
      const { junitModel } = await import('./lib/junit.js');
      return junitModel(new DOMParser().parseFromString(xml, 'application/xml'));
    }, junitFixture(name));

    const surefire = await model('surefire.xml');
    assert.deepEqual(surefire.totals, { tests: 3, failures: 1, errors: 0, skipped: 1, time: 0.12, passed: 1 });
    assert.deepEqual(surefire.suites[0].cases.map((item) => item.status), ['passed', 'failed', 'skipped']);
    assert.equal(surefire.suites[0].cases[1].message, 'expected: <1> but was: <2>');
    assert.equal(surefire.suites[0].cases[1].type, 'org.opentest4j.AssertionFailedError');
    assert.equal(surefire.suites[0].cases[2].message, 'not ready yet');

    const pytest = await model('pytest.xml');
    assert.equal(pytest.name, 'pytest tests');
    assert.deepEqual(pytest.totals, { tests: 2, failures: 0, errors: 1, skipped: 0, time: 0.051, passed: 1 });
    assert.match(pytest.suites[0].cases[1].detail, /ConnectionError: database unavailable/);

    const jest = await model('jest-junit.xml');
    assert.deepEqual(jest.totals, { tests: 4, failures: 1, errors: 0, skipped: 0, time: 1.234, passed: 3 });
    assert.equal(jest.suites[1].cases[1].systemOut, 'no results for "qwzx"');

    const playwright = await model('playwright.xml');
    assert.deepEqual(playwright.totals, { tests: 2, failures: 1, errors: 0, skipped: 0, time: 5.2, passed: 1 });
    assert.match(playwright.suites[0].cases[1].detail, /Timed out 5000ms/);

    const nested = await model('nested.xml');
    assert.deepEqual(nested.suites.map((suite) => suite.name), ['outer', 'inner-a', 'inner-b']);
    assert.deepEqual(nested.totals, { tests: 3, failures: 1, errors: 0, skipped: 0, time: 0.6000000000000001, passed: 2 });

    // A count the tool wrote that leaves out a nested suite does not hide that suite's failure.
    const partial = await viewer.evaluate(async (xml) => {
      const { junitModel } = await import('./lib/junit.js');
      return junitModel(new DOMParser().parseFromString(xml, 'application/xml')).totals;
    }, '<testsuites><testsuite name="outer" tests="2" failures="0"><testcase name="o1"/><testcase name="o2"/>'
      + '<testsuite name="inner"><testcase name="i1"><failure message="hidden"/></testcase></testsuite></testsuite></testsuites>');
    assert.deepEqual(partial, { tests: 3, failures: 1, errors: 0, skipped: 0, time: 0, passed: 2 });
    await viewer.close();
  });

  test('a report with more than 20,000 suites, or 20,000 cases under a prefix, shows as its XML', async () => {
    // A page of its own for each file, so that the note seen cannot be the previous file's.
    for (const name of ['many-suites.xml', 'prefixed-cases.xml']) {
      const viewer = await browser.context.newPage();
      await go(viewer, `results/${name}`);
      await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.body?.textContent.includes('too many to show as a report'));
      await viewer.close();
    }
  });

  test('each flavour shows its totals and its failures; Raw shows the XML', async () => {
    const viewer = await browser.context.newPage();
    const expected = {
      'surefire.xml': ['com.example.CartTest', 'expected: <1> but was: <2>'],
      'pytest.xml': ['pytest tests', 'failed on setup with "ConnectionError: database unavailable"'],
      'jest-junit.xml': ['jest tests', 'Expected: 3'],
      'playwright.xml': ['checkout.spec.ts', "Locator: getByText('Receipt <b>sent</b>')"],
      'nested.xml': ['inner-a', 'boom'],
    };
    for (const [name, [heading, failure]] of Object.entries(expected)) {
      await go(viewer, `results/${name}`);
      await viewer.waitForFunction((text) => document.getElementById('frame').contentDocument.body?.textContent.includes(text), heading);
      const text = await shown(viewer);
      assert.ok(text.includes(failure), `${name}: ${failure}`);
      assert.equal(await viewer.evaluate(() => document.getElementById('frame').contentDocument.querySelector('b')?.textContent !== undefined), true);
      assert.equal(await viewer.evaluate(() => document.getElementById('frame').contentDocument.querySelector('script')), null);
    }
    // The tags in a failure message are text, not markup.
    await go(viewer, 'results/playwright.xml');
    await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.body?.textContent.includes('checkout.spec.ts'));
    assert.equal(await viewer.evaluate(() => [...document.getElementById('frame').contentDocument.querySelectorAll('b')].some((b) => b.textContent === 'sent')), false);

    await viewer.locator('#toggle-raw').click();
    await waitForFrameText(viewer, 'pre', '<testsuites id="" name=""');
    await viewer.close();
  });

  test('XML with a DOCTYPE shows as text, its entities unexpanded; XML that does not parse shows as text with a note', async () => {
    const viewer = await browser.context.newPage();
    await go(viewer, 'results/doctype.xml');
    await waitForFrameText(viewer, 'pre', '<!ENTITY lol2');
    assert.ok((await shown(viewer)).includes('name="&lol2;"'), 'the entity stays as written');
    assert.equal(await viewer.locator('#toggle-raw').isVisible(), false);
    await go(viewer, 'results/broken.xml');
    await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.body?.textContent.includes('could not be read as a test report'));
    assert.ok((await shown(viewer)).includes('<testcase name="a">'));
    await viewer.close();
  });
});

// --- An HTML report's own images, stylesheets and fonts -------------------------------------------------------------

describe("an HTML report's own images, stylesheets and fonts", () => {
  let browser;
  before(async () => {
    // A page with more images than one page may take from the artifact.
    const png = new Uint8Array(readFileSync(new URL('../fixtures/media/shot.png', import.meta.url)));
    const many = { 'many/index.html': `<!doctype html><title>Many</title><h1>Many images</h1>${Array.from({ length: 501 }, (_, i) => `<img src="img/${i}.png" alt="">`).join('')}` };
    for (let i = 0; i < 501; i += 1) many[`many/img/${i}.png`] = png;
    many['many/repeat.html'] = `<!doctype html><title>Repeat</title><h1>One image, many times</h1>${'<img src="img/0.png" alt="">'.repeat(600)}`;
    browser = await launch({ archive: assetsArchive(), archives: { [BUILD.large]: tarWithGnuTar(makeTree(many), { entries: ['many'] }) } });
    await browser.openBitbucketTab(BUILD.ok);
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  test('a coverage-like report shows its stylesheets, imports, images and font from the artifact, and nothing else', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok));
    await waitForFrameText(viewer, 'h1', 'Coverage report');
    await viewer.waitForFunction(() => {
      const doc = document.getElementById('frame').contentDocument;
      return doc.getElementById('shot').complete && doc.fonts.status === 'loaded';
    });
    const look = await viewer.evaluate(async () => {
      const frame = document.getElementById('frame');
      const doc = frame.contentDocument;
      const style = (id, property) => frame.contentWindow.getComputedStyle(doc.getElementById(id))[property];
      await doc.fonts.ready;
      return {
        heading: frame.contentWindow.getComputedStyle(doc.querySelector('h1')).color,
        shot: { width: doc.getElementById('shot').naturalWidth, src: doc.getElementById('shot').src.slice(0, 5) },
        missing: doc.getElementById('missing').naturalWidth,
        srcset: doc.getElementById('srcset').currentSrc.slice(0, 5),
        dataSrcset: doc.getElementById('srcset-data').getAttribute('srcset'),
        inline: style('inline-bg', 'backgroundImage').includes('blob:'),
        attribute: style('attr-bg', 'backgroundImage').includes('blob:'),
        body: frame.contentWindow.getComputedStyle(doc.body).backgroundImage.includes('blob:'),
        font: doc.fonts.check('16px "Fixture Sans"') && [...doc.fonts].some((face) => face.family.includes('Fixture Sans') && face.status === 'loaded'),
        escaped: style('escape-check', 'color'),
        hints: doc.querySelectorAll('link[rel~="preconnect"]').length,
        remote: doc.querySelectorAll('link[href^="https://hint.test"]').length,
      };
    });
    assert.equal(look.heading, 'rgb(1, 2, 3)', 'theme.css, imported by base.css');
    assert.deepEqual(look.shot, { width: 24, src: 'blob:' });
    assert.equal(look.missing, 0, 'a missing image is broken, nothing more');
    assert.equal(look.srcset, 'blob:');
    assert.equal(look.dataSrcset, 'data:image/gif;base64,R0lGODlhAQABAAAAACw= 1x', 'a srcset with nothing from the artifact stays as it was');
    assert.equal(look.inline, true, 'url() in a <style>');
    assert.equal(look.attribute, true, 'url() in a style attribute');
    assert.equal(look.body, true, 'url() in a stylesheet');
    assert.equal(look.font, true, 'the font from the artifact');
    assert.equal(look.escaped, 'rgb(4, 5, 6)', 'the escaping stylesheet still applies');
    assert.equal(look.hints, 0, 'and its "</style><link rel=preconnect>" stayed CSS text');
    assert.equal(look.remote, 1, 'the https: stylesheet is left as it is, for the policy to block');
    await viewer.waitForTimeout(1000);
    assert.deepEqual(browser.seen.hints, [], 'no connection to hint.test');
    assert.equal(await viewer.locator('#notice').isVisible(), false);
    await viewer.close();
  });

  test('beyond its allowance a page takes no more files from the artifact, and the viewer says so', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.large));
    await waitForFrameText(viewer, 'h1', 'Many images');
    await viewer.locator('#notice', { hasText: 'were not loaded' }).waitFor();
    const counts = await viewer.evaluate(() => {
      const images = [...document.getElementById('frame').contentDocument.querySelectorAll('img')];
      return { blob: images.filter((image) => image.getAttribute('src').startsWith('blob:')).length, total: images.length };
    });
    assert.deepEqual(counts, { blob: 500, total: 501 });
    await viewer.close();
  });

  test('an image used many times on a page is one file of its allowance', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.large, `#file=${encodeURIComponent('many/repeat.html')}`));
    await waitForFrameText(viewer, 'h1', 'One image, many times');
    const sources = await viewer.evaluate(() => [...new Set([...document.getElementById('frame').contentDocument.querySelectorAll('img')]
      .map((image) => image.getAttribute('src')))]);
    assert.equal(sources.length, 1);
    assert.match(sources[0], /^blob:chrome-extension:/);
    assert.equal(await viewer.locator('#notice').isVisible(), false);
    await viewer.close();
  });

  test('no request went to an unknown host', () => {
    assert.deepEqual(browser.seen.unexpected, []);
  });
});

// --- Markdown as a page -------------------------------------------------------------------------------------------

describe('Markdown as a page', () => {
  let browser;
  before(async () => {
    browser = await launch({ archive: markdownArchive() });
    await browser.openBitbucketTab(BUILD.ok);
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  test('a Markdown file shows headings, lists, a quote, code and a table, with its image from the artifact', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent('docs/README.md')}`));
    await waitForFrameText(viewer, 'h1', 'Project notes');
    await viewer.waitForFunction(() => document.getElementById('frame').contentDocument.querySelector('img')?.naturalWidth > 0);
    const page = await viewer.evaluate(() => {
      const doc = document.getElementById('frame').contentDocument;
      return {
        headings: [...doc.querySelectorAll('h2')].map((h) => h.id),
        nested: doc.querySelectorAll('ol > li ul > li').length,
        quote: doc.querySelector('blockquote')?.textContent.trim(),
        code: doc.querySelector('pre code.language-sh')?.textContent,
        cell: doc.querySelector('td[style="text-align:right"]')?.textContent,
        image: doc.querySelector('img').src.slice(0, 5),
        scripts: doc.querySelectorAll('script').length,
        text: doc.body.textContent,
        trap: [...doc.querySelectorAll('a')].some((a) => a.textContent === 'a trap'),
        title: doc.title,
      };
    });
    assert.deepEqual(page.headings, ['steps', 'results']);
    assert.equal(page.nested, 2);
    assert.equal(page.quote, 'A quoted line.');
    assert.equal(page.code, 'npm test');
    assert.equal(page.cell, '0.8');
    assert.equal(page.image, 'blob:');
    assert.equal(page.scripts, 0, 'its HTML is text');
    assert.ok(page.text.includes("<script>document.title = 'RAN'</script>"));
    assert.equal(page.trap, false, 'a javascript: link keeps only its text');
    assert.notEqual(page.title, 'RAN');
    await viewer.close();
  });

  test('its links move inside the viewer, its anchors scroll, and Raw shows the source', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent('docs/README.md')}`));
    await waitForFrameText(viewer, 'h1', 'Project notes');
    await clickInFrame(viewer, 'a[href*="guide.md"], a[data-viewer-href="guide.md"]');
    await waitForFrameText(viewer, 'h1', 'The guide');
    await clickInFrame(viewer, 'a[data-viewer-href="README.md"]');
    await waitForFrameText(viewer, 'h1', 'Project notes');
    assert.equal(await viewer.locator('#toggle-raw').isVisible(), true);
    await viewer.locator('#toggle-raw').click();
    await waitForFrameText(viewer, 'pre', '# Project notes');
    await viewer.close();
  });
});

// --- Reports that try to reach the network or to break the viewer ---------------------------------------------------

const HOSTILE = 'projects/demo/hostile';
const HOSTILE_FILES = {
  [`${HOSTILE}/nested.html`]: `<!doctype html><html><head><meta http-equiv="x-dns-prefetch-control" content="on"><title>Nested frame</title></head><body>
<h1>Nested frame</h1>
<iframe id="nested" srcdoc="&lt;link rel=preconnect href=https://hint.test/&gt;&lt;link rel=dns-prefetch href=https://hint.test/&gt;&lt;a href=target.html&gt;relative&lt;/a&gt;"></iframe>
<object id="plugin" data="https://hint.test/object" type="text/html"></object>
<embed id="embed" src="https://hint.test/embed">
<a id="hint-link" href="https://hint.test/page">a website</a>
</body></html>`,
  [`${HOSTILE}/clobber.html`]: `<!doctype html><html><head><title>Clobbering</title></head><body>
<h1>Clobbering</h1>
<img name="addEventListener" alt=""><img name="getElementById" alt=""><img name="getElementsByName" alt=""><img name="querySelectorAll" alt=""><img name="defaultView" alt="">
<p><a id="to-target" href="target.html">target</a> <a id="to-folded" href="#folded">folded</a> <a id="to-in-form" href="#in-form">in a form</a></p>
<details id="folded-section"><summary>Folded</summary><p id="folded">Folded text</p></details>
<details id="form-section"><summary>A form</summary><form><input name="parentElement"><input name="scrollIntoView"><p id="in-form">Text in a form</p></form></details>
</body></html>`,
  [`${HOSTILE}/target.html`]: '<!doctype html><title>Target</title><h1>Target</h1>',
};

describe('reports that try to reach the network or to break the viewer', () => {
  let browser;
  before(async () => {
    browser = await launch({ archive: reportArchive({ extra: HOSTILE_FILES }) });
    await browser.openBitbucketTab(BUILD.ok);
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  const openAt = async (path) => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.ok, `#file=${encodeURIComponent(path)}`));
    return viewer;
  };

  test("a report's frames, plug-ins and resource hints are removed, and no host is contacted", async () => {
    const viewer = await openAt(`${HOSTILE}/nested.html`);
    await waitForFrameText(viewer, 'h1', 'Nested frame');
    await viewer.waitForTimeout(2000);
    assert.deepEqual(browser.seen.hints, [], 'no connection to hint.test');
    const shown = await viewer.evaluate(() => {
      const doc = document.getElementById('frame').contentDocument;
      const [first, second] = doc.head.children;
      return {
        embeds: doc.querySelectorAll('iframe, frame, object, embed').length,
        first: first?.getAttribute('http-equiv'),
        second: second && `${second.getAttribute('http-equiv')}=${second.getAttribute('content')}`,
      };
    });
    assert.equal(shown.embeds, 0, 'no frame or plug-in is left in the report');
    assert.equal(shown.first, 'Content-Security-Policy', 'the policy first');
    assert.equal(shown.second, 'x-dns-prefetch-control=off', "DNS prefetching off before anything of the report's");
    assert.deepEqual(browser.seen.unexpected, []);
    await viewer.close();
  });

  test("names in a report cannot switch off the viewer's own handling of links and anchors", async () => {
    const viewer = await openAt(`${HOSTILE}/clobber.html`);
    await waitForFrameText(viewer, 'h1', 'Clobbering');
    // The report's names shadow its document's own methods, so the test reads it through the prototype too.
    const opened = (id) => viewer.waitForFunction((section) => {
      const doc = document.getElementById('frame').contentDocument;
      return Document.prototype.querySelector.call(doc, `#${section}`)?.open === true;
    }, id, { timeout: 5000 });
    await clickInFrame(viewer, '#to-folded');
    await opened('folded-section');
    // The anchor is inside a form whose fields are named after DOM properties.
    await clickInFrame(viewer, '#to-in-form');
    await opened('form-section');
    await clickInFrame(viewer, '#to-target');
    await waitForFrameText(viewer, 'h1', 'Target');
    await viewer.close();
  });
});

describe('the Artifact viewer tab on a step page', () => {
  let browser;
  before(async () => {
    browser = await launch({ archive });
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  test('it sits after Artifacts in the visible bar only, looks like its neighbours, and no floating button shows', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    const state = await tabState(page);
    assert.deepEqual(state.order, ['Build', 'Metrics', 'Artifacts', 'Artifact viewer']);
    assert.equal(state.ours.className, UNSELECTED_CLASS);
    assert.equal(state.ours.selected, 'false');
    assert.equal(state.ours.href, null, 'no link: it never navigates');
    const cursors = await page.evaluate((selector) => ({
      ours: getComputedStyle(document.querySelector(selector)).cursor,
      build: getComputedStyle(document.querySelector('[aria-label="Log navigation"] a[role="tab"][href]')).cursor,
    }), TAB);
    assert.deepEqual(cursors, { ours: 'pointer', build: 'pointer' }, 'the hand, as on the other tabs');
    assert.equal(state.inHiddenCopy, false, "not in Bitbucket's hidden measuring copy");
    await page.waitForTimeout(3500);
    assert.equal((await tabState(page)).floating, false, 'no floating button where the tab is');
    await page.close();
  });

  test('a click made by a page script does nothing; Enter on the focused tab opens it', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.evaluate((selector) => document.querySelector(selector).click(), TAB);
    await page.waitForTimeout(500);
    assert.equal(await page.locator(PANEL).count(), 0, 'no panel from an untrusted click');
    assert.equal((await tabState(page)).build.className, SELECTED_CLASS, 'Build keeps its look');
    await page.locator(TAB).focus();
    await page.keyboard.press('Enter');
    await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    assert.equal((await tabState(page)).ours.selected, 'true');
    await page.close();
  });

  test('clicking it shows the report under the tabs, styled as the selected tab, despite a strict page CSP', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).click();
    await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    const state = await tabState(page);
    assert.equal(state.ours.className, SELECTED_CLASS);
    assert.equal(state.ours.selected, 'true');
    assert.equal(state.build.className, UNSELECTED_CLASS);
    assert.equal(state.build.selected, 'false');
    assert.equal(state.build.current, null);
    const measure = () => page.evaluate((panel) => {
      const own = document.querySelector(panel).getBoundingClientRect();
      const row = document.querySelector('[aria-label="Log navigation"]').parentElement.getBoundingClientRect();
      const pane = document.getElementById('row').getBoundingClientRect();
      return { top: own.top, left: own.left, width: own.width, bottom: own.bottom, rowBottom: row.bottom, rowWidth: row.width, paneLeft: pane.left, paneWidth: pane.width, viewport: innerHeight };
    }, PANEL);
    const checkPlace = (box, layout) => {
      assert.ok(box.top >= box.rowBottom && box.top <= box.rowBottom + 16, `${layout}: right under the tab row`);
      assert.equal(Math.round(box.left), Math.round(box.paneLeft), `${layout}: aligned with the step's pane`);
      assert.equal(Math.round(box.width), Math.round(box.paneWidth), `${layout}: as wide as the step's pane`);
      assert.ok(Math.abs(box.bottom + 8 - box.viewport) <= 2, `${layout}: down to the bottom of the window`);
    };
    checkPlace(await measure(), 'bar as wide as the pane');
    // Bitbucket's own styles may make the bar and its wrapper only as wide as the tabs; the panel must not shrink.
    await page.addStyleTag({ content: '#outer > div:first-child, [aria-label="Log navigation"] { display: inline-flex; }' });
    await page.waitForFunction(() => document.querySelector('[aria-label="Log navigation"]').parentElement.getBoundingClientRect().width < 600);
    await page.waitForTimeout(100);
    const narrow = await measure();
    assert.ok(narrow.rowWidth < narrow.paneWidth / 2, 'the layout did change');
    checkPlace(narrow, 'bar as wide as the tabs');
    // On real Bitbucket the tabs share their row with a toolbar, so the tabs' own wrapper ends before the pane does.
    await page.evaluate(() => {
      const toolbar = document.createElement('div');
      toolbar.id = 'toolbar';
      toolbar.textContent = 'tools';
      toolbar.style.cssText = 'flex: 1 1 auto; text-align: right;';
      document.getElementById('row').append(toolbar);
      document.getElementById('outer').style.flex = '0 0 600px';
    });
    await page.waitForFunction(() => document.getElementById('outer').getBoundingClientRect().width === 600);
    await page.waitForTimeout(100);
    const withToolbar = await measure();
    checkPlace(withToolbar, 'a toolbar beside the tabs');
    assert.ok(browser.seen.list.some((request) => request.cookie), 'fetched through this tab, with the session');
    await page.close();
  });

  test('inside the panel, links work, its own Back returns, the page history does not grow, and it opens in a new tab', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).click();
    const frame = await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    const before = await page.evaluate(() => history.length);
    assert.equal(await frame.locator('#back').isDisabled(), true);

    await clickInEmbedded(page, frame, '#link-report-be');
    await frame.waitForFunction(() => document.getElementById('frame').contentDocument.querySelector('h1')?.textContent === 'demo-be report');
    assert.equal(await page.evaluate(() => history.length), before, 'the report added nothing to the page history');

    await frame.locator('#back').click();
    await frame.waitForFunction((title) => document.getElementById('frame').contentDocument.querySelector('h1')?.textContent === title, SUMMARY_TITLE);
    assert.equal(await frame.locator('#back').isDisabled(), true);

    const [full] = await Promise.all([browser.context.waitForEvent('page'), frame.locator('#open-tab').click()]);
    await waitForFrameText(full, 'h1', SUMMARY_TITLE);
    assert.equal(new URL(full.url()).searchParams.get('embedded'), null, 'the full viewer, not the embedded one');
    await Promise.all([full.close(), page.close()]);
  });

  test("the panel shows the report alone, with the panel's whole width; Files brings the list and takes it away", async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).click();
    const frame = await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    const widths = () => frame.evaluate(() => ({ view: document.getElementById('frame').getBoundingClientRect().width, page: innerWidth }));
    const alone = await widths();
    assert.equal(await frame.locator('#files').isVisible(), false, 'no list at first');
    assert.equal(await frame.locator('#toggle-files').getAttribute('aria-pressed'), 'false');
    assert.match(await frame.locator('#toggle-files').textContent(), /^Files \(\d+\)$/, 'the button counts the files');
    assert.ok(Math.abs(alone.view - alone.page) <= 2, 'the report has the whole width');
    await frame.locator('#toggle-files').click();
    await frame.locator('#files').waitFor({ state: 'visible' });
    const listed = await widths();
    assert.equal(await frame.locator('#toggle-files').getAttribute('aria-pressed'), 'true');
    assert.ok(listed.view < alone.view - 150, `the list takes its room (${alone.view} -> ${listed.view})`);
    await frame.locator('#toggle-files').click();
    await frame.locator('#files').waitFor({ state: 'hidden' });
    await page.close();
  });

  test('a middle click on a link in the panel opens that file in a full viewer tab', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).click();
    const frame = await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    const [opened] = await Promise.all([browser.context.waitForEvent('page'), clickInEmbedded(page, frame, '#link-report-be', { button: 'middle' })]);
    await waitForFrameText(opened, 'h1', 'demo-be report');
    const address = new URL(opened.url());
    assert.equal(address.pathname, '/viewer.html');
    assert.equal(address.searchParams.get('embedded'), null, 'the full viewer, not the embedded one');
    assert.equal(await page.locator(PANEL).count(), 1, 'the panel stays open');
    await Promise.all([opened.close(), page.close()]);
  });

  test('inside the panel no host access is asked for; the full viewer it opens asks instead', async () => {
    const page = await browser.openBitbucketTab(BUILD.redirect);
    await page.locator(TAB).click();
    await page.locator(`${PANEL} iframe`).waitFor();
    let frame = null;
    for (let i = 0; i < 200 && !frame; i += 1) {
      frame = page.frame({ url: /viewer\.html\?.*embedded=1/ });
      if (!frame) await page.waitForTimeout(25);
    }
    await frame.locator('#panel-title', { hasText: 'Bitbucket keeps this file on https://storage.test' }).waitFor();
    assert.equal(await frame.getByRole('button', { name: 'Allow and retry' }).count(), 0, 'no permission prompt from a frame');
    const [full] = await Promise.all([
      browser.context.waitForEvent('page'),
      frame.locator('#panel-actions').getByRole('button', { name: 'Open in new tab' }).click(),
    ]);
    await full.getByRole('button', { name: 'Allow and retry' }).waitFor();
    await Promise.all([full.close(), page.close()]);
  });

  test('a query or a hash added on the same step keeps the panel open', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).click();
    await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    await page.evaluate(() => history.replaceState(null, '', `${location.pathname}?highlight=1#line-3`));
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(PANEL).count(), 1);
    await page.close();
  });

  test("choosing one of Bitbucket's tabs closes the panel and gives the tabs back their look", async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).click();
    await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    await nativeTab(page, 'Metrics').click();
    await page.locator(PANEL).waitFor({ state: 'detached' });
    let state = await tabState(page);
    assert.match(page.url(), /\/metrics$/);
    assert.equal(state.metrics.className, SELECTED_CLASS);
    assert.equal(state.build.className, UNSELECTED_CLASS);
    assert.equal(state.ours.className, UNSELECTED_CLASS);
    assert.equal(state.ours.selected, 'false');

    // Open it again, then click the tab that was selected before: Bitbucket changes nothing on a click on the
    // selected tab, so the extension must put its look back itself.
    await page.locator(TAB).click();
    await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    assert.equal((await tabState(page)).metrics.className, UNSELECTED_CLASS);
    await nativeTab(page, 'Metrics').click();
    await page.locator(PANEL).waitFor({ state: 'detached' });
    state = await tabState(page);
    assert.equal(state.metrics.className, SELECTED_CLASS);
    assert.equal(state.metrics.selected, 'true');
    assert.equal(state.metrics.current, 'page');
    await page.close();
  });

  test('Back while the panel is open closes it and leaves the tab Bitbucket selects as the only selected one', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await nativeTab(page, 'Metrics').click();
    await page.waitForFunction(() => location.pathname.endsWith('/metrics'));
    await page.locator(TAB).click();
    await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    await page.evaluate(() => history.back());
    await page.locator(PANEL).waitFor({ state: 'detached' });
    const state = await tabState(page);
    assert.doesNotMatch(page.url(), /\/metrics$/);
    assert.equal(state.build.className, SELECTED_CLASS);
    assert.equal(state.build.selected, 'true');
    assert.equal(state.metrics.className, UNSELECTED_CLASS, 'Metrics does not get its old look back');
    assert.equal(state.metrics.selected, 'false');
    assert.equal(state.metrics.current, null);
    assert.equal(state.ours.className, UNSELECTED_CLASS);
    await page.close();
  });

  test('after Bitbucket re-renders the bar, the tab comes back, once; a re-render under an open panel closes it', async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.evaluate(() => window.rerenderTabs());
    await page.waitForFunction(() => document.querySelector('[aria-label="Log navigation"] a[data-bitbucket-artifact-viewer="tab"]'));
    assert.deepEqual((await tabState(page)).order, ['Build', 'Metrics', 'Artifacts', 'Artifact viewer']);
    assert.equal(await page.locator(TAB).count(), 1);

    // New nodes carry none of the panel's state, so the panel closes and the new bar shows Bitbucket's own selection.
    await page.locator(TAB).click();
    await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    await page.evaluate(() => window.rerenderTabs());
    await page.locator(PANEL).waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.querySelector('[aria-label="Log navigation"] a[data-bitbucket-artifact-viewer="tab"]'));
    const state = await tabState(page);
    assert.equal(state.build.className, SELECTED_CLASS);
    assert.equal(state.ours.className, UNSELECTED_CLASS);
    assert.equal(state.ours.selected, 'false');
    assert.equal(await page.locator(TAB).count(), 1);
    await page.close();
  });

  test("moving to another step closes the panel, and the tab then opens that step's build", async () => {
    const page = await browser.openBitbucketTab(BUILD.ok);
    await page.locator(TAB).click();
    await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    await page.evaluate(([build, step]) => window.goToStep(build, step), [BUILD.two, STEP_B]);
    await page.locator(PANEL).waitFor({ state: 'detached' });
    await page.locator(TAB).click();
    const frame = await waitForEmbedded(page, 'h1', SUMMARY_TITLE);
    const query = new URL(frame.url()).searchParams;
    assert.equal(query.get('build'), String(BUILD.two));
    assert.equal(query.get('step'), STEP_B);
    assert.equal(browser.seen.content.at(-1).uuid, uuidOf(BUILD.two, 'b'), "step B's artifact");
    await page.close();
  });

  test('while a step runs and has no Artifacts tab yet, neither the tab nor the button shows; when it ends, the tab does', async () => {
    const page = await browser.context.newPage();
    await page.goto(`https://bitbucket.org/acme/demo-shop/pipelines/results/${BUILD.running}/steps/${encodeURIComponent(STEP_A)}`);
    await nativeTab(page, 'Metrics').waitFor();
    // Longer than the button's delay plus one check of the page, so that a button that would come does.
    const appeared = await page.getByRole('button', { name: 'Open report' }).waitFor({ timeout: 5500 }).then(() => true, () => false);
    assert.equal(appeared, false, 'no floating button');
    assert.equal(await page.locator(TAB).count(), 0, 'and no Artifact viewer tab before there are artifacts');
    await page.evaluate(() => window.finishStep());
    await page.locator(TAB).waitFor();
    assert.deepEqual((await tabState(page)).order, ['Build', 'Metrics', 'Artifacts', 'Artifact viewer']);
    await page.close();
  });

  test('with no step tabs, the floating button stands in after about 3 s', async () => {
    const page = await browser.openPipelinePage(BUILD.ok);
    await page.waitForTimeout(1500);
    assert.equal(await page.getByRole('button', { name: 'Open report' }).count(), 0, 'not at once');
    await page.getByRole('button', { name: 'Open report' }).waitFor({ timeout: 6000 });
    await page.close();
  });

  test('no request went to an unknown host', () => {
    assert.deepEqual(browser.seen.unexpected, []);
  });
});

describe('after the storage hosts are allowed', () => {
  let browser;
  before(async () => {
    browser = await launch({ archive, storageGranted: true });
    await browser.openBitbucketTab();
  });
  after(async () => {
    await browser?.close();
    cleanup();
  });

  test('a redirected download opens, and no cookie goes with the signed address', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.redirect));
    await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    // The Bitbucket tab is refused by CORS first; the viewer then reads the signed address with host access, which
    // Chrome sends without an Origin header.
    assert.deepEqual(browser.seen.storage.map((request) => request.origin), ['https://bitbucket.org', null]);
    assert.ok(browser.seen.storage.every((request) => !request.cookie), `no cookie went to storage (${STORAGE_COOKIE} exists for it)`);
    assert.ok(!(await viewer.content()).includes(SIGNED));
    await viewer.close();
  });

  test('a refusal and an unreachable host say so, and Retry does not ask for access again', async () => {
    const viewer = await browser.context.newPage();
    await viewer.goto(buildUrl(browser, BUILD.storageRefused));
    assert.equal(await panelTitle(viewer), 'The storage host refused the download');

    await viewer.goto(buildUrl(browser, BUILD.storageDown));
    assert.equal(await panelTitle(viewer), 'https://storage-down.test could not be reached');
    await viewer.getByRole('button', { name: 'Retry' }).click();
    assert.equal(await panelTitle(viewer), 'https://storage-down.test could not be reached');
    assert.equal(await viewer.getByRole('button', { name: 'Allow and retry' }).count(), 0);
    assert.deepEqual(browser.seen.unexpected, []);
    await viewer.close();
  });
});

describe('without an open bitbucket.org tab', () => {
  test('a SameSite=Lax session does not go with the extension\'s own request, and the viewer says what to do', async () => {
    const browser = await launch({ archive });
    try {
      const viewer = await browser.context.newPage();
      await viewer.goto(buildUrl(browser, BUILD.ok));
      assert.equal(await panelTitle(viewer), 'Open this build from its Bitbucket page');
      assert.deepEqual(browser.seen.list.map((request) => request.cookie), [false]);

      // Opening the pipeline page and retrying is enough.
      await browser.openBitbucketTab();
      await viewer.getByRole('button', { name: 'Retry' }).click();
      await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
    } finally {
      await browser.close();
    }
  });

  test('a SameSite=None session goes with the extension\'s own request', async () => {
    const browser = await launch({ archive, sameSite: 'None' });
    try {
      const viewer = await browser.context.newPage();
      await viewer.goto(buildUrl(browser, BUILD.ok));
      await waitForFrameText(viewer, 'h1', SUMMARY_TITLE);
      assert.ok(browser.seen.list.every((request) => request.cookie));
    } finally {
      await browser.close();
      cleanup();
    }
  });
});
