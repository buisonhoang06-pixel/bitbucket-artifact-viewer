// Opens the viewer for the "Open report" button and for the toolbar icon, and gives the Artifact viewer tab the
// embedded viewer's path.
import { VIEWER_MESSAGES, parsePipelineUrl, pipelineForViewer, viewerPath } from './lib/bitbucket.js';

// The decision is pipelineForViewer's: only this extension's content script, in a tab's top frame, with the tab's
// current address as Chrome reports it.
// - "open-viewer" opens a viewer tab and answers whether it did.
// - "embedded-viewer" answers with the embedded viewer's path, or null. The content script turns the path into a URL
//   with chrome.runtime.getURL and shows it in a frame, which the manifest allows on bitbucket.org only.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!VIEWER_MESSAGES.has(message?.type)) return undefined;
  const pipeline = pipelineForViewer(message, sender, chrome.runtime.id);
  if (message.type === 'embedded-viewer') {
    sendResponse({ path: pipeline ? viewerPath(pipeline, { embedded: true }) : null });
    return undefined;
  }
  if (pipeline) openViewer(pipeline, sender.tab);
  sendResponse({ opened: Boolean(pipeline) });
  return undefined;
});

// On a pipeline page the icon opens that build; anywhere else it opens the viewer for a downloaded file.
// tab.url is readable only on bitbucket.org, where the extension has host access.
chrome.action.onClicked.addListener((tab) => {
  openViewer(parsePipelineUrl(tab.url), tab);
});

// Chrome adds the manifest's content scripts only to pages loaded after the extension is installed or updated. The
// bitbucket.org tabs open at that moment get them here, so that they need no reload: the Artifact viewer tab appears,
// and the viewer can download through them. A copy left by the previous version stops by itself (see the generation
// in content.js and content-fetch.js). A tab that cannot take them, such as a discarded one, gets them when it loads.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install' && reason !== 'update') return;
  chrome.tabs.query({ url: 'https://bitbucket.org/*' }).then((tabs) => {
    for (const tab of tabs) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content-fetch.js', 'content.js'] }).catch(() => {});
    }
  });
});

function openViewer(pipeline, tab) {
  chrome.tabs
    .create({ url: chrome.runtime.getURL(viewerPath(pipeline)), index: tab.index + 1, openerTabId: tab.id })
    .catch((error) => console.warn('The viewer could not be opened:', error.message));
}
