# Chrome Web Store submission

**1.2.3 was submitted for review on 2026-11-12**, public, free of charge. Its security review is done and its
findings are fixed. 1.1.2 was never submitted.

This file has the text to paste into the Chrome Web Store developer dashboard and the list of what must be decided
first. Each block under "Paste" goes into the dashboard field named above it. Paste a paragraph as one line: the
dashboard keeps every line break, and the `>` that starts each line here is not part of the text. Google's
reviewers read those blocks, so every claim in them matches the code of 1.2.3.

The publisher's contact email must be entered and verified in the dashboard's Settings before an item can be
published.

## Decide before submitting

1. **The name: decided on 2026-11-12.** From 1.1.1 the extension is called "Artifact Viewer for Bitbucket
   Pipelines". Up to 1.1.0 it was "Bitbucket Artifact Viewer", which began with another company's trademark; the
   store's impersonation policy rejects names that suggest a product comes from, or is endorsed by, that company. The
   description says "Not affiliated with or endorsed by Atlassian".
2. **A public page for the privacy policy: done.** The store requires a privacy policy, even though nothing leaves
   the browser. The text under "Privacy policy" below is `PRIVACY.md` at the root of the public repository:
   https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer/blob/main/PRIVACY.md. A change to one goes into the other.
3. **The storage host.** The optional `https://*/*` is justified below, so it can stay. Still, the store names broad
   patterns like this one as a reason for a longer review, and it may judge it wider than needed. Two things would
   make the review faster and safer:
   - after the first trial on real Bitbucket names the storage host, replace `https://*/*` with that host;
   - if that host lets bitbucket.org read the download, `webRequest` and the optional permission can both go.
4. **Visibility: Public, decided on 2026-11-12.** The extension is open source (MIT) and for every Bitbucket user.
   Unlisted (anyone with the link) and Private (chosen users) go through the same review.
5. **Something reviewers can try: done.** `store/sample-artifact.tar.gz` (a made-up test report, no real data) is in
   the public repository: https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer/raw/main/store/sample-artifact.tar.gz. The test instructions below link to it. Reviewers open it with
   "Open a .tar.gz…" from the toolbar icon.
6. **Screenshots and tiles.** They are ready; see "Graphic assets".

## Package

Upload `release/bitbucket-artifact-viewer-1.2.3-store.zip`. Its `manifest.json` is at the root of the zip, as the
store requires. The other zip, `…-1.2.3.zip`, holds one folder and is for "Load unpacked".

## Graphic assets

`node store/make-store-assets.mjs` builds them again after a change to the viewer. They come from the extension as
it is, with the sample report in `store/sample-report/`, and show no real workspace or report.

| Dashboard field | File |
|---|---|
| Screenshots (up to 5) | the 5 in `store/assets/` |
| Small promo tile (440×280) | `store/assets/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `store/assets/promo-marquee-1400x560.png` |

All are PNG without alpha, as the store asks. The store icon comes from the uploaded package.

## Test instructions for reviewers

"Additional instructions" takes at most 500 characters; this is 484. Leave Username and Password empty. Paste:

> No Bitbucket account is needed. 1) Download the sample artifact:
> https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer/raw/main/store/sample-artifact.tar.gz 2) Click the
> extension's toolbar icon on any page, then "Open a .tar.gz…" and choose that file. Its summary opens, the links
> between its pages work, and the folder tree on the left lists its files. On bitbucket.org, a pipeline step with an
> artifact gets an "Artifact viewer" tab next to Build, Metrics and Artifacts.

## Store listing tab

**Summary** (from the manifest, 121 of 132 characters):

> Shows a Bitbucket Pipelines artifact, such as an HTML report, on the pipeline page, without downloading and
> unpacking it.

**Description** (paste):

> Open the artifacts of your Bitbucket Pipelines builds right in the browser, without downloading and unpacking a
> .tar.gz by hand.
>
> - An "Artifact viewer" tab next to Build, Metrics and Artifacts on a pipeline step shows the step's artifact under
>   the tabs. Links between the report's files work, the viewer has its own Back button, and a folder tree lists the
>   artifact's files.
> - The viewer can also open in its own tab, from the panel or from the toolbar icon, and it opens a downloaded
>   .tar.gz from your disk.
> - Every kind of file in an artifact:
>   - HTML reports, with their own stylesheets, images and fonts;
>   - JUnit XML as a test report;
>   - Markdown as a page;
>   - formatted JSON and JSON Lines, and any text file;
>   - images and video;
>   - PDF in Chrome's PDF viewer;
>   - a Download button for any single file.
> - Everything happens in your browser. The artifact is downloaded with your existing Bitbucket session, unpacked
>   in memory, and gone when you close the tab. Nothing is sent to the developer or to anyone else.
> - Reports are shown safely: scripts, forms, pop-ups, frames and plug-ins in a report are switched off, and a
>   report cannot load anything from the network.
>
> Source code (MIT): https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer
>
> Not affiliated with or endorsed by Atlassian. Bitbucket is a trademark of Atlassian.

**Category:** Developer Tools. **Language:** English.

**Homepage URL:** https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer
**Support URL:** https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer/issues
Leave **Official URL** empty (it needs a site verified in Google Search Console) and **Mature content** off.

**Distribution tab:** Free of charge, Public, all regions.

## Privacy practices tab

**Single purpose** (paste):

> Shows the artifacts of Bitbucket Pipelines builds in the browser, either in a tab added to the pipeline step page
> or in the extension's own viewer tab, so that users can read the reports their pipelines produce without
> downloading and unpacking the archive by hand.

**Permission justification: `webRequest`** (paste):

> Used only to observe, never to block or modify, the redirects of the extension's own requests to Bitbucket.
> Bitbucket answers an artifact download with a redirect to its storage service; when that service does not let the
> page read the file, fetch fails without saying where it was sent. The listener is added when the viewer starts a
> request to Bitbucket (the artifact list or the artifact) and removed when that request ends. It is filtered to
> bitbucket.org requests made with fetch, and it keeps only the redirect chain that starts at a request in progress.
> Nothing it sees is stored after the request or sent anywhere.

**Permission justification: `scripting`** (paste):

> Used only when the extension is installed or updated, to add the extension's own packaged content scripts
> (content-fetch.js and content.js, the same files the manifest declares for https://bitbucket.org/*) to the
> bitbucket.org tabs that are already open. Chrome adds declared content scripts only to pages loaded after
> installation, so without this those tabs would show no Artifact viewer tab until the user reloads them. It injects
> no other code, into no other site, and runs nothing from a page or from the network.

**Permission justification: host permissions** (paste). The dashboard has one "Host permission justification"
field for both `https://bitbucket.org/*` and the optional `https://*/*`; this text is 774 of its 1,000 characters.

> https://bitbucket.org/* is the core feature: a content script adds the "Artifact viewer" tab to pipeline step pages
> and shows the viewer under it. The extension reads the open tab's address to know which build to show, and
> downloads that build's artifact list and artifact through the open Bitbucket tab, with the user's session. It reads
> no other Bitbucket data and changes nothing. The optional https://*/* is not granted at install: Bitbucket sends
> each download to a signed storage URL of its own choosing. Only when that host cannot be read does the viewer name
> it and, after the user clicks "Allow and retry", request that single origin with chrome.permissions.request, which
> Chrome asks the user to confirm. It is used only to download that artifact, without cookies.

**Remote code:** choose "No, I am not using remote code" (paste as the justification if asked):

> All code is packaged in the extension. The extension pages' policy is script-src 'self', with no eval and no
> remotely hosted scripts. Artifact files are data: their HTML is shown in a sandboxed frame with scripts disabled.

**Data usage.** Tick these, because the extension handles them, though only locally:
- **Website content.** The artifact's files, from repositories the user can read, and the step tabs of the Bitbucket
  page, are read in the browser to show the report.
- **Web history.** The address of the open bitbucket.org tab is read to know which build to show, and the open
  bitbucket.org tabs are listed to find one to download through.
- **User activity.** This applies while `webRequest` is in the manifest. It observes redirects of the extension's own
  requests to Bitbucket only, while they run.

Do not tick **Authentication information**. Requests carry the browser's existing Bitbucket session, but the
extension never reads, stores or sends a credential.

Tick all three certifications. Nothing is sold, nothing is used or transferred for another purpose, and nothing is
used for creditworthiness or lending.

**Privacy policy URL:** https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer/blob/main/PRIVACY.md

## Privacy policy (text for the public page)

> **Privacy policy of Artifact Viewer for Bitbucket Pipelines**
>
> Artifact Viewer for Bitbucket Pipelines is a Chrome extension that shows the artifacts of Bitbucket Pipelines builds in the browser.
>
> **What it reads.** On bitbucket.org pages, it reads the address of the open tab, to know which pipeline build to
> show, and the page's step tabs, to add its own tab next to them. When you open an artifact, it downloads the list of
> that build's artifacts and the artifact itself, using the Bitbucket session your browser already has. While those
> requests run, it observes where Bitbucket redirects them.
>
> **Where it goes.** The artifact is unpacked in the memory of the viewer page and is gone when that page closes.
> Images, videos and PDFs you open are handed to the browser from that memory; the browser may keep a large one in
> its temporary storage while the viewer is open. The extension stores nothing and keeps no history. It has no
> analytics, tracking or advertising. A file is saved to your disk only when you click Download.
>
> **Who it talks to.** bitbucket.org; the storage host Bitbucket redirects a download to, and only if you allowed that
> host; and websites you choose to open from a link in a report. Nothing is sent to the developer or to any third
> party, and nothing is sold.
>
> **Credentials.** The extension never reads, stores or sends your password, tokens or cookies. The browser attaches
> your existing session to requests to bitbucket.org, and no cookie is sent to the storage host.
>
> **Limited Use.** The use of information received from Google APIs will adhere to the Chrome Web Store User Data
> Policy, including the Limited Use requirements.
>
> **Contact.** Open an issue at https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer/issues.

## After publishing

- Store users install and update from the store. The README's "Install" and "Update" sections describe "Load
  unpacked", so give store users a short note instead.
- After an automatic update, the open bitbucket.org tabs get the new scripts without a reload. A tab that was
  discarded gets them when it loads again.
