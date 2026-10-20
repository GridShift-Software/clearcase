// Summarise .local/viewer-evaluation/results.json for the coverage matrix: totals per family and viewport, PASS/FAIL
// per fixture, every FAIL with its assertion, and the scale measurements.
// Usage: bun harness/summarize.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OUT_ROOT } from './paths.mjs';

const r = JSON.parse(readFileSync(path.join(OUT_ROOT, 'results.json'), 'utf8'));
console.log(`revision ${r.revision.head} tree ${r.revision.harnessTree} dirty=${r.revision.dirty}; ${r.browser.name} ${r.browser.version}; ${r.browser.driver}; ${r.network}`);
const tally = (rows) => rows.reduce((t, x) => ((t[x.verdict] = (t[x.verdict] ?? 0) + 1), t), {});
const by = (key) => { const m = new Map(); for (const x of r.results) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
console.log('\n## family x viewport');
for (const [k, rows] of by((x) => `${x.family} ${x.viewport}`)) console.log(k, JSON.stringify(tally(rows)));
console.log('\n## fixture');
for (const [k, rows] of by((x) => x.fixture)) console.log(k, JSON.stringify(tally(rows)));
console.log('\n## FAIL');
for (const x of r.results.filter((x) => x.verdict !== 'PASS')) console.log(`${x.verdict} ${x.viewport} ${x.fixture} | ${x.component} | ${x.check} | ${x.assertion} | ${JSON.stringify(x.observed)?.slice(0, 300)}`);
console.log('\n## scale');
for (const x of r.results.filter((x) => /1,000|MP image|populated cells|one-hour/.test(x.check))) console.log(`${x.verdict} ${x.fixture} | ${x.check} | ${JSON.stringify(x.observed)}`);
console.log('\nTOTAL', JSON.stringify(tally(r.results)));
