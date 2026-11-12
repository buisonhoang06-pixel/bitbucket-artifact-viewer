// Builds the Chrome Web Store's graphic assets from the extension as it is, with the sample report in
// store/sample-report:
// - store/sample-artifact.tar.gz, the sample for reviewers ("Open a .tar.gz…");
// - store/assets/screenshot-*.png (1280x800) and promo-*.png (440x280, 1400x560), as PNG without alpha.
// The pipeline page in the first screenshot is the tests' plain stand-in, styled neutrally: no Bitbucket page,
// workspace or data appears. Run from the project folder: node store/make-store-assets.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import { BUILD, launch, waitForFrameText } from '../tests/e2e/fake-bitbucket.mjs';

const STORE = dirname(fileURLToPath(import.meta.url));
// EXTENSION_DIR (as for the e2e tests) makes the images of another build, such as an unzipped release; they then go
// to store/assets-<version>/, and a 1.1.x build gets only what it can show.
const EXTENSION = process.env.EXTENSION_DIR || join(STORE, '..', 'extension');
const MANIFEST = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'));
const NAME = MANIFEST.name;
const KINDS = !MANIFEST.version.startsWith('1.1.');
const OUT = join(STORE, process.env.EXTENSION_DIR ? `assets-${MANIFEST.version}` : 'assets');
const RAW = join(OUT, 'raw');
const SAMPLE = join(STORE, 'sample-artifact.tar.gz');
const SCREEN = { width: 1280, height: 800 };

// The sample archive, made the same way each time.
execFileSync('tar', ['-C', join(STORE, 'sample-report'), '--sort=name', '--owner=0', '--group=0', '--numeric-owner',
  '--mtime=2026-11-12 00:00:00', '-czf', SAMPLE, 'reports', 'logs', 'results']);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(RAW, { recursive: true });

// The stand-in pipeline page, styled like a plain CI page, with a few steps on the left.
const PAGE_STYLE = `
  body { font: 14px/1.4 "Ubuntu", "DejaVu Sans", sans-serif; color: #172b4d; background: #fff; }
  #mock-top { position: fixed; inset: 0 0 auto 0; height: 48px; display: flex; align-items: center; gap: 10px; padding: 0 20px;
    background: #22272b; color: #dee4ea; font-weight: 500; z-index: 1; }
  #steps { box-sizing: border-box; top: 48px; height: calc(100vh - 48px); padding: 20px 16px; background: #f7f8f9;
    border-right: 1px solid #dfe1e6; font-size: 0; }
  #steps p { margin: 0 0 6px; padding: 8px 10px; border-radius: 6px; font-size: 14px; }
  #steps p.current { background: #e9f2ff; color: #0c66e4; font-weight: 600; }
  #pane { padding-top: 72px; }
  #pane h2 { margin: 0 0 12px; font-size: 18px; }
  [aria-label="Log navigation"] a[role="tab"] { color: #44546f; text-decoration: none; padding: 8px 12px; font-weight: 500;
    border-bottom: 2px solid transparent; }
  [aria-label="Log navigation"] a[role="tab"][aria-selected="true"] { color: #0c66e4; border-bottom-color: #0c66e4; }
  #row { border-bottom: 1px solid #dfe1e6; }
  #log { font: 13px/1.5 "Ubuntu Mono", "DejaVu Sans Mono", monospace; padding: 12px; background: #f7f8f9; }
`;

async function shot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(RAW, name) });
}

const browser = await launch({ archive: new Uint8Array(readFileSync(SAMPLE)) });
try {
  // 1. The Artifact viewer tab and its panel on a pipeline step.
  const step = await browser.openBitbucketTab(BUILD.ok);
  await step.setViewportSize(SCREEN);
  await step.addStyleTag({ content: PAGE_STYLE });
  await step.evaluate(() => {
    const top = document.createElement('div');
    top.id = 'mock-top';
    top.textContent = 'demo-shop  ›  Pipelines  ›  #42  ·  main';
    document.body.prepend(top);
    document.getElementById('steps').innerHTML = '<p>✓ Install</p><p>✓ Unit tests</p><p class="current">✓ Test report</p><p>○ Deploy (manual)</p>';
    const title = document.createElement('h2');
    title.textContent = 'Test report';
    document.getElementById('pane').prepend(title);
  });
  await step.locator('a[data-bitbucket-artifact-viewer="tab"]').click();
  await step.locator('[data-bitbucket-artifact-viewer="panel"] iframe').waitFor();
  let frame = null;
  for (let i = 0; i < 200 && !frame; i += 1) {
    frame = step.frame({ url: /embedded=1/ });
    if (!frame) await step.waitForTimeout(25);
  }
  await frame.waitForFunction(() => document.getElementById('frame')?.contentDocument?.querySelector('h1')?.textContent.includes('Test report'));
  await shot(step, 'screenshot-1-artifact-viewer-tab.png');

  // 2. The viewer in its own tab, on the summary, with the artifact's files on the left.
  const viewer = await browser.context.newPage();
  await viewer.setViewportSize(SCREEN);
  await viewer.goto(browser.viewerUrl(`?workspace=acme&repo=demo-shop&build=${BUILD.ok}`));
  await waitForFrameText(viewer, 'h1', 'Test report');
  await shot(viewer, 'screenshot-2-viewer-tab.png');

  // 3. A linked page of the report: the links between the files work.
  const suite = await browser.context.newPage();
  await suite.setViewportSize(SCREEN);
  await suite.goto(browser.viewerUrl(`?workspace=acme&repo=demo-shop&build=${BUILD.ok}#file=${encodeURIComponent('reports/suites/payments.html')}`));
  await waitForFrameText(suite, 'h1', 'payments');
  await shot(suite, 'screenshot-3-linked-page.png');
  if (!KINDS) throw Object.assign(new Error('done'), { done: true });

  // 4. A JUnit file as a test report.
  const junit = await browser.context.newPage();
  await junit.setViewportSize(SCREEN);
  await junit.goto(browser.viewerUrl(`?workspace=acme&repo=demo-shop&build=${BUILD.ok}#file=${encodeURIComponent('results/junit.xml')}`));
  await waitForFrameText(junit, 'h1', 'demo-shop');
  await shot(junit, 'screenshot-4-junit-report.png');

  // 5. Markdown as a page.
  const notes = await browser.context.newPage();
  await notes.setViewportSize(SCREEN);
  await notes.goto(browser.viewerUrl(`?workspace=acme&repo=demo-shop&build=${BUILD.ok}#file=${encodeURIComponent('reports/README.md')}`));
  await waitForFrameText(notes, 'h1', 'Test run notes');
  await shot(notes, 'screenshot-5-markdown-page.png');
} catch (error) {
  if (!error.done) throw error;
} finally {
  await browser.close();
}

// The promo tiles: the owner's icon, the name and what it does.
const icon = `data:image/png;base64,${readFileSync(join(STORE, 'icon-512.png')).toString('base64')}`;
const tile = (width, height, iconSize, titleSize, line, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${width}px; height: ${height}px; overflow: hidden; }
  body { display: flex; align-items: center; gap: ${Math.round(height * 0.09)}px; box-sizing: border-box; padding: 0 ${Math.round(height * 0.12)}px;
    background: linear-gradient(135deg, #0b8f8c 0%, #0b4f6c 55%, #0b2545 100%); color: #fff;
    font-family: "Ubuntu", "DejaVu Sans", sans-serif; }
  img { width: ${iconSize}px; height: ${iconSize}px; flex: none; filter: drop-shadow(0 6px 16px rgba(0,0,0,.35)); }
  h1 { margin: 0 0 ${Math.round(titleSize * 0.35)}px; font-size: ${titleSize}px; line-height: 1.1; font-weight: 700; }
  p { margin: 0; font-size: ${Math.round(titleSize * 0.5)}px; line-height: 1.35; opacity: .92; }
  ul { margin: ${Math.round(titleSize * 0.45)}px 0 0; padding-left: 1.1em; font-size: ${Math.round(titleSize * 0.42)}px; line-height: 1.6; opacity: .92; }
</style></head><body><img src="${icon}" alt=""><div><h1>${NAME}</h1><p>${line}</p>${extra}</div></body></html>`;
const tiles = await chromium.launch({ channel: 'chromium', headless: true });
try {
  for (const [name, width, height, html] of [
    ['promo-small-440x280.png', 440, 280, tile(440, 280, 112, 26, 'Read pipeline reports without downloading them.')],
    ['promo-marquee-1400x560.png', 1400, 560, tile(1400, 560, 280, 58, 'Read your pipeline reports right on the pipeline page.',
      `<ul><li>An Artifact viewer tab next to Build, Metrics and Artifacts</li><li>${KINDS ? 'HTML, JUnit, Markdown, JSON, images, video and PDF' : 'Links between the report’s files work'}</li><li>Everything stays in your browser</li></ul>`)],
  ]) {
    const page = await tiles.newPage({ viewport: { width, height } });
    await page.setContent(html);
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(RAW, name) });
    await page.close();
  }
} finally {
  await tiles.close();
}

// The store wants JPEG or 24-bit PNG without alpha.
const NAMES = ['screenshot-1-artifact-viewer-tab.png', 'screenshot-2-viewer-tab.png', 'screenshot-3-linked-page.png',
  ...(KINDS ? ['screenshot-4-junit-report.png', 'screenshot-5-markdown-page.png'] : []), 'promo-small-440x280.png', 'promo-marquee-1400x560.png'];
for (const name of NAMES) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', join(RAW, name), '-pix_fmt', 'rgb24', join(OUT, name)]);
}
rmSync(RAW, { recursive: true, force: true });
console.log(`assets in ${OUT}; sample in ${SAMPLE}`);
