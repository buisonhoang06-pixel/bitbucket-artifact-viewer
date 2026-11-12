// Runs on bitbucket.org. On a pipeline step it adds an "Artifact viewer" tab after Bitbucket's Build, Metrics and
// Artifacts tabs; the tab shows the build's artifact in a panel under the tab row. Where no tab bar is found, the
// floating "Open report" button of 1.0 stands in. The artifact requests are made by content-fetch.js.
//
// The tab bar is found by role and text, never by class: Bitbucket's class names are generated. Bitbucket renders
// the bar with React, so this script adds one node of its own (the tab) and puts it back when a re-render drops it.
// The only native nodes it touches are the selected tab's class and aria attributes. It restores them when the panel
// closes: in the capture phase of a click on another tab, before Bitbucket handles it, or after a move that Bitbucket
// made itself, unless Bitbucket has selected another tab by then.
(() => {
  const RESULT_PAGE = /^\/[^/]+\/[^/]+\/pipelines\/results\/\d+(?:\/|$)/;
  const MARK = 'data-bitbucket-artifact-viewer';
  const TAB_LABEL = 'Artifact viewer';
  const FALLBACK_DELAY_MS = 3000;

  // The newest copy in this page wins. The extension adds this script to the bitbucket.org tabs that are open when
  // it is installed or updated (see background.js), so a tab still loading then may get the manifest's copy too, and
  // a copy left by the previous version may share this world. An older copy stops at its next check.
  const generation = (globalThis.artifactViewerTabGeneration ?? 0) + 1;
  globalThis.artifactViewerTabGeneration = generation;
  const superseded = () => globalThis.artifactViewerTabGeneration !== generation;

  let tab = null; // { wrapper, link, label (text node), bar }
  let open = null; // { path, native, panel, raf }
  let floating = null; // the fallback button's host element
  let barMissingSince = null;
  let checkQueued = false;

  function contextAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  // --- The tab -------------------------------------------------------------------------------------------------

  // Bitbucket's visible "Log navigation" group, found by its "Build" tab outside the hidden measuring copy, and the
  // wrapper of its "Artifacts" tab. A step has that tab only once its artifacts exist. While the step is queued or
  // running, the bar has Build and Metrics only: the bar is there, and the Artifact viewer tab waits for Artifacts.
  function findTabBar() {
    for (const link of document.querySelectorAll('a[role="tab"]')) {
      if (link.hasAttribute(MARK) || link.textContent.trim() !== 'Build' || link.closest('[aria-hidden="true"]')) continue;
      const bar = link.closest('[role="group"]');
      if (!bar) continue;
      let wrapper = nativeTabs(bar).find((other) => other.textContent.trim() === 'Artifacts') ?? null;
      while (wrapper?.parentElement && wrapper.parentElement !== bar) wrapper = wrapper.parentElement;
      return { bar, wrapper };
    }
    return null;
  }

  function nativeTabs(bar) {
    return [...bar.querySelectorAll('a[role="tab"]')].filter((link) => !link.hasAttribute(MARK));
  }

  function unselectedClass(bar) {
    return nativeTabs(bar).find((link) => link.getAttribute('aria-selected') !== 'true')?.className ?? null;
  }

  // A copy of the Artifacts tab, so that it looks like Bitbucket's own, with a new text and no link.
  function insertTab({ bar, wrapper }) {
    const copy = wrapper.cloneNode(true);
    const link = copy.matches('a[role="tab"]') ? copy : copy.querySelector('a[role="tab"]');
    for (const name of ['href', 'target', 'aria-current', 'id', 'data-testid']) link.removeAttribute(name);
    link.setAttribute('role', 'tab');
    link.setAttribute('aria-selected', 'false');
    link.setAttribute('tabindex', '0');
    link.setAttribute(MARK, 'tab');
    // A link without href gets the arrow cursor; Bitbucket's tabs get the hand from their href.
    link.style.cursor = 'pointer';
    link.className = unselectedClass(bar) ?? link.className;
    const label = textNode(link, 'Artifacts');
    if (label) label.nodeValue = label.nodeValue.replace('Artifacts', TAB_LABEL);
    link.addEventListener('click', activate);
    link.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') activate(event);
    });
    wrapper.after(copy);
    bar.addEventListener('click', onBarClick, true);
    tab = { wrapper: copy, link, label, bar };
  }

  function textNode(root, text) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.trim() === text) return node;
    }
    return null;
  }

  function removeTab() {
    if (!tab) return;
    tab.bar.removeEventListener('click', onBarClick, true);
    tab.wrapper.remove();
    tab = null;
  }

  // Only a real click or key press counts, and Bitbucket never sees it.
  function activate(event) {
    if (!event.isTrusted) return;
    event.preventDefault();
    event.stopPropagation();
    if (!open && contextAlive()) openPanel();
  }

  // A click on one of Bitbucket's tabs closes the panel first, so that the native tab's look is restored before
  // Bitbucket handles the click.
  function onBarClick(event) {
    const link = event.target?.closest?.('a[role="tab"]');
    if (open && link && !link.hasAttribute(MARK)) closePanel();
  }

  // --- The panel -----------------------------------------------------------------------------------------------

  async function openPanel() {
    const { bar, link } = tab;
    const selected = nativeTabs(bar).find((other) => other.getAttribute('aria-selected') === 'true') ?? null;
    const state = {
      // The route the panel belongs to. Each Bitbucket tab and step is its own path; a query or a hash on the same
      // path does not leave it.
      path: location.pathname,
      native: selected && {
        link: selected,
        className: selected.className,
        selected: selected.getAttribute('aria-selected'),
        current: selected.getAttribute('aria-current'),
      },
      panel: null,
      raf: 0,
    };
    open = state;
    if (selected) {
      link.className = selected.className;
      selected.className = unselectedClass(bar) ?? selected.className;
      selected.setAttribute('aria-selected', 'false');
      selected.removeAttribute('aria-current');
    }
    link.setAttribute('aria-selected', 'true');

    let answer = null;
    try {
      answer = await chrome.runtime.sendMessage({ type: 'embedded-viewer' });
    } catch {
      answer = null;
    }
    if (open !== state) return;
    if (!answer?.path) {
      closePanel();
      // A failed reply after the extension was reloaded or removed: this old script stops at once.
      if (contextAlive()) flash('No build on this page');
      else teardown();
      return;
    }
    const panel = document.createElement('div');
    panel.setAttribute(MARK, 'panel');
    panel.style.cssText = 'position:fixed;z-index:100;box-sizing:border-box;background:#fff;'
      + 'border:1px solid #dfe1e6;border-radius:4px;box-shadow:0 1px 3px rgba(9,30,66,0.25);overflow:hidden;';
    const frame = document.createElement('iframe');
    frame.title = TAB_LABEL;
    frame.src = chrome.runtime.getURL(answer.path);
    frame.style.cssText = 'display:block;width:100%;height:100%;border:0;';
    panel.append(frame);
    (document.body ?? document.documentElement).append(panel);
    open.panel = panel;
    place();
  }

  // Under the tab row, from the tabs' left edge to the right edge of the step's pane, down to the bottom of the
  // window. Recomputed every frame, so it follows the page when it scrolls or reflows, without depending on how the
  // area under the tabs is built.
  function place() {
    if (!open?.panel || !tab) return;
    const row = (tab.bar.parentElement ?? tab.bar).getBoundingClientRect();
    const left = row.left;
    const right = Math.min(paneRight(tab.bar, left) ?? Infinity, window.innerWidth - 16);
    const top = row.bottom + 8;
    Object.assign(open.panel.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(320, right - left)}px`,
      height: `${Math.max(240, window.innerHeight - top - 8)}px`,
    });
    open.raf = requestAnimationFrame(place);
  }

  // The right edge of the step's pane: the furthest right edge among the bar and its ancestors, at most 12 levels up,
  // that start where the tabs start. On Bitbucket the tabs share their row with a toolbar, so the tabs' own row
  // ends early; the pane under them is wider. An ancestor that reaches further left holds the page's side column,
  // so the walk stops there.
  function paneRight(bar, left) {
    let right = null;
    let node = bar;
    for (let level = 0; node && node !== document.body && level < 12; level += 1, node = node.parentElement) {
      const box = node.getBoundingClientRect();
      if (box.left < left - 24) break;
      right = Math.max(right ?? box.right, box.right);
    }
    return right;
  }

  function closePanel() {
    if (!open) return;
    cancelAnimationFrame(open.raf);
    open.panel?.remove();
    const native = open.native;
    if (native?.link.isConnected && !movedOn(native.link)) {
      native.link.className = native.className;
      restoreAttribute(native.link, 'aria-selected', native.selected);
      restoreAttribute(native.link, 'aria-current', native.current);
    }
    open = null;
    if (tab) {
      tab.link.className = unselectedClass(tab.bar) ?? tab.link.className;
      tab.link.setAttribute('aria-selected', 'false');
    }
  }

  // After a back or forward move, Bitbucket has already selected another tab; the old one must keep its new look.
  function movedOn(link) {
    const bar = link.closest('[role="group"]');
    return Boolean(bar) && nativeTabs(bar).some((other) => other !== link && other.getAttribute('aria-selected') === 'true');
  }

  function restoreAttribute(element, name, value) {
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  function flash(text) {
    if (!tab?.label) return;
    const { label } = tab;
    label.nodeValue = text;
    setTimeout(() => {
      label.nodeValue = TAB_LABEL;
    }, 2500);
  }

  // --- The fallback button -------------------------------------------------------------------------------------

  function showFloating() {
    if (floating?.isConnected) return;
    floating = document.createElement('div');
    floating.setAttribute(MARK, '');
    const shadow = floating.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      button {
        position: fixed; right: 24px; bottom: 24px; z-index: 2147483000;
        padding: 10px 16px; border: 0; border-radius: 6px;
        background: #0052cc; color: #fff; font: 600 14px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
        box-shadow: 0 2px 8px rgba(9, 30, 66, 0.35); cursor: pointer;
      }
      button:hover { background: #0747a6; }
      button:focus-visible { outline: 3px solid #4c9aff; outline-offset: 2px; }
    `;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Open report';
    button.title = "Open this build's artifact in a new tab";
    // Only a real click counts: scripts on the page cannot open viewer tabs through the button.
    button.addEventListener('click', (event) => {
      if (!event.isTrusted) return;
      if (!contextAlive()) {
        teardown();
        return;
      }
      chrome.runtime.sendMessage({ type: 'open-viewer' }).then((answer) => {
        if (answer?.opened === false) {
          button.textContent = 'No build on this page';
          setTimeout(() => {
            button.textContent = 'Open report';
          }, 2500);
        }
      }).catch(() => {
        if (!contextAlive()) teardown();
      });
    });
    shadow.append(style, button);
    (document.body ?? document.documentElement).append(floating);
  }

  function hideFloating() {
    floating?.remove();
    floating = null;
  }

  // --- Keeping up with the page --------------------------------------------------------------------------------

  function check() {
    checkQueued = false;
    if (!contextAlive() || superseded()) {
      teardown();
      return;
    }
    const onResultPage = RESULT_PAGE.test(location.pathname);
    if (open && (!onResultPage || location.pathname !== open.path || !tab?.link.isConnected)) closePanel();
    if (!onResultPage) {
      removeTab();
      hideFloating();
      barMissingSince = null;
      return;
    }
    if (tab && !tab.link.isConnected) removeTab();
    if (!tab) {
      const found = findTabBar();
      if (found?.wrapper) {
        insertTab(found);
      } else if (found) {
        // A step without artifacts yet, or one that keeps none: no tab, and no button either.
        hideFloating();
        barMissingSince = null;
        return;
      }
    }
    if (tab) {
      hideFloating();
      barMissingSince = null;
      return;
    }
    barMissingSince ??= performance.now();
    if (performance.now() - barMissingSince >= FALLBACK_DELAY_MS) showFloating();
  }

  function queueCheck() {
    if (checkQueued) return;
    checkQueued = true;
    requestAnimationFrame(check);
  }

  // After the extension is reloaded or removed, or once a newer copy runs, this copy stops and takes its additions
  // away.
  function teardown() {
    clearInterval(timer);
    observer.disconnect();
    closePanel();
    removeTab();
    hideFloating();
  }

  const observer = new MutationObserver(queueCheck);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const timer = setInterval(check, 1000);
  check();
})();
