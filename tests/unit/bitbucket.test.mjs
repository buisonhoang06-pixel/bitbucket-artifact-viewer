import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  artifactsUrl,
  bracedUuid,
  contentUrl,
  httpsHost,
  isTrustedNextUrl,
  looksLikeSignIn,
  normalizeStep,
  parsePipelineUrl,
  pickArtifacts,
  pipelineForViewer,
  readViewerQuery,
  redirectTarget,
  viewerPath,
} from '../../extension/lib/bitbucket.js';

const STEP = '{0b3c7a52-5f6e-4d7a-9c1e-2a8b9d0e1f23}';
const STEP_ENCODED = '%7B0b3c7a52-5f6e-4d7a-9c1e-2a8b9d0e1f23%7D';
const BASE = { workspace: 'acme', repo: 'demo-shop', build: 42 };

describe('parsePipelineUrl', () => {
  test('a result page with and without a step, braces encoded or not, with trailing segments', () => {
    assert.deepEqual(parsePipelineUrl('https://bitbucket.org/acme/demo-shop/pipelines/results/42'), { ...BASE, step: null });
    assert.deepEqual(parsePipelineUrl(`https://bitbucket.org/acme/demo-shop/pipelines/results/42/steps/${STEP_ENCODED}`), { ...BASE, step: STEP });
    assert.deepEqual(parsePipelineUrl(`https://bitbucket.org/acme/demo-shop/pipelines/results/42/steps/${STEP.toUpperCase()}/test-report`), { ...BASE, step: STEP });
    assert.deepEqual(parsePipelineUrl('https://BITBUCKET.ORG/acme/demo-shop/pipelines/results/42/?tab=artifacts#x'), { ...BASE, step: null });
  });

  test('a step that is not a UUID is ignored', () => {
    assert.deepEqual(parsePipelineUrl('https://bitbucket.org/acme/demo-shop/pipelines/results/42/steps/not-a-uuid'), { ...BASE, step: null });
  });

  test('anything else is null', () => {
    for (const href of [
      'https://bitbucket.org/acme/demo-shop/pipelines',
      'https://bitbucket.org/acme/demo-shop/pipelines/results/0',
      'https://bitbucket.org/acme/demo-shop/pipelines/results/abc',
      'https://bitbucket.org/acme/demo-shop/src/main/README.md',
      'http://bitbucket.org/acme/demo-shop/pipelines/results/42',
      'https://bitbucket.org.evil.example/acme/demo-shop/pipelines/results/42',
      'https://evilbitbucket.org/acme/demo-shop/pipelines/results/42',
      'https://api.bitbucket.org/acme/demo-shop/pipelines/results/42',
      'https://evil.example/bitbucket.org/acme/demo-shop/pipelines/results/42',
      'https://bitbucket.org:8443/acme/demo-shop/pipelines/results/42',
      'https://bitbucket.org/acme%20corp/demo-shop/pipelines/results/42',
      'https://bitbucket.org/acme/%2E%2E/pipelines/results/42',
      'https://bitbucket.org/acme/%E0%A4%A/pipelines/results/42',
      'not a url',
      undefined,
    ]) {
      assert.equal(parsePipelineUrl(href), null, String(href));
    }
  });
});

describe('the viewer query', () => {
  test('viewerPath and readViewerQuery are inverses', () => {
    for (const pipeline of [{ ...BASE, step: null }, { ...BASE, step: STEP }]) {
      const path = viewerPath(pipeline);
      assert.ok(path.startsWith('viewer.html?'));
      assert.deepEqual(readViewerQuery(path.slice('viewer.html'.length)), pipeline);
    }
    assert.equal(viewerPath(null), 'viewer.html');
    assert.equal(readViewerQuery(''), null);
  });

  test('the embedded viewer\'s path carries embedded=1, which readViewerQuery ignores', () => {
    const pipeline = { ...BASE, step: STEP };
    const path = viewerPath(pipeline, { embedded: true });
    assert.equal(new URLSearchParams(path.slice('viewer.html?'.length)).get('embedded'), '1');
    assert.deepEqual(readViewerQuery(path.slice('viewer.html'.length)), pipeline);
    assert.equal(new URLSearchParams(viewerPath(pipeline).slice('viewer.html?'.length)).get('embedded'), null);
  });

  test('the artifact shown goes into the address and comes back out, so a new tab opens that artifact', () => {
    const pipeline = { ...BASE, step: null, artifact: '{b0000000-0000-0000-0000-000000000043}' };
    const path = viewerPath(pipeline);
    assert.equal(new URLSearchParams(path.slice('viewer.html?'.length)).get('artifact'), pipeline.artifact);
    assert.deepEqual(readViewerQuery(path.slice('viewer.html'.length)), pipeline);
    assert.equal('artifact' in readViewerQuery(viewerPath({ ...BASE, step: null }).slice('viewer.html'.length)), false);
  });

  test('tampered values mean drop mode', () => {
    for (const search of [
      '?workspace=acme&repo=demo-shop',
      '?workspace=acme&repo=demo-shop&build=-1',
      '?workspace=acme/corp&repo=demo-shop&build=42',
      '?workspace=acme&repo=demo-shop&build=42x',
      '?workspace=acme&repo=..&build=42',
      '?workspace=.&repo=demo-shop&build=42',
      `?workspace=acme&repo=demo-shop&build=42&step=${encodeURIComponent('{nope}')}`,
      '?workspace=acme&repo=demo-shop&build=42&artifact=nope',
    ]) {
      assert.equal(readViewerQuery(search), null, search);
    }
  });
});

describe('endpoint URLs', () => {
  test('artifacts and content', () => {
    assert.equal(artifactsUrl(BASE), 'https://bitbucket.org/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts');
    assert.equal(
      contentUrl(BASE, '{a1b2c3d4-0000-1111-2222-333344445555}'),
      'https://bitbucket.org/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts/%7Ba1b2c3d4-0000-1111-2222-333344445555%7D/content',
    );
  });

  test('a next page is trusted only on the same route', () => {
    assert.equal(isTrustedNextUrl(BASE, `${artifactsUrl(BASE)}?page=2`), true);
    for (const next of [
      'https://bitbucket.org/!api/internal/repositories/acme/demo-shop/pipelines/43/artifacts?page=2',
      'https://bitbucket.org/!api/internal/repositories/other/demo-shop/pipelines/42/artifacts?page=2',
      'https://evil.example/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts?page=2',
      'https://user:pw@bitbucket.org/!api/internal/repositories/acme/demo-shop/pipelines/42/artifacts?page=2',
      `${artifactsUrl(BASE)}/extra`,
      '',
      null,
      'not a url',
    ]) {
      assert.equal(isTrustedNextUrl(BASE, next), false, String(next));
    }
  });
});

describe('pickArtifacts', () => {
  const A = '{aaaaaaaa-0000-1111-2222-333344445555}';
  const B = '{bbbbbbbb-0000-1111-2222-333344445555}';
  const values = [
    { uuid: A, name: 'test-report', step_uuid: STEP.toUpperCase() },
    { uuid: B, name: 'other', step_uuid: '{11111111-2222-3333-4444-555555555555}' },
    { uuid: '..', name: 'not a uuid' },
    { uuid: '{a}', name: 'not a uuid either' },
    { name: 'no uuid' },
    null,
  ];

  test('keeps artifacts whose uuid is a UUID; for a step, only that step\'s, even when that is none', () => {
    assert.deepEqual(pickArtifacts(values, null).map((item) => item.uuid), [A, B]);
    assert.deepEqual(pickArtifacts(values, STEP).map((item) => item.uuid), [A]);
    assert.deepEqual(pickArtifacts(values, '{99999999-2222-3333-4444-555555555555}'), []);
    assert.deepEqual(pickArtifacts(undefined, null), []);
  });

  test('a uuid without braces, or with spaces around it, is kept in its "{...}" form', () => {
    const plainUuid = [{ uuid: ' aaaaaaaa-0000-1111-2222-333344445555 ', name: 'x' }, { uuid: 'BBBBBBBB-0000-1111-2222-333344445555', name: 'y' }];
    assert.deepEqual(pickArtifacts(plainUuid, null).map((item) => item.uuid), [A, '{BBBBBBBB-0000-1111-2222-333344445555}']);
    assert.equal(bracedUuid('{Ab0b0b0b-0000-1111-2222-333344445555}'), '{Ab0b0b0b-0000-1111-2222-333344445555}');
    assert.equal(bracedUuid('nope'), null);
  });

  test('normalizeStep', () => {
    assert.equal(normalizeStep(STEP.toUpperCase()), STEP);
    assert.equal(normalizeStep(STEP.slice(1, -1)), STEP);
    assert.equal(normalizeStep(''), null);
    assert.equal(normalizeStep('{nope}'), null);
  });
});

describe('pipelineForViewer (the service worker\'s decision)', () => {
  const ID = 'extension-id';
  const PAGE = 'https://bitbucket.org/acme/demo-shop/pipelines/results/42';
  const sender = (extra = {}) => ({ id: ID, frameId: 0, url: 'https://bitbucket.org/acme/demo-shop/pipelines', tab: { url: `${PAGE}/steps/${STEP_ENCODED}` }, ...extra });

  test('uses the tab\'s current address, not the address the page was loaded with', () => {
    assert.deepEqual(pipelineForViewer({ type: 'open-viewer' }, sender(), ID), { ...BASE, step: STEP });
  });

  test('answers only this extension, the top frame, a tab and the right message', () => {
    assert.equal(pipelineForViewer({ type: 'open-viewer' }, sender({ id: 'another-extension' }), ID), null);
    assert.equal(pipelineForViewer({ type: 'open-viewer' }, sender({ frameId: 3 }), ID), null);
    assert.equal(pipelineForViewer({ type: 'open-viewer' }, sender({ tab: undefined }), ID), null);
    assert.equal(pipelineForViewer({ type: 'something-else' }, sender(), ID), null);
    assert.equal(pipelineForViewer(null, sender(), ID), null);
    assert.equal(pipelineForViewer({ type: 'open-viewer' }, null, ID), null);
  });

  test('the embedded-viewer message gets the same answer and the same checks', () => {
    assert.deepEqual(pipelineForViewer({ type: 'embedded-viewer' }, sender(), ID), { ...BASE, step: STEP });
    assert.equal(pipelineForViewer({ type: 'embedded-viewer' }, sender({ id: 'another-extension' }), ID), null);
    assert.equal(pipelineForViewer({ type: 'embedded-viewer' }, sender({ frameId: 1 }), ID), null);
    assert.equal(pipelineForViewer({ type: 'embedded-viewer' }, sender({ tab: { url: 'https://bitbucket.org/a/b/src' } }), ID), null);
  });

  test('a page that is not a pipeline result, even if the message claims one', () => {
    const message = { type: 'open-viewer', url: PAGE };
    assert.equal(pipelineForViewer(message, sender({ tab: { url: 'https://bitbucket.org/acme/demo-shop/src' } }), ID), null);
  });
});

describe('redirects and sign-in pages', () => {
  const START = `${artifactsUrl(BASE)}/%7Baaaaaaaa-0000-1111-2222-333344445555%7D/content`;

  test('redirectTarget follows hops on bitbucket.org to the first other host', () => {
    const hops = new Map([
      [START, 'https://bitbucket.org/hop/1'],
      ['https://bitbucket.org/hop/1', 'https://bitbucket.org/hop/2'],
      ['https://bitbucket.org/hop/2', 'https://bucket.s3.amazonaws.com/a.tar.gz?X-Amz-Signature=x'],
    ]);
    assert.equal(redirectTarget(hops, START), 'https://bucket.s3.amazonaws.com/a.tar.gz?X-Amz-Signature=x');
    assert.equal(redirectTarget(new Map([[START, 'https://bitbucket.org/hop/1']]), START), null, 'a chain that never leaves bitbucket.org');
    assert.equal(redirectTarget(new Map(), START), null);
    const loop = new Map([[START, 'https://bitbucket.org/a'], ['https://bitbucket.org/a', START]]);
    assert.equal(redirectTarget(loop, START), null, 'a loop ends');
  });

  test('looksLikeSignIn', () => {
    assert.equal(looksLikeSignIn('https://id.atlassian.com/login?continue=x'), true);
    assert.equal(looksLikeSignIn('https://bitbucket.org/account/signin/?next=/x'), true);
    assert.equal(looksLikeSignIn('https://bitbucket.org/socialauth/login/atlassianid/'), true);
    assert.equal(looksLikeSignIn('https://bucket.s3.amazonaws.com/a.tar.gz'), false);
    assert.equal(looksLikeSignIn('not a url'), false);
  });

  test('httpsHost', () => {
    assert.equal(httpsHost('https://bucket.s3.amazonaws.com/a?b'), 'bucket.s3.amazonaws.com');
    assert.equal(httpsHost('http://bucket.s3.amazonaws.com/a'), null);
    assert.equal(httpsHost('nope'), null);
  });
});
