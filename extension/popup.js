// The toolbar menu: the viewer for the build of the tab in front or for a downloaded file, a thank-you with the link
// to support the project, and the link to report a problem. The links open in a new tab only when clicked.
import { parsePipelineUrl, viewerPath } from './lib/bitbucket.js';

const $ = (id) => document.getElementById(id);
$('version').textContent = `v${chrome.runtime.getManifest().version}`;

// The address of the tab in front is readable only on bitbucket.org, where the extension has host access; anywhere
// else it is undefined, and the menu offers the viewer for a downloaded file only.
let tab = null;
try {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
} catch {
  tab = null;
}
const pipeline = parsePipelineUrl(tab?.url);
if (pipeline) {
  $('open-build').textContent = `Open the artifacts of build #${pipeline.build}`;
  $('open-build').hidden = false;
  $('open-build').addEventListener('click', () => openViewer(pipeline));
}
$('open-viewer').classList.toggle('primary', !pipeline);
$('open-viewer').addEventListener('click', () => openViewer(null));

// The viewer opens next to the tab in front, which it downloads through for a build.
function openViewer(target) {
  chrome.tabs
    .create({ url: chrome.runtime.getURL(viewerPath(target)), ...(tab ? { index: tab.index + 1, openerTabId: tab.id } : {}) })
    .then(() => window.close(), (error) => console.warn('The viewer could not be opened:', error.message));
}
