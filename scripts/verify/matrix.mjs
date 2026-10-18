#!/usr/bin/env bun
// The 42-view acceptance matrix (GRS-21, CC-11), generated from the evidence of one revision:
//
//   bun scripts/verify/matrix.mjs --sha SHA [--parity FILE] [--e2e DIR] [--acceptance FILE] [--layout FILE]
//       [--layout-v5 FILE] [--out FILE]
//
// Inputs (defaults are the gate's and the GRS-21 runs' output paths, all ignored local files):
//   --parity      strict parity scorecard (.local/gate/parity-out/scorecard.json): per view, v5 and app extracted, values
//                 compared, matched, registered by type, unregistered; the scorecard's revision must be SHA;
//   --e2e         test:e2e output (.local/gate/e2e-out): each category suite's summary.json ({scenarios: [{id, view,
//                 pass}]}), the UI class suite's (classes/summary.json, view = the route's last segment) and the pilot
//                 browser suite's suite.json (overview, chronology, documents);
//   --acceptance  tests/e2e/acceptance summary.json (.local/GRS-21/acceptance-out/acceptance/summary.json);
//   --layout      scripts/verify/layout.mjs layout.json on the synthetic case, --layout-v5 the same on the real sample.
// Actions per view come from docs/reference/view-checklist.md (**Actions (N):** bullets), labels from the view registry.
// A view PASSes only when parity compared it with no unregistered difference and no not-yet-implemented entry, at least
// one browser scenario names it and all of them passed, and every layout check of it passed; it FAILs when any of these
// failed, and is BLOCKED when an input is missing. Every input must carry the revision it was produced at (parity
// scorecard `revision`, e2e summary.json `freshBuild.head`, acceptance and layout `revision.head`, and the build under
// test: build/clearcase-build.json, also stamped into the acceptance and layout results) and that revision must be SHA
// on a clean tree; one that is missing, different or dirty BLOCKs every view and the script exits 1. A revision is a
// hex SHA of 12 characters or more, and the two agree when one is a prefix of the other. Each input must also say its run
// completed: a layout run that exited 0 or 1 without an `error`, with a row for every view at every width and every
// shared component (scripts/verify/layout-spec.mjs); a parity scorecard that exited 0 or 1, was not aborted and is
// evidence from a strict-register run; an acceptance run that was offline and wrote every scenario; the e2e summary and
// each category summary and suite.json, which test:e2e stamps with the revision of its run, are evidence. A view whose
// layout row is incomplete is BLOCKED; a step that failed without a failing scenario in its own record, a listed category without a summary, and a shell or component layout failure fail every view.
// --build-stamp FILE (default build/clearcase-build.json) names the build stamp. Writes Markdown (--out, default
// docs/acceptance/CC-11/matrix.md).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { VIEWS } from '../../src/lib/components/view-registry.ts';
import { COMPONENTS, WIDTHS } from './layout-spec.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SHA = arg('--sha', null);
if (!SHA) { console.error('--sha SHA is required'); process.exit(2); }
if (!/^[0-9a-f]{12,64}$/.test(SHA)) { console.error('--sha must be a hex revision of at least 12 characters'); process.exit(2); }
const L = (p) => join(ROOT, '.local', ...p.split('/'));
const PARITY = arg('--parity', L('gate/parity-out/scorecard.json'));
const E2E = arg('--e2e', L('gate/e2e-out'));
const ACC = arg('--acceptance', L('GRS-21/acceptance-out/acceptance/summary.json'));
const LAYOUT = arg('--layout', L('GRS-21/layout-synthetic/layout.json'));
const LAYOUT_V5 = arg('--layout-v5', L('GRS-21/layout-v5/layout.json'));
const BUILD_STAMP = arg('--build-stamp', join(ROOT, 'build', 'clearcase-build.json'));
const OUT = arg('--out', join(ROOT, 'docs', 'acceptance', 'CC-11', 'matrix.md'));
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const rel = (f) => relative(ROOT, f);

// actions per view from the checklist
const checklist = readFileSync(join(ROOT, 'docs', 'reference', 'view-checklist.md'), 'utf8');
const actions = {};
for (const sec of checklist.split(/^## /m).slice(1)) {
	const id = /^[^\n]*\(`([a-z_]+)`\)/.exec(sec)?.[1];
	const block = /\*\*Actions \((\d+)\):\*\*\n((?:\s+- .*\n?)*)/.exec(sec);
	if (id) actions[id] = block ? block[2].split('\n').map((l) => l.replace(/^\s+- /, '').replace(/\s*\(`[^`]*`\)\s*$/, '').trim()).filter(Boolean) : [];
}

// scenarios per view
const scenarios = {};
const add = (view, suite, s) => { (scenarios[view] ??= []).push({ suite, id: s.id, pass: s.pass === true || s.status === 'PASS' }); };
const e2eFiles = {}, e2eStamped = {};
const e2eSummary = read(join(E2E, 'summary.json'));
// a category counts only when the root summary says this run ran it: a directory left by an earlier gate does not
const e2eRan = new Set([...(e2eSummary?.categories?.suites ?? []), 'classes']);
if (existsSync(E2E)) {
	for (const d of readdirSync(E2E, { withFileTypes: true }).filter((x) => x.isDirectory() && e2eRan.has(x.name))) {
		const f = join(E2E, d.name, 'summary.json');
		const s = read(f);
		if (!s?.scenarios) continue;
		e2eFiles[d.name] = rel(f);
		e2eStamped[d.name] = s;
		for (const x of s.scenarios) {
			const view = d.name === 'classes' ? (/:([a-z_]+)(?:[#@]|$)/.exec(x.id.replace(/^[a-z-]+:/, ''))?.[1] ?? x.view.split('/').pop()) : x.view;
			add(view, d.name, x);
		}
	}
	const pilot = read(join(E2E, 'suite.json'));
	if (pilot?.results) { e2eFiles.pilot = rel(join(E2E, 'suite.json')); e2eStamped.pilot = pilot; for (const x of pilot.results) for (const v of ['overview', 'chronology']) add(v, 'pilot', x); }
}
const acc = read(ACC);
if (acc?.scenarios) for (const x of acc.scenarios) add(x.view, 'acceptance', x);
if (acc?.scenarios?.find((x) => x.id === 'AC8-hostile-all-views')) for (const v of VIEWS) if (v.id !== 'overview') add(v.id, 'acceptance', { id: 'AC8-hostile-all-views', pass: acc.scenarios.find((x) => x.id === 'AC8-hostile-all-views').pass });

const parity = read(PARITY);
const layout = read(LAYOUT), layoutV5 = read(LAYOUT_V5);
const buildStamp = read(BUILD_STAMP);

// ---- revisions: every input is evidence for SHA only when it says it was produced at SHA, on a clean tree --------------
const isSha = (rev) => typeof rev === 'string' && /^[0-9a-f]{12,64}$/.test(rev) && (rev.startsWith(SHA) || SHA.startsWith(rev));
const problems = [];
const need = (name, doc, rev, dirty) => {
	if (!doc) problems.push(`${name}: missing`);
	else if (typeof rev !== 'string') problems.push(`${name}: carries no revision`);
	else if (!isSha(rev)) problems.push(`${name}: revision ${rev.slice(0, 12)}, not ${SHA.slice(0, 12)}`);
	else if (dirty !== false) problems.push(`${name}: produced on a ${dirty === true ? 'dirty' : 'unknown-state'} tree`);
};
need('build/clearcase-build.json', buildStamp, buildStamp?.revision, buildStamp?.dirty);
need('parity scorecard', parity, parity?.revision, parity?.dirty);
need('e2e summary', e2eSummary, e2eSummary?.freshBuild?.head, e2eSummary?.freshBuild?.trackedDirty === false && e2eSummary?.freshBuild?.buildDirty === false ? false : true);
if (e2eSummary && !isSha(e2eSummary.freshBuild?.buildRevision)) problems.push(`e2e summary: ${e2eSummary.freshBuild?.buildRevision ? `built from ${String(e2eSummary.freshBuild.buildRevision).slice(0, 12)}, not ${SHA.slice(0, 12)}` : 'its build carries no revision'}`);
for (const [name, doc] of [['acceptance summary', acc], ['layout (synthetic)', layout], ['layout (v5 sample)', layoutV5]]) {
	need(name, doc, doc?.revision?.head, doc?.revision?.dirty);
	if (doc && !isSha(doc.revision?.build?.revision)) problems.push(`${name}: ${doc.revision?.build?.revision ? `built from ${doc.revision.build.revision.slice(0, 12)}, not ${SHA.slice(0, 12)}` : 'its build carries no revision'}`);
	else if (doc && doc.revision?.build?.dirty !== false) problems.push(`${name}: the build under test was dirty`);
}
if (!Object.keys(e2eFiles).length) problems.push('e2e summary: no category summary found');
// a partial acceptance run (a scenario missing) is not the acceptance workflow
if (acc) for (let i = 1; i <= 8; i++) if (!acc.scenarios?.some((x) => x.id.startsWith(`AC${i}-`))) problems.push(`acceptance summary: scenario AC${i} missing`);

// ---- completion: every input must say that its run finished, not only that the checks it did make passed ---------------
const ran = (name, doc, ...checks) => { for (const [ok, what] of checks) if (doc && !ok) problems.push(`${name}: ${what}`); };
const stamped = (name, doc) => {
	const f = doc?.freshBuild;
	if (!isSha(f?.head) || !isSha(f?.buildRevision) || f?.trackedDirty !== false || f?.buildDirty !== false) problems.push(`${name}: not stamped with a clean run at ${SHA.slice(0, 12)} (a copy left by an earlier gate?)`);
};
ran('e2e summary', e2eSummary, [e2eSummary?.evidence === true, `evidence is not true: ${e2eSummary?.evidenceNote ?? 'no evidence field'}`]);
for (const [name, doc] of Object.entries(e2eStamped)) {
	stamped(`e2e ${name} summary`, doc);
	ran(`e2e ${name} summary`, doc, [!doc.aborted, 'its run aborted'], [doc.evidence !== false, 'evidence is false']);
}
ran('parity scorecard', parity,
	[[0, 1].includes(parity?.exit), `exit ${parity?.exit ?? 'missing'}, not 0 or 1: the run did not finish`],
	[!parity?.aborted, 'its run aborted'],
	[parity?.evidence === true, `evidence is not true: ${parity?.evidenceNote ?? 'no evidence field'}`],
	[parity?.register?.strict === true, 'it was not a strict-register run']);
ran('acceptance summary', acc, [acc?.offline === true, 'the run was not offline']);
// a layout run is complete when it exited 0 or 1 without an error, has its rows, and its failures agree with its exit
const layoutRows = {};
const layoutProblems = (name, l) => {
	if (!l) return;
	ran(name, l, [[0, 1].includes(l.exit), `exit ${l.exit ?? 'missing'}, not 0 or 1: the run did not finish${l.error ? ` (${String(l.error).slice(0, 100)})` : ''}`],
		[!l.error, `the run raised an error: ${String(l.error).slice(0, 100)}`],
		[Array.isArray(l.failures), 'it lists no failures array'],
		[l.exit !== 0 || !l.failures?.length, 'exit 0 with failures listed'],
		[l.exit !== 1 || l.failures?.length > 0, 'exit 1 with no failure listed']);
	const miss = COMPONENTS.map(([c]) => c).filter((c) => !(l.components ?? []).some((x) => x?.name === c && typeof x.textOk === 'boolean' && x.states && ['default', 'hover', 'focus-visible', 'active'].every((st) => x.states[st])));
	ran(name, l, [!miss.length, `shared components not measured: ${miss.join(', ')}`]);
	for (const v of VIEWS) {
		const row = (l.views ?? []).find((x) => x?.view === v.id);
		const gaps = !row ? ['no row'] : [...WIDTHS.filter((w) => !row.widths?.[w] || typeof row.widths[w] !== 'object').map((w) => `width ${w}`), ...['label', 'keyboard'].filter((k) => typeof row[k]?.ok !== 'boolean'), ...(row.contrast?.main && row.contrast?.nav ? [] : ['contrast'])];
		if (gaps.length) ((layoutRows[v.id] ??= []).push(`${name}: ${gaps.join(', ')} not measured`));
	}
};
layoutProblems('layout (synthetic)', layout);
layoutProblems('layout (v5 sample)', layoutV5);
// a failed step is blamed on its own record: it needs a failing scenario there that lands on a view, else every view fails
const viewIds = new Set(VIEWS.map((v) => v.id));
const failedIn = (suite) => [...viewIds].some((id) => (scenarios[id] ?? []).some((x) => x.suite === suite && !x.pass));
const runFailed = [];
if (acc && acc.ok !== true && !failedIn('acceptance')) runFailed.push(`acceptance run failed (ok ${acc.ok}) with no failing scenario on a view`);
if (e2eSummary) {
	// the record each step writes: a suite's scenarios feed the views it names; the others (durability, netcheck) feed none
	const recordOf = (name) => (name === 'browser suite (offline)' ? 'pilot' : name === 'UI class suite (offline)' ? 'classes' : /^(\S+) suite \(offline\)$/.exec(name)?.[1]);
	const seen = new Set();
	for (const r of e2eSummary.results ?? []) {
		if (r.rc === 0) continue;
		const rec = recordOf(r.name);
		seen.add(r.name);
		if (!rec || ['durability', 'netcheck'].includes(rec)) runFailed.push(`test:e2e step failed (${r.name} rc ${r.rc}); no view to blame`);
		else if (!failedIn(rec)) runFailed.push(`test:e2e step failed (${r.name} rc ${r.rc}) with no failing scenario in its own record${r.summaryProblems?.length ? `: ${r.summaryProblems[0]}` : ''}`);
	}
	for (const c of e2eSummary.categories?.suites ?? []) if (!e2eStamped[c]) runFailed.push(`test:e2e category ${c}: no usable summary`);
	if (e2eSummary.ok !== true && !seen.size && !runFailed.length) runFailed.push(`test:e2e run failed (ok ${e2eSummary.ok}) with no step named`);
}
if (parity && parity.exit === 1) runFailed.push('the parity run failed (exit 1): an isolation breach or an unused register entry, not a view');
for (const [name, doc] of Object.entries(e2eStamped)) if (doc.ok === false && !(doc.scenarios ?? []).some((x) => x.pass !== true)) runFailed.push(`e2e ${name} summary: ok false with no failing scenario`);
// a shell or component failure belongs to no view: it fails all of them (layout.mjs names a view's failures `<view>@w:` or `<view>:`)
for (const [name, l] of [['layout (synthetic)', layout], ['layout (v5 sample)', layoutV5]]) {
	const shared = (l?.failures ?? []).filter((f) => !viewIds.has(/^[a-z_]+/.exec(f)?.[0]));
	if (shared.length) runFailed.push(`${name}: ${shared.length} shell or component failure(s): ${shared[0].slice(0, 80)}`);
}
const layoutFails = (l, id) => (l?.failures ?? []).filter((f) => f.startsWith(`${id}@`) || f.startsWith(`${id}:`));

const rows = [];
for (const [n, v] of VIEWS.entries()) {
	const p = parity?.views?.[v.id];
	const sc = scenarios[v.id] ?? [];
	const lf = layoutFails(layout, v.id), lf5 = layoutFails(layoutV5, v.id);
	const nyi = p?.registered?.['not-yet-implemented'] ?? 0;
	const why = [];
	let verdict = 'PASS';
	if (problems.length) { verdict = 'BLOCKED'; why.push('evidence is not for this revision (see Inputs)'); }
	else if (!p || !layout) { verdict = 'BLOCKED'; why.push(!p ? 'no parity result' : 'no layout result'); }
	else if (layoutRows[v.id]) { verdict = 'BLOCKED'; why.push(...layoutRows[v.id]); }
	else {
		if (runFailed.length) { verdict = 'FAIL'; why.push(...runFailed); }
		if (p.v5 !== 'ok' || p.app !== 'ok' || p.unregistered !== 0) { verdict = 'FAIL'; why.push(`parity ${p.status}: v5 ${p.v5}, app ${p.app}, unregistered ${p.unregistered}`); }
		if (nyi) { verdict = 'FAIL'; why.push(`${nyi} not-yet-implemented register entries (placeholder)`); }
		if (!sc.length) { verdict = 'FAIL'; why.push('no browser scenario names the view'); }
		if (sc.some((s) => !s.pass)) { verdict = 'FAIL'; why.push(`failed scenarios: ${sc.filter((s) => !s.pass).map((s) => s.id).slice(0, 4).join(', ')}`); }
		if (lf.length) { verdict = 'FAIL'; why.push(...lf.slice(0, 3)); }
		if (lf5.length) { verdict = 'FAIL'; why.push(...lf5.slice(0, 2).map((f) => `v5 sample: ${f}`)); }
	}
	const bySuite = Object.entries(sc.reduce((a, s) => { a[s.suite] ??= [0, 0]; a[s.suite][0] += s.pass ? 1 : 0; a[s.suite][1]++; return a; }, {})).map(([k, [ok, all]]) => `${k} ${ok}/${all}`).join(', ');
	rows.push({ n: n + 1, v, p, nyi, sc, bySuite, verdict, why, acts: actions[v.id] ?? [] });
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
const reg = (p) => (p ? Object.entries(p.registered ?? {}).filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(', ') || '0' : '–');
const totals = Object.fromEntries(['PASS', 'FAIL', 'BLOCKED'].map((k) => [k, rows.filter((r) => r.verdict === k).length]));
const md = [
	`# CC-11 view and action matrix`,
	'',
	`Generated by \`bun scripts/verify/matrix.mjs --sha ${SHA}\`. Do not edit by hand: rerun it on the evidence of the reviewed revision.`,
	'',
	`- **Revision:** \`${SHA}\`. Input revisions: ${problems.length ? `**BLOCKED, not evidence for this SHA:** ${problems.join('; ')}` : 'every input (build, parity scorecard, e2e, acceptance, both layout runs) was produced at this SHA on a clean tree'}. Parity scorecard: evidence ${parity?.evidence ?? 'missing'}, exit ${parity?.exit ?? '–'}.`,
	`- **Result:** ${totals.PASS} PASS, ${totals.FAIL} FAIL, ${totals.BLOCKED} BLOCKED of ${rows.length} views; ${rows.reduce((a, r) => a + r.acts.length, 0)} v5 actions.`,
	...(runFailed.length ? [`- **Runs that failed with no failing scenario to blame, and shell-wide layout failures:** ${runFailed.map(cell).join('; ')}.`] : []),
	`- **Shell-wide failures** (shared navigation and components, on every view, so not repeated per view): ${[...(layout?.failures ?? []), ...(layoutV5?.failures ?? []).map((f) => `v5 sample: ${f}`)].filter((f) => f.startsWith('shell') || f.startsWith('component') || f.startsWith('v5 sample: shell') || f.startsWith('v5 sample: component')).map(cell).join('; ') || 'none'}.`,
	`- **Inputs:** parity \`${rel(PARITY)}\`; e2e summaries ${Object.entries(e2eFiles).map(([k, f]) => `\`${f}\``).join(', ') || 'missing'}; acceptance \`${rel(ACC)}\`${acc ? '' : ' (missing)'}; layout \`${rel(LAYOUT)}\`${layout ? '' : ' (missing)'}; layout on the v5 sample \`${rel(LAYOUT_V5)}\`${layoutV5 ? '' : ' (missing)'}. Analysis additions during the layout runs (the heading each run expected, ADR 0003): ${[['synthetic', layout], ['v5 sample', layoutV5]].map(([n, l]) => `${n} ${l?.analysisAdditions === true ? 'on' : l?.analysisAdditions === false ? 'off' : 'not recorded'}`).join(', ')}. All are ignored local files of the run; the reviewer regenerates them with [reviewer-guide.md](reviewer-guide.md).`,
	`- **Rule:** a view PASSes when strict parity compared it with no unregistered difference and no not-yet-implemented entry, every browser scenario that names it passed (at least one), and every layout, label, keyboard and contrast check of it passed at 320, 390, 768 and 1280 px. For the actions, parity compares each view's control inventory (every button, link and field v5 shows, by label) and drives its filter and sort sweeps and its exports on both sides, and the named scenarios drive the saves and navigation. This gate does not map each action to one scenario: the view's verdict stands for each action listed under it.`,
	'',
	`| # | View | Label | Actions | Parity (compared / matched / registered / unregistered) | Scenarios (passed/total by suite) | Layout 320–1280 | Verdict | Why |`,
	`| --: | --- | --- | --: | --- | --- | --- | --- | --- |`,
	...rows.map((r) => `| ${r.n} | \`${r.v.id}\` | ${cell(r.v.label)} | ${r.acts.length} | ${r.p ? `${r.p.compared} / ${r.p.matched} / ${reg(r.p)} / ${r.p.unregistered}` : '–'} | ${cell(r.bySuite) || '–'} | ${layout ? (layoutFails(layout, r.v.id).length ? 'FAIL' : 'pass') : '–'} | **${r.verdict}** | ${cell(r.why.join('; ')) || ''} |`),
	'',
	`## Actions per view`,
	'',
	`The v5 actions of each view (docs/reference/view-checklist.md), with the view's verdict at \`${SHA}\`.`,
	'',
	...rows.flatMap((r) => [`### ${r.n}. ${r.v.label} (\`${r.v.id}\`): ${r.verdict}`, '', ...(r.acts.length ? r.acts.map((a) => `- ${a}`) : ['- (no actions in v5)']), '']),
].join('\n');
writeFileSync(OUT, md);
console.log(`matrix: ${totals.PASS} PASS, ${totals.FAIL} FAIL, ${totals.BLOCKED} BLOCKED -> ${rel(OUT)}`);
for (const pr of problems) console.log(`BLOCKED ${pr}`);
for (const r of rows.filter((x) => x.verdict === 'BLOCKED' && !problems.length)) console.log(`BLOCKED ${r.v.id}: ${r.why.join('; ')}`);
process.exit(problems.length || totals.BLOCKED ? 1 : 0);
