# Artifact Viewer for Bitbucket Pipelines

A Chrome extension that shows a Bitbucket Pipelines artifact right on the pipeline page, in an **Artifact viewer** tab
next to Build, Metrics and Artifacts. You no longer download the `.tar.gz`, unpack it and look for the right HTML
file. It opens the artifact's main page, such as a test or coverage report, and the links between the artifact's
files work as on a website.

## Install

1. Unzip `bitbucket-artifact-viewer-<version>.zip`. You get a folder of the same name that holds `manifest.json`.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose that folder.
5. Optional: pin the extension from the puzzle-piece menu so its icon stays in the toolbar.
Keep the folder where it is. Chrome loads the extension from it. The bitbucket.org tabs that are already open get
the Artifact viewer tab without a reload.

## Use

- **From a pipeline step.** Open a pipeline result on bitbucket.org and choose a step that keeps artifacts. The
  address looks like `https://bitbucket.org/<workspace>/<repo>/pipelines/results/<number>/steps/...`. Click
  **Artifact viewer**, after **Artifacts**. The artifact's main page shows under the tabs: its shallowest HTML file,
  `index.html` first.
  - Links to other files of the artifact open inside the viewer. The viewer's own **Back** returns to the previous
    file; the browser's Back button still belongs to Bitbucket.
  - **Open in new tab** opens the file you are looking at in a full browser tab.
  - The report has the panel's whole width. **Files** shows the artifact's files as a folder tree, and hides it
    again. A click on a folder closes or opens it. A name too long for its row ends in "…"; hover over it to see the
    full path. In a full tab, the tree is always on the left.
  - When a step has several artifacts, the viewer asks which one to open. When the step keeps none, it says so and
    lists the artifacts of the build's other steps; it downloads one only when you choose it.
  - Click **Build**, **Metrics** or **Artifacts** to go back to Bitbucket's view. Moving to another step or build
    closes the report too.
- **Where there are no step tabs.** If a pipeline page has no Build, Metrics and Artifacts tabs, an **Open report**
  button appears at the bottom right after a few seconds. It opens the viewer in a new tab.
- **From the toolbar icon.** On a pipeline page, the icon opens that build in a new tab. On any other page it opens
  the viewer for a downloaded file.
- **A downloaded artifact.** Drop the `.tar.gz` on the viewer, or click **Open a .tar.gz…**.

What each file shows as:
- **HTML** shows as a page, with its scripts switched off.
- **Markdown** shows as a page, with headings, lists, code, links, images and tables. HTML written inside a
  Markdown file shows as text. **Raw** shows the source.
- **Text files** show as text, whatever their extension: logs, patches, code and the rest.
- **JSON and JSON Lines** show formatted, with numbers and keys exactly as the file has them. For JSON Lines, each
  record sits under its line number. **Raw** on the bar above the file shows them as they are.
- **Images** show in the viewer: png, jpeg, gif, webp, bmp, ico, avif and svg. An SVG shows as a picture, so
  anything active in it stays off.
- **Videos** play in the viewer: mp4 and webm.
- **A PDF** gets **Open PDF**, which shows it in Chrome's PDF viewer, in a new tab.
- **JUnit XML**, the test results most test tools write, shows as a test report: totals, suites, cases, failures
  and output. **Raw** shows the XML. XML that declares a DOCTYPE, or that does not parse, shows as text.
- **Any other file** says it cannot be shown here.

The kind of a file comes from its content where that matters: a file named `.png` or `.pdf` that holds something
else is shown as text, or not at all, never as what its name claims.

Size limits for these kinds: an image up to 20 MB, a video up to 200 MB, a PDF up to 100 MB. Anything larger can
still be saved with Download.

The bar above each file names it and has **Download**, which saves that one file, so there is no need to download
and unpack the whole artifact.

The viewer downloads the artifact through the Bitbucket tab, which carries your Bitbucket session, so keep that
tab open until the report appears. Bitbucket deletes artifacts 14 days after the step that made them.

Size limits:
- an artifact can unpack to at most 512 MB, and Bitbucket's own size for it is checked before it is downloaded;
- an artifact can hold at most 50,000 entries (files, folders and the archive's own records), and a file name can
  be at most 4,096 characters long;
- a text file longer than 2 MB shows its first 2 MB, and a Markdown or JSON file larger than 2 MB shows as text;
- an HTML file larger than 5 MB is not shown;
- a JUnit file larger than 5 MB, or with more than 20,000 cases or suites, shows as its XML.

## What it may do, and what it does not

- **Access to bitbucket.org.** This is what adds the Artifact viewer tab and the button. It also lets the extension read
  two things with your session: the list of a build's artifacts and an artifact's content. It reads nothing else.
- **Adding its scripts to open tabs** (the `scripting` permission). When the extension is installed or updated, it adds
  its own two scripts to the bitbucket.org tabs that are already open, the same scripts Chrome adds to every
  bitbucket.org page loaded later. Without it, those tabs would need a reload.
- **Changes to Bitbucket's page.** The extension adds the Artifact viewer tab and, while the report is open, the panel
  under the tabs. While the panel is open, the tab that was selected looks unselected; it gets its look back when the
  panel closes. Nothing else on the page changes.
- **Observing web requests** (the `webRequest` permission). Only while it downloads a build's artifact list or an
  artifact, the viewer watches where Bitbucket redirects that request, so that it can name the storage host. It
  blocks and changes nothing, and it keeps nothing once the request is done.
- **Optional access to a storage host.** If that host refuses the download, the viewer names it and offers
  **Allow and retry**, in the viewer's own tab only: inside the Artifact viewer panel it offers **Open in new tab**
  instead. Once you allow the host, Chrome keeps that access for the extension. If you refuse, the viewer offers to
  ask again. The extension asks for no other host, and it sends no cookie to that host.
- **Nothing leaves your browser.**
  - The artifact is unpacked in the viewer tab's memory and is gone when you close the tab.
  - It is downloaded with caching turned off, and nothing is sent anywhere.
  - The extension writes nothing to disk except a file you save with **Download**, which Chrome saves like any
    other download.
  - An image, a video or a PDF you open is handed to Chrome as a blob, from memory. Chrome may keep a large one in
    its temporary storage while the viewer is open, as it may for a download.
- **Nothing in the report runs.** Scripts, forms and pop-ups are switched off. Frames and plug-ins inside a report
  are removed. The report cannot load anything from the network or open connections, and its frame cannot be sent to
  another address. A link to a website opens in a new tab.

## When something goes wrong

| The viewer says | What to do |
|---|---|
| Open this build from its Bitbucket page | Open the pipeline on bitbucket.org in the same Chrome profile, keep the tab open, and click **Retry**. |
| Reload the Bitbucket tab | The Bitbucket tab was opened before the extension was installed or updated. Reload it, then click **Retry**. |
| Bitbucket did not accept your session | Sign in to bitbucket.org in this Chrome profile, then click **Retry**. |
| The artifact is no longer available | The artifact is more than 14 days old. Run the pipeline again. |
| Bitbucket keeps this file on https://… | Click **Allow and retry**, then allow the host when Chrome asks. In the Artifact viewer panel, click **Open in new tab** first: the host is allowed from the viewer's own tab. |
| The storage host refused the download | Click **Retry**. Bitbucket then issues a new signed address. |
| https://… could not be reached | The storage host did not answer. Check your connection, then click **Retry**. |
| The download through the Bitbucket tab stopped | The Bitbucket tab was closed or reloaded during the download. Click **Retry**. |
| The Bitbucket tab stopped answering | Nothing came from the Bitbucket tab for a minute. Reload that tab, then click **Retry**. |
| The artifact is too large to open here | Download it from Bitbucket and unpack it yourself. |
| The archive has more than 50,000 entries, or a name longer than 4,096 characters | The viewer does not open archives like that. Download the artifact and unpack it yourself. |
| This build has no artifacts | That build's steps kept no files. |
| Bitbucket answered in an unexpected way | Bitbucket may have changed how it serves artifacts. Download the artifact, drop it on the viewer, and tell whoever maintains the extension. |
| … could not be opened | The file is not a `.tar.gz`. The message says what it is instead, such as a sign-in page. |

More cases:

- **No Artifact viewer tab.** The tab shows only on a pipeline step, next to Artifacts, once the step has artifacts.
  Tabs that were open when the extension was installed or updated get it within a second; if one does not, reload it. If Bitbucket has changed its tabs, the
  **Open report** button appears at the bottom right instead; please tell whoever maintains the extension.
- **The tab or the button says "No build on this page".** The address is not one the extension can read. Open the
  pipeline result again from Bitbucket's list of pipelines.
- **"Expand all" and similar buttons in a report do nothing.** Those buttons are scripts, and scripts are switched
  off. Click a section's title to open it.
- **A report looks unstyled, or has broken images.**
  - A report's own stylesheets, images and fonts load from the artifact, up to 500 files or 50 MB per page.
  - A stylesheet, image or font the report loads from a website does not load, because the viewer reaches no network
    for a report.
  - Neither does one that is missing from the artifact.
  - Scripts stay off, so a part of the report that a script draws stays empty.

## Update

Each version unzips to its own folder, and Chrome treats a new folder as a new extension. So:

1. On `chrome://extensions`, click **Remove** on the old copy. Up to 1.1.0 it was called **Bitbucket Artifact
   Viewer**; from 1.1.1 it is **Artifact Viewer for Bitbucket Pipelines**.
2. Unzip the new version and load its folder with **Load unpacked**.

The new copy asks again for a storage host the first time it needs one.

## Changes

- **1.2.5.** On a step that keeps no artifacts, the viewer no longer downloads another step's artifact, such as a
  large `node_modules` kept for a later step. It says the step keeps none and lists the build's other artifacts to
  choose from.
- **1.2.4.** The Artifact viewer tab no longer stays between Build and Metrics when Bitbucket takes a step's Artifacts
  tab away, as on a step that is still running. It comes back after Artifacts once the step has them.
- **1.2.3.** The bitbucket.org tabs that are open when the extension is installed or updated get the Artifact viewer
  tab without a reload, and the viewer can download through them.
- **1.2.2.** In the file tree, a name too long for its row ends in "…", and hovering over it shows the full path.
- **1.2.1.** For everyone who uses Bitbucket Pipelines, not one project's layout:
  - the tab is now called **Artifact viewer** (it was **Eval report**);
  - **Files** shows the artifact as a folder tree, with folders that open and close and an icon for each kind of
    file;
  - the file opened first is the shallowest HTML file, `index.html` first; of pages with the same name, the one in
    the newest folder.

  Fixes from a security review:
  - a crafted XML, Markdown or stylesheet file can no longer freeze the viewer;
  - in Markdown, a link whose text holds code or an image (a badge) shows that text, and nothing written in a link's
    address or title can add to the page;
  - JSON shows large numbers and repeated keys as the file has them;
  - a JUnit report never shows fewer failures than its cases list;
  - an image used many times on a page counts once toward the page's 500 files;
  - a `srcset` with a `data:` image is left as it is.
- **1.2.0.** Every kind of file in an artifact:
  - any text file, whatever its extension;
  - JSON and JSON Lines formatted, with **Raw**;
  - Markdown as a page;
  - JUnit XML as a test report;
  - images and video in the viewer;
  - PDF in Chrome's PDF viewer;
  - an HTML report's own stylesheets, images and fonts from the artifact;
  - a **Download** button for every file.

  The file opened first is the HTML file nearest the top.
- **1.1.2.** While a step is queued or running, its tabs have no Artifacts yet. The extension now waits for that
  tab instead of showing the **Open report** button; the tab appears when the step's artifacts do.
- **1.1.1.** Renamed to **Artifact Viewer for Bitbucket Pipelines**, for the Chrome Web Store: the extension is not
  made by Atlassian. After the first trial on Bitbucket:
  - the panel covers the whole step, beside Bitbucket's toolbar too;
  - the report has the panel's width, and **Files** shows the list of files;
  - a spinner and a bar that fills as the artifact arrives take the place of the "Downloading…" text;
  - the tab shows the hand cursor.
- **1.1.0.** The report opens in a tab of its own on the pipeline step, called **Eval report** up to 1.2.0, with its
  own **Back** and **Open in new tab**. The **Open report** button now appears only on pages without step tabs. The extension has its own icon.
- **1.0.1.** First version shared with the team: the **Open report** button opens the artifact in a new tab.
