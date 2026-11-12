// content-fetch.js, run in a Node vm with a fake chrome and port: who it answers, which URLs it fetches and how
// the bytes travel back.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../extension/content-fetch.js', import.meta.url), 'utf8');
const ID = 'extension-id';
const API = 'https://bitbucket.org/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts';
const UUID = '%7Ba0000000-0000-0000-0000-000000000042%7D';

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

// Loads content-fetch.js on a page at `pathname`. fetchImpl answers the script's fetch calls.
function load({ pathname = '/acme/demo-shop/src/main', fetchImpl = async () => new Response('') } = {}) {
  const connect = [];
  const sent = [];
  const fetched = [];
  const body = element();
  const chrome = {
    runtime: {
      id: ID,
      onConnect: { addListener: (listener) => connect.push(listener) },
      sendMessage: async (message) => {
        sent.push(message);
        return chrome.answer;
      },
    },
    answer: { opened: true },
  };
  vm.runInNewContext(SOURCE, {
    chrome,
    document: { createElement: element, body, documentElement: body },
    location: { pathname },
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    btoa,
    fetch: async (url, init) => {
      fetched.push({ url, init });
      return fetchImpl(url, init);
    },
    URL,
    Uint8Array,
    AbortController,
    DOMException,
  });
  return { chrome, connect, sent, fetched, body };
}

function port({ name = 'bitbucket-fetch', senderId = ID } = {}) {
  const listeners = [];
  const gone = [];
  const posted = [];
  const fake = {
    name,
    sender: { id: senderId },
    disconnected: false,
    posted,
    onMessage: { addListener: (listener) => listeners.push(listener) },
    onDisconnect: { addListener: (listener) => gone.push(listener) },
    postMessage: (message) => posted.push(message),
    disconnect: () => {
      fake.disconnected = true;
    },
    send: (message) => listeners.forEach((listener) => listener(message)),
    // The viewer closes its end.
    close: () => gone.forEach((listener) => listener()),
  };
  return fake;
}

// Sends one request through a fresh port and waits until the script has answered it.
async function request(script, url, accept = null) {
  const fake = port();
  script.connect.forEach((listener) => listener(fake));
  fake.send({ url, accept });
  for (let i = 0; i < 200 && !fake.posted.some((message) => ['end', 'failed', 'broken', 'refused'].includes(message.type)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return fake.posted;
}

// Objects made inside the vm have that realm's prototypes; compare them as plain data.
const plain = (value) => JSON.parse(JSON.stringify(value));

function decode(posted) {
  return Buffer.concat(posted.filter((message) => message.type === 'chunk').map((message) => Buffer.from(message.data, 'base64')));
}

describe('who the content script answers', () => {
  test('a port from another extension, or with another name, is closed and fetches nothing', () => {
    const script = load();
    for (const fake of [port({ senderId: 'another-extension' }), port({ name: 'something-else' })]) {
      script.connect.forEach((listener) => listener(fake));
      fake.send({ url: API });
      assert.equal(fake.disconnected, true);
    }
    assert.deepEqual(script.fetched, []);
  });
});

describe('which URLs it fetches', () => {
  test('the list, any page link of the list and one artifact\'s content, with caching off', async () => {
    const script = load({ fetchImpl: async () => new Response('{"values":[]}', { headers: { 'content-type': 'application/json' } }) });
    const urls = [API, `${API}?page=2`, `${API}?page=2&fields=values.uuid,values.name,next&cursor=a:b`, `${API}/${UUID}/content`];
    for (const url of urls) {
      const posted = await request(script, url, url === API ? 'application/json' : null);
      assert.deepEqual(posted.map((message) => message.type), ['accepted', 'head', 'chunk', 'end'], url);
      assert.equal(posted[1].contentType, 'application/json');
    }
    assert.deepEqual(script.fetched.map((call) => call.url), urls);
    assert.ok(script.fetched.every((call) => call.init.cache === 'no-store'));
    assert.equal(script.fetched[0].init.headers.Accept, 'application/json');
  });

  test('anything else is refused without a request', async () => {
    const script = load();
    for (const url of [
      `${API}/..\\..\\..\\..\\..\\..\\..\\account\\settings\\x/content`,
      'https://bitbucket.org/!api/internal/repositories/acme\\..\\..\\..\\..\\site\\x/r/pipelines/1/artifacts',
      `${API}/%2e%2e/content`,
      `${API}/../content`,
      `${API}/{a0000000-0000-0000-0000-000000000042}/content`,
      `${API}/${UUID}/content?x=1`,
      `${API}#fragment`,
      'https://bitbucket.org/!api/internal/repositories/acme/../pipelines/42/artifacts',
      'https://bitbucket.org/!api/internal/repositories/acme/../../pipelines/42/artifacts',
      'https://bitbucket.org/acme/demo-shop/src/main',
      'http://bitbucket.org/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts',
      'https://evil.example/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts',
      'https://user:pw@bitbucket.org/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts',
      'https://BITBUCKET.ORG/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts',
      `${API.replace('/42/', '/0/')}`,
      42,
      undefined,
    ]) {
      assert.deepEqual(plain(await request(script, url)), [{ type: 'refused' }], String(url));
    }
    assert.deepEqual(plain(script.fetched), []);
  });
});

describe('how the bytes come back', () => {
  test('a large body arrives in 4 MiB pieces and is rebuilt exactly', async () => {
    const bytes = new Uint8Array(9 * 1024 * 1024 + 7).map((_, i) => (i * 31) % 256);
    const script = load({ fetchImpl: async () => new Response(bytes, { status: 200 }) });
    const posted = await request(script, `${API}/${UUID}/content`);
    assert.equal(posted.filter((message) => message.type === 'chunk').length, 3);
    assert.ok(posted.filter((message) => message.type === 'chunk').every((message) => message.data.length < 6 * 1024 * 1024));
    assert.deepEqual(new Uint8Array(decode(posted)), bytes);
    assert.equal(posted.at(-1).type, 'end');
  });

  test('many small reads are gathered into full pieces', async () => {
    const total = 9 * 1024 * 1024 + 7;
    const stream = new ReadableStream({
      start(controller) {
        for (let at = 0; at < total; at += 65536) controller.enqueue(new Uint8Array(Math.min(65536, total - at)).fill(at % 251));
        controller.close();
      },
    });
    const script = load({ fetchImpl: async () => new Response(stream) });
    const posted = await request(script, `${API}/${UUID}/content`);
    const sizes = posted.filter((message) => message.type === 'chunk').map((message) => Buffer.from(message.data, 'base64').length);
    assert.deepEqual(sizes, [4 * 1024 * 1024, 4 * 1024 * 1024, 1024 * 1024 + 7]);
  });

  test('an error status still comes back as a head, and a failed request as "failed"', async () => {
    let script = load({ fetchImpl: async () => new Response('no', { status: 401 }) });
    assert.equal((await request(script, API))[1].status, 401);
    script = load({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
    assert.deepEqual(plain(await request(script, API)), [{ type: 'accepted' }, { type: 'failed' }]);
  });

  test('when the viewer goes away, the download is cancelled and nothing more is sent', async () => {
    let signal = null;
    const script = load({
      fetchImpl: (url, init) => {
        signal = init.signal;
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      },
    });
    const fake = port();
    script.connect.forEach((listener) => listener(fake));
    fake.send({ url: API });
    await new Promise((resolve) => setTimeout(resolve, 10));
    fake.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(signal.aborted, true);
    assert.deepEqual(plain(fake.posted), [{ type: 'accepted' }]);
  });
});
