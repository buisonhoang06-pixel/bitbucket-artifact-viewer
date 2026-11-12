// content.js, run in a Node vm with a fake chrome and a page that has no step tabs: when the fallback button shows,
// which clicks count, and how the script stops. The Artifact viewer tab needs a real page; the end-to-end tests cover it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../extension/content.js', import.meta.url), 'utf8');

function element() {
  const listeners = {};
  return {
    children: [],
    textContent: '',
    isConnected: false,
    setAttribute() {},
    attachShadow() {
      this.shadowRoot = element();
      return this.shadowRoot;
    },
    append(...nodes) {
      this.children.push(...nodes);
      for (const node of nodes) node.isConnected = true;
    },
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    fire(type, event) {
      listeners[type]?.(event);
    },
    remove() {
      this.isConnected = false;
    },
  };
}

// Loads content.js on a page at `pathname` without step tabs. advance(ms) moves the clock and runs the script's
// one-second timer once.
function load({ pathname = '/acme/demo-shop/src/main' } = {}) {
  const sent = [];
  const body = element();
  const location = { pathname, href: `https://bitbucket.org${pathname}` };
  const state = { now: 0, tick: null, observing: false };
  const chrome = {
    runtime: {
      id: 'extension-id',
      getURL: (path) => `chrome-extension://extension-id/${path}`,
      sendMessage: async (message) => {
        sent.push(message);
        return chrome.answer;
      },
    },
    answer: { opened: true },
  };
  vm.runInNewContext(SOURCE, {
    chrome,
    document: { createElement: element, body, documentElement: body, querySelectorAll: () => [] },
    location,
    performance: { now: () => state.now },
    MutationObserver: class {
      observe() {
        state.observing = true;
      }
      disconnect() {
        state.observing = false;
      }
    },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    setInterval: (callback) => {
      state.tick = callback;
      return 1;
    },
    clearInterval: () => {
      state.tick = null;
    },
    setTimeout: () => 1,
  });
  return {
    chrome,
    sent,
    body,
    location,
    state,
    advance(ms) {
      state.now += ms;
      state.tick?.();
    },
  };
}

// Objects made inside the vm have that realm's prototypes; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

function button(script) {
  const host = script.body.children.find((node) => node.isConnected);
  return host?.shadowRoot.children.find((node) => node.textContent === 'Open report' || node.textContent === 'No build on this page');
}

describe('the fallback button', () => {
  test('on a result page without step tabs, it shows after 3 s, not before', () => {
    const script = load({ pathname: '/acme/demo-shop/pipelines/results/42' });
    assert.equal(button(script), undefined);
    script.advance(2000);
    assert.equal(button(script), undefined, 'not after 2 s');
    script.advance(1000);
    assert.ok(button(script), 'after 3 s');
  });

  test('never on other pages', () => {
    const script = load({ pathname: '/acme/demo-shop/src/main' });
    script.advance(10000);
    assert.equal(script.body.children.length, 0);
  });

  test('goes away when the page leaves the result pages', () => {
    const script = load({ pathname: '/acme/demo-shop/pipelines/results/42' });
    script.advance(3000);
    assert.ok(button(script));
    script.location.pathname = '/acme/demo-shop/src/main';
    script.advance(1000);
    assert.equal(button(script), undefined);
  });

  test('a click a page script made does nothing; a real click asks for the viewer', () => {
    const script = load({ pathname: '/acme/demo-shop/pipelines/results/42' });
    script.advance(3000);
    button(script).fire('click', { isTrusted: false });
    assert.equal(script.sent.length, 0);
    button(script).fire('click', { isTrusted: true });
    assert.deepEqual(plain(script.sent), [{ type: 'open-viewer' }]);
  });

  test('says so when the service worker finds no build to open', async () => {
    const script = load({ pathname: '/acme/demo-shop/pipelines/results/42' });
    script.advance(3000);
    script.chrome.answer = { opened: false };
    button(script).fire('click', { isTrusted: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(button(script).textContent, 'No build on this page');
  });
});

describe('after the extension is reloaded or removed', () => {
  test('the old script stops watching the page and takes its button away', () => {
    const script = load({ pathname: '/acme/demo-shop/pipelines/results/42' });
    script.advance(3000);
    assert.ok(button(script));
    assert.equal(script.state.observing, true);
    script.chrome.runtime.id = undefined;
    script.advance(1000);
    assert.equal(button(script), undefined);
    assert.equal(script.state.observing, false, 'the observer is disconnected');
    assert.equal(script.state.tick, null, 'the timer is cleared');
  });
});
