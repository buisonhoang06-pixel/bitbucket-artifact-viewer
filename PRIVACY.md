# Privacy policy of Artifact Viewer for Bitbucket Pipelines

Artifact Viewer for Bitbucket Pipelines is a Chrome extension that shows the artifacts of Bitbucket Pipelines builds
in the browser.

**What it reads.** On bitbucket.org pages, it reads the address of the open tab, to know which pipeline build to
show, and the page's step tabs, to add its own tab next to them. When you open an artifact, it downloads the list of
that build's artifacts and the artifact itself, using the Bitbucket session your browser already has. While those
requests run, it observes where Bitbucket redirects them.

**Where it goes.** The artifact is unpacked in the memory of the viewer page and is gone when that page closes.
Images, videos and PDFs you open are handed to the browser from that memory; the browser may keep a large one in
its temporary storage while the viewer is open. The extension stores nothing and keeps no history. It has no
analytics, tracking or advertising. A file is saved to your disk only when you click Download.

**Who it talks to.** bitbucket.org; the storage host Bitbucket redirects a download to, and only if you allowed that
host; and websites you choose to open from a link in a report. Nothing is sent to the developer or to any third
party, and nothing is sold.

**Credentials.** The extension never reads, stores or sends your password, tokens or cookies. The browser attaches
your existing session to requests to bitbucket.org, and no cookie is sent to the storage host.

**Limited Use.** The use of information received from Google APIs will adhere to the Chrome Web Store User Data
Policy, including the Limited Use requirements.

**Contact.** Open an issue at https://github.com/buisonhoang06-pixel/bitbucket-artifact-viewer/issues.

Last updated: 2026-11-12.
