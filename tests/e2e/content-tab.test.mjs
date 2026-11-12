// content.js on the fake step page in a plain Chrome, with a stand-in for chrome.runtime whose replies the test gives
// by hand. It covers what the real extension answers too fast to reach: a reply that arrives after the panel was
// closed and opened again, a page with no build, and a reply that fails because the extension was reloaded.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { chromium } from 'playwright';

import { STEP_A } from './fake-bitbucket.mjs';
import { SELECTED_CLASS, STEP_PAGE_CSP, UNSELECTED_CLASS, stepPage } from './step-page.mjs';

const CONTENT = readFileSync(new URL('../../extension/content.js', import.meta.url), 'utf8');
const STEP_URL = `https://bitbucket.org/acme/demo-shop/pipelines/results/42/steps/${encodeURIComponent(STEP_A)}`;
const TAB = 'a[data-bitbucket-artifact-viewer="tab"]';
const PANEL = '[data-bitbucket-artifact-viewer="panel"]';

// A step page running content.js. chrome.runtime.sendMessage waits until the test answers or fails it.
async function openStep(browser) {
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url === STEP_URL) {
      const body = stepPage({ workspace: 'acme', repo: 'demo-shop', build: 42, step: STEP_A });
      return route.fulfill({ contentType: 'text/html', headers: { 'content-security-policy': STEP_PAGE_CSP }, body });
    }
    if (url.startsWith('https://bitbucket.org/viewer.html')) return route.fulfill({ contentType: 'text/html', body: '<p>viewer</p>' });
    return route.abort();
  });
  await page.addInitScript(() => {
    const pending = [];
    const runtime = {
      id: 'test',
      getURL: (path) => new URL(`/${path}`, location.origin).href,
      sendMessage: (message) => new Promise((resolve, reject) => pending.push({ message, resolve, reject })),
    };
    Object.defineProperty(window, 'chrome', { value: { runtime }, configurable: true });
    Object.defineProperty(window, 'pendingReplies', { value: pending });
  });
  await page.goto(STEP_URL);
  await page.addScriptTag({ content: CONTENT });
  await page.locator(TAB).waitFor();
  return page;
}

const asked = (page, count) => page.waitForFunction((n) => window.pendingReplies.length === n, count);
const answer = (page, index, reply) => page.evaluate(([i, r]) => window.pendingReplies[i].resolve(r), [index, reply]);
const nativeTab = (page, text) => page.locator('[aria-label="Log navigation"] a[role="tab"][href]', { hasText: text });

function looks(page) {
  return page.evaluate((tab) => {
    const build = [...document.querySelectorAll('[aria-label="Log navigation"] a[role="tab"][href]')]
      .find((link) => link.textContent.trim() === 'Build');
    const ours = document.querySelector(tab);
    return {
      build: { className: build.className, selected: build.getAttribute('aria-selected'), current: build.getAttribute('aria-current') },
      ours: ours && { className: ours.className, selected: ours.getAttribute('aria-selected'), text: ours.textContent.trim() },
    };
  }, TAB);
}

describe('the Artifact viewer tab when the reply is late, empty or fails', () => {
  let browser;
  before(async () => {
    browser = await chromium.launch({ channel: 'chromium', headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('a reply that arrives after the panel was closed and opened again opens one panel, the newest', async () => {
    const page = await openStep(browser);
    await page.locator(TAB).click();
    await asked(page, 1);
    await nativeTab(page, 'Build').click();
    await page.locator(TAB).click();
    await asked(page, 2);
    await answer(page, 0, { path: 'viewer.html?first' });
    await answer(page, 1, { path: 'viewer.html?second' });
    await page.locator(PANEL).first().waitFor();
    await page.waitForTimeout(200);
    assert.equal(await page.locator(PANEL).count(), 1, 'one panel');
    assert.match(await page.locator(`${PANEL} iframe`).getAttribute('src'), /\?second$/);
    await page.close();
  });

  test('with no build, the tab says so for a moment and Build keeps its look', async () => {
    const page = await openStep(browser);
    await page.locator(TAB).click();
    await asked(page, 1);
    await answer(page, 0, { path: null });
    await page.waitForFunction((tab) => document.querySelector(tab).textContent.trim() === 'No build on this page', TAB);
    const state = await looks(page);
    assert.equal(await page.locator(PANEL).count(), 0);
    assert.deepEqual(state.build, { className: SELECTED_CLASS, selected: 'true', current: 'page' });
    assert.equal(state.ours.className, UNSELECTED_CLASS);
    assert.equal(state.ours.selected, 'false');
    await page.waitForFunction((tab) => document.querySelector(tab).textContent.trim() === 'Artifact viewer', TAB, { timeout: 5000 });
    await page.close();
  });

  test('a reply that fails because the extension was reloaded takes the tab away and gives Build its look back', async () => {
    const page = await openStep(browser);
    await page.locator(TAB).click();
    await asked(page, 1);
    await page.evaluate((tab) => {
      // Records whether the tab ever claims there is no build: after a reload it should simply go.
      window.claimedNoBuild = false;
      new MutationObserver(() => {
        if (document.querySelector(tab)?.textContent.includes('No build')) window.claimedNoBuild = true;
      }).observe(document.querySelector(tab), { subtree: true, characterData: true, childList: true });
      window.chrome.runtime.id = undefined;
      window.pendingReplies[0].reject(new Error('Extension context invalidated.'));
    }, TAB);
    await page.locator(TAB).waitFor({ state: 'detached' });
    const state = await looks(page);
    assert.equal(await page.evaluate(() => window.claimedNoBuild), false, 'no "No build on this page" on the way out');
    assert.equal(await page.locator(PANEL).count(), 0);
    assert.equal(state.ours, null);
    assert.deepEqual(state.build, { className: SELECTED_CLASS, selected: 'true', current: 'page' });
    await page.close();
  });
});
