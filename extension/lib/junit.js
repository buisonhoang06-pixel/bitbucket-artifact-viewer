// The test results of a JUnit XML document, as the tools that write it lay it out: one testsuite root (Maven
// Surefire, Gradle), or testsuites around them (pytest, jest-junit, Playwright), sometimes nested. A count the tool
// wrote is used unless the listed cases add up to more, so that no listed failure is hidden; what is missing is
// counted from the cases. The document comes from DOMParser in XML mode, which runs nothing and loads nothing.

// Returns { name, totals, suites }. Each suite has name, timestamp, tests, failures, errors, skipped, time, cases,
// systemOut and systemErr; each case has name, classname, time, status (passed, failed, error, skipped), message,
// type, detail, systemOut and systemErr. suites is in document order, a suite before the suites inside it.
export function junitModel(doc) {
  const root = doc.documentElement;
  const suites = [];
  // Each suite is read once, after the suites inside it, whose counts its own include.
  const read = (element) => {
    const index = suites.push(null) - 1;
    suites[index] = suiteOf(element, childrenNamed(element, 'testsuite').map(read));
    return suites[index];
  };
  const top = (root.localName === 'testsuite' ? [root] : childrenNamed(root, 'testsuite')).map(read);
  const sum = (field) => top.reduce((total, suite) => total + suite[field], 0);
  const totals = {
    tests: atLeast(root, 'tests', sum('tests')),
    failures: atLeast(root, 'failures', sum('failures')),
    errors: atLeast(root, 'errors', sum('errors')),
    skipped: atLeast(root, 'skipped', sum('skipped')),
    time: number(root, 'time', sum('time')),
  };
  totals.passed = Math.max(0, totals.tests - totals.failures - totals.errors - totals.skipped);
  for (const suite of suites) delete suite.counted;
  return { name: root.getAttribute('name') ?? '', totals, suites };
}

// How many cases and suites a document has, in any namespace as junitModel reads them, to refuse a report too large
// to build without building it.
export function junitSize(doc) {
  return {
    cases: doc.getElementsByTagNameNS('*', 'testcase').length,
    suites: doc.getElementsByTagNameNS('*', 'testsuite').length,
  };
}

// nested: the models of the suites directly inside this one.
function suiteOf(element, nested) {
  const cases = childrenNamed(element, 'testcase').map(caseOf);
  const count = (status) => cases.filter((item) => item.status === status).length
    + nested.reduce((total, suite) => total + suite.counted[status], 0);
  const counted = { passed: count('passed'), failed: count('failed'), error: count('error'), skipped: count('skipped') };
  return {
    counted,
    name: element.getAttribute('name') || '(unnamed suite)',
    timestamp: element.getAttribute('timestamp'),
    tests: atLeast(element, 'tests', counted.passed + counted.failed + counted.error + counted.skipped),
    failures: atLeast(element, 'failures', counted.failed),
    errors: atLeast(element, 'errors', counted.error),
    skipped: Math.max(number(element, 'skipped', number(element, 'disabled', counted.skipped)), counted.skipped),
    time: number(element, 'time', cases.reduce((total, item) => total + (item.time ?? 0), 0)
      + nested.reduce((total, suite) => total + suite.time, 0)),
    cases,
    systemOut: textOf(element, 'system-out'),
    systemErr: textOf(element, 'system-err'),
  };
}

function caseOf(element) {
  const failure = childrenNamed(element, 'failure')[0];
  const error = childrenNamed(element, 'error')[0];
  const skipped = childrenNamed(element, 'skipped')[0];
  const problem = failure ?? error ?? skipped ?? null;
  const time = Number(element.getAttribute('time'));
  return {
    name: element.getAttribute('name') || '(unnamed case)',
    classname: element.getAttribute('classname') ?? '',
    time: element.hasAttribute('time') && Number.isFinite(time) ? time : null,
    status: failure ? 'failed' : error ? 'error' : skipped ? 'skipped' : 'passed',
    message: problem?.getAttribute('message') ?? null,
    type: problem?.getAttribute('type') ?? null,
    detail: problem?.textContent.trim() ?? '',
    systemOut: textOf(element, 'system-out'),
    systemErr: textOf(element, 'system-err'),
  };
}

function childrenNamed(element, name) {
  return [...element.children].filter((child) => child.localName === name);
}

function textOf(element, name) {
  return childrenNamed(element, name).map((child) => child.textContent.trim()).filter(Boolean).join('\n') || null;
}

function number(element, name, fallback) {
  if (!element.hasAttribute(name)) return fallback;
  const value = Number(element.getAttribute(name));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// A count the tool wrote, unless the cases listed add up to more.
function atLeast(element, name, counted) {
  return Math.max(number(element, name, counted), counted);
}
