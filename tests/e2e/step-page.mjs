// A fake Bitbucket pipeline step page built from the real markup of Bitbucket's step tabs (copied from bitbucket.org
// on 2026-11-12, with the workspace, repository and step replaced). The class names are Bitbucket's generated atomic
// classes, kept as they are, so the tests see the same selected and unselected class strings as the real page.
//
// An inline script stands in for React. Like React, it keeps the selected tab in its own state, not in the DOM, and
// on a change it updates only the attributes of the tabs whose state changed:
// - a click on a tab moves to its route with pushState and moves the selected look;
// - a click on the tab already selected changes nothing;
// - Back and Forward select the tab of the route they reach;
// - rerenderTabs() replaces the whole group with new nodes;
// - goToStep() moves to another step and re-renders.

export const CLASSES = {
  "outer": "_1reo15vq _18m915vq _16jlkb7n _1o9zkb7n _1ul953f4 _kqswh2mm",
  "visible": "_2rko1qi0 _1h6d1l7x _1dqonqa1 _189ee4h9 _1e0c116y _ca0q1b66 _u5f31b66 _n3td1b66 _19bv1b66",
  "group": "css-1oy5iav",
  "item": "_1e0c116y",
  "selected": "_ymio1r31 _ypr0glyw _zcxs1o36 _mizu194a _1ah3dkaa _ra3xnqa1 _128mdkaa _1cvmnqa1 _4davt94y _4bfu1snc _1hmsagmp _ajmmvv82 _vchhusvi _kqswh2mm _2rko1qi0 _11c8fhey _v564k6bl _189eidpf _1rjcv77o _1e0c116y _1bsb1wug _p12f1osq _4cvr1q9y _1bah1h6o _gy1p1b66 _1o9zidpf _4t3i1k8s _k48p1wq8 _y4tiutpp _bozgutpp _y3gn1h6o _s7n4nkob _14mj1kw7 _9v7aze3t _1tv3nqa1 _39yqe4h9 _11fnglyw _18postnw _1ggl5xtf _bfhk15s3 _syaz6x5g _8l3mq98m _aetrb3bt _10536x5g _f8pj6x5g _irr31dpa _30l36x5g _1di6fcek _9h8h6x5g _1a3b1r31 _4fprglyw _5goinqa1 _9oik1r31 _1bnxglyw _jf4cnqa1 _1nrm1r31 _c2waglyw _1iohnqa1",
  "unselected": "_ymio1r31 _ypr0glyw _zcxs1o36 _mizu194a _1ah3dkaa _ra3xnqa1 _128mdkaa _1cvmnqa1 _4davt94y _4bfu1snc _1hmsagmp _ajmmvv82 _vchhusvi _kqswh2mm _2rko1qi0 _11c8fhey _v564k6bl _189eidpf _1rjcv77o _1e0c116y _1bsb1wug _p12f1osq _4cvr1q9y _1bah1h6o _gy1p1b66 _1o9zidpf _4t3i1k8s _k48p1wq8 _y4tiutpp _bozgutpp _y3gn1h6o _s7n4nkob _14mj1kw7 _9v7aze3t _1tv3nqa1 _39yqe4h9 _11fnglyw _18postnw _1ggl5xtf _bfhksm61 _syazazsu _1053azsu _f8pj1mjl _irr31dpa _30l3azsu _1di6fcek _9h8hazsu _1a3b1r31 _4fprglyw _5goinqa1 _9oik1r31 _1bnxglyw _jf4cnqa1 _1nrm1r31 _c2waglyw _1iohnqa1",
  "label": "_v564g17y _1reo15vq _18m915vq _16jlkb7n _1o9zkb7n _1bto1l2s _o5721q9c",
  "hidden": "_1ltvidpf _lcxvglyw _kqswstnw _154iidpf _3um015vq _o5721q9c",
  "more": "_ymio1r31 _ypr0glyw _zcxs1o36 _mizu194a _1ah3dkaa _ra3xnqa1 _128mdkaa _1cvmnqa1 _4davt94y _19itglyw _vchhusvi _r06hglyw _80omtlke _2rko12b0 _11c8fhey _v564k6bl _189eidpf _1rjcv77o _1e0c116y _1bsb1wug _p12f1osq _kqswh2mm _4cvr1q9y _1bah1h6o _gy1p12x7 _1o9zidpf _4t3i1k8s _k48p1wq8 _y4tiutpp _bozgutpp _y3gn1h6o _s7n4nkob _14mj1kw7 _9v7aze3t _1tv3nqa1 _39yqe4h9 _11fnglyw _18postnw _1ggl5xtf _bfhksm61 _syazazsu _1053azsu _f8pjazsu _30l3azsu _9h8hazsu _irr31dpa _1di6fcek _4bfu1r31 _1hmsglyw _ajmmnqa1 _1a3b1r31 _4fprglyw _5goinqa1 _9oik1r31 _1bnxglyw _jf4cnqa1 _1nrm1r31 _c2waglyw _1iohnqa1"
};

export const SELECTED_CLASS = CLASSES.selected;
export const UNSELECTED_CLASS = CLASSES.unselected;

// The page's own policy, as strict about frames as a real site can be; the extension's frame must load anyway.
export const STEP_PAGE_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; child-src 'self'";

// artifacts: false for a step that is queued or running, whose bar has Build and Metrics only; finishStep() then adds
// Artifacts, as Bitbucket does when the step ends.
export function stepPage({ workspace, repo, build, step, artifacts = true }) {
  const config = { classes: CLASSES, workspace, repo, build, step, artifacts };
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Pipeline step</title>
<style>
  body { margin: 0; font: 14px/1.4 sans-serif; }
  #steps { position: absolute; left: 0; top: 0; width: 280px; height: 100vh; background: #f4f5f7; }
  #pane { margin-left: 300px; width: 900px; padding-top: 40px; }
  #row { display: flex; align-items: center; }
  #row > div:first-child { flex: 1 1 auto; position: relative; overflow: hidden; }
  [aria-label="Log navigation"] { display: flex; gap: 4px; }
  [role="tab"] { display: inline-block; padding: 4px 10px; }
  [aria-hidden="true"] { position: absolute; top: 0; left: 0; visibility: hidden; }
  #log { height: 600px; margin: 8px 0 0; border: 1px solid #ddd; }
</style></head>
<body>
<div id="steps">Steps</div>
<div id="pane">
  <div id="row"><div id="outer"></div></div>
  <pre id="log">Build setup</pre>
</div>
<script>
(() => {
  const config = ${JSON.stringify(config)};
  const c = config.classes;
  const base = () => '/' + config.workspace + '/' + config.repo + '/pipelines/results/' + config.build + '/steps/' + encodeURIComponent(config.step);
  const tabs = () => [['Build', base()], ['Metrics', base() + '/metrics'], ['Artifacts', base() + '/artifacts']]
    .filter(([text]) => config.artifacts || text !== 'Artifacts');
  const link = (text, href, role, selected) => '<span class="' + c.item + '"><a role="' + role + '"'
    + (role === 'tab' ? ' aria-selected="' + selected + '"' + (selected ? ' aria-current="page"' : '') : ' tabindex="-1"')
    + ' class="' + (selected ? c.selected : c.unselected) + '" href="' + href + '" target="_self"><span class="' + c.label + '">'
    + text + '</span></a></span>';
  let selected = null; // the href of the selected tab, as the router sees it
  function render() {
    const current = decodeURIComponent(location.pathname);
    selected = tabs().find(([, href]) => decodeURIComponent(href) === current)?.[1] ?? null;
    const items = tabs().map(([text, href]) => link(text, href, 'tab', href === selected)).join('');
    const hidden = tabs().map(([text, href]) => link(text, href, 'presentation', false)).join('')
      + '<button tabindex="-1" role="presentation" type="button" class="' + c.more + '"><span class="' + c.label + '">More</span></button>';
    document.getElementById('outer').outerHTML = '<div id="outer" class="' + c.outer + '"><div class="' + c.visible + '">'
      + '<div role="group" aria-label="Log navigation" class="' + c.group + '">' + items + '</div></div>'
      + '<div aria-hidden="true" class="' + c.hidden + '"><div role="group" class="' + c.group + '">' + hidden + '</div></div></div>';
  }
  const tabFor = (href) => document.querySelector('[aria-label="Log navigation"] a[role="tab"][href="' + href + '"]');
  function select(href) {
    if (href === selected) return;
    for (const [node, on] of [[tabFor(selected), false], [tabFor(href), true]]) {
      if (!node) continue;
      node.className = on ? c.selected : c.unselected;
      node.setAttribute('aria-selected', String(on));
      if (on) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
    selected = href;
    document.getElementById('log').textContent = 'Showing ' + (tabFor(href)?.textContent.trim() ?? 'nothing');
  }
  document.addEventListener('click', (event) => {
    const target = event.target.closest('[aria-label="Log navigation"] a[role="tab"][href]');
    if (!target) return;
    event.preventDefault();
    const href = target.getAttribute('href');
    if (href === selected) return;
    history.pushState({}, '', href);
    select(href);
  });
  window.addEventListener('popstate', () => {
    const current = decodeURIComponent(location.pathname);
    const match = tabs().find(([, href]) => decodeURIComponent(href) === current);
    if (match) select(match[1]);
  });
  window.rerenderTabs = render;
  window.finishStep = () => {
    config.artifacts = true;
    render();
  };
  window.goToStep = (build, step) => {
    config.build = build;
    config.step = step;
    history.pushState({}, '', base());
    render();
  };
  render();
})();
</script>
</body></html>`;
}
