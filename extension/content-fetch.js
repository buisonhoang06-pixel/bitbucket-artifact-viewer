// Runs on bitbucket.org and fetches artifacts for the viewer. A request from this page is same-origin, so it carries
// the Bitbucket session the way Bitbucket's own web app does, whatever the cookie's SameSite setting; Chrome does not
// send a SameSite=Lax cookie with a request made by the extension itself.
(() => {
  // Bytes go to the viewer in pieces well under Chrome's 64 MiB message limit (base64 adds a third).
  const CHUNK_BYTES = 4 * 1024 * 1024;

  // The only requests made for the viewer: a build's artifact list (any query, for its page links) and one
  // artifact's content. The address must already be in its normal form, so that nothing like "..", "%2e" or "\" can
  // move it off those two paths.
  const NAME = '(?!\\.+/)[A-Za-z0-9._-]+';
  const BUILD = '[1-9][0-9]{0,9}';
  const UUID = '%7B[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}%7D';
  const LIST_PATH = new RegExp(`^/!api/internal/repositories/${NAME}/${NAME}/pipelines/${BUILD}/artifacts$`);
  const CONTENT_PATH = new RegExp(`^/!api/internal/repositories/${NAME}/${NAME}/pipelines/${BUILD}/artifacts/${UUID}/content$`);

  function isArtifactRequest(raw) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return false;
    }
    if (url.href !== raw || url.origin !== 'https://bitbucket.org' || url.username || url.password || url.hash) return false;
    if (CONTENT_PATH.test(url.pathname)) return url.search === '';
    return LIST_PATH.test(url.pathname);
  }

  // The viewer opens a port and sends { url, accept } once. It gets "accepted" at once (or "refused" for any other
  // address), then "head", "chunk"s and "end"; or "failed" when the request could not be made or followed, for
  // example after a redirect to a host that refuses CORS. When the viewer goes away, the download stops.
  // The newest copy in this page answers. The extension adds this script to the bitbucket.org tabs that are open
  // when it is installed or updated (see background.js), so a tab still loading then may get the manifest's copy
  // too; two copies answering one port would send every piece twice.
  const generation = (globalThis.artifactViewerFetchGeneration ?? 0) + 1;
  globalThis.artifactViewerFetchGeneration = generation;

  chrome.runtime.onConnect.addListener((port) => {
    if (globalThis.artifactViewerFetchGeneration !== generation) return;
    if (port.name !== 'bitbucket-fetch' || port.sender?.id !== chrome.runtime.id) {
      port.disconnect();
      return;
    }
    const stop = new AbortController();
    port.onDisconnect.addListener(() => stop.abort());
    port.onMessage.addListener((message) => {
      relay(port, message, stop.signal);
    });
  });

  // A redirect to another host is followed without credentials (same-origin mode), so a signed storage address
  // works if that host allows bitbucket.org. Caching is off, so the artifact is not kept on disk.
  async function relay(port, message, signal) {
    if (typeof message?.url !== 'string' || !isArtifactRequest(message.url)) {
      post(port, { type: 'refused' });
      return;
    }
    post(port, { type: 'accepted' });
    let response;
    try {
      response = await fetch(message.url, { cache: 'no-store', signal, headers: message.accept ? { Accept: message.accept } : {} });
    } catch {
      if (!signal.aborted) post(port, { type: 'failed' });
      return;
    }
    post(port, { type: 'head', status: response.status, contentType: response.headers.get('content-type') ?? '' });
    try {
      if (response.body) {
        const reader = response.body.getReader();
        let pending = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (value?.length) {
            pending.push(value);
            size += value.length;
          }
          // Small reads are gathered until a piece is full; a large block handed over at once is cut into pieces.
          if (size >= CHUNK_BYTES || (done && size)) {
            let all = pending.length === 1 ? pending[0] : join(pending, size);
            while (all.length >= CHUNK_BYTES || (done && all.length)) {
              const piece = all.subarray(0, CHUNK_BYTES);
              post(port, { type: 'chunk', data: toBase64(piece) });
              all = all.subarray(piece.length);
            }
            pending = all.length ? [all] : [];
            size = all.length;
          }
          if (done) break;
        }
      }
      post(port, { type: 'end' });
    } catch {
      if (!signal.aborted) post(port, { type: 'broken' });
    }
  }

  function join(parts, size) {
    const out = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  function post(port, message) {
    try {
      port.postMessage(message);
    } catch {
      // the viewer went away
    }
  }

  // Extension messages carry JSON, so the bytes travel as base64.
  function toBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
})();
