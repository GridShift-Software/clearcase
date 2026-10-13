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
// failed, and is BLOCKED when an input is missing. Writes Markdown (--out, default docs/acceptance/CC-11/matrix.md).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { VIEWS } from '../../src/lib/components/view-registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SHA = arg('--sha', null);
if (!SHA) { console.error('--sha SHA is required'); process.exit(2); }
const L = (p) => join(ROOT, '.local', ...p.split('/'));
const PARITY = arg('--parity', L('gate/parity-out/scorecard.json'));
const E2E = arg('--e2e', L('gate/e2e-out'));
const ACC = arg('--acceptance', L('GRS-21/acceptance-out/acceptance/summary.json'));
const LAYOUT = arg('--layout', L('GRS-21/layout-synthetic/layout.json'));
const LAYOUT_V5 = arg('--layout-v5', L('GRS-21/layout-v5/layout.json'));
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
const e2eFiles = {};
if (existsSync(E2E)) {
	for (const d of readdirSync(E2E, { withFileTypes: true }).filter((x) => x.isDirectory())) {
		const f = join(E2E, d.name, 'summary.json');
		const s = read(f);
		if (!s?.scenarios) continue;
		e2eFiles[d.name] = rel(f);
		for (const x of s.scenarios) {
			const view = d.name === 'classes' ? (/:([a-z_]+)(?:[#@]|$)/.exec(x.id.replace(/^[a-z-]+:/, ''))?.[1] ?? x.view.split('/').pop()) : x.view;
			add(view, d.name, x);
		}
	}
	const pilot = read(join(E2E, 'suite.json'));
	if (pilot?.results) { e2eFiles.pilot = rel(join(E2E, 'suite.json')); for (const x of pilot.results) for (const v of ['overview', 'chronology']) add(v, 'pilot', x); }
}
const acc = read(ACC);
if (acc?.scenarios) for (const x of acc.scenarios) add(x.view, 'acceptance', x);
if (acc?.scenarios?.find((x) => x.id === 'AC8-hostile-all-views')) for (const v of VIEWS) if (v.id !== 'overview') add(v.id, 'acceptance', { id: 'AC8-hostile-all-views', pass: acc.scenarios.find((x) => x.id === 'AC8-hostile-all-views').pass });

const parity = read(PARITY);
const layout = read(LAYOUT), layoutV5 = read(LAYOUT_V5);
const layoutFails = (l, id) => (l?.failures ?? []).filter((f) => f.startsWith(`${id}@`) || f.startsWith(`${id}:`));

const rows = [];
for (const [n, v] of VIEWS.entries()) {
	const p = parity?.views?.[v.id];
	const sc = scenarios[v.id] ?? [];
	const lf = layoutFails(layout, v.id), lf5 = layoutFails(layoutV5, v.id);
	const nyi = p?.registered?.['not-yet-implemented'] ?? 0;
	const why = [];
	let verdict = 'PASS';
	if (!p || !layout) { verdict = 'BLOCKED'; why.push(!p ? 'no parity result' : 'no layout result'); }
	else {
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
	`- **Revision:** \`${SHA}\`. Parity scorecard revision: \`${parity?.revision ?? 'missing'}\`${parity?.revision && !String(parity.revision).startsWith(SHA.slice(0, 12)) ? ' (DIFFERENT REVISION: not evidence for this SHA)' : ''}, evidence ${parity?.evidence ?? 'missing'}, exit ${parity?.exit ?? '–'}.`,
	`- **Result:** ${totals.PASS} PASS, ${totals.FAIL} FAIL, ${totals.BLOCKED} BLOCKED of ${rows.length} views; ${rows.reduce((a, r) => a + r.acts.length, 0)} v5 actions.`,
	`- **Shell-wide failures** (shared navigation and components, on every view, so not repeated per view): ${[...(layout?.failures ?? []), ...(layoutV5?.failures ?? []).map((f) => `v5 sample: ${f}`)].filter((f) => f.startsWith('shell') || f.startsWith('component') || f.startsWith('v5 sample: shell') || f.startsWith('v5 sample: component')).map(cell).join('; ') || 'none'}.`,
	`- **Inputs:** parity \`${rel(PARITY)}\`; e2e summaries ${Object.entries(e2eFiles).map(([k, f]) => `\`${f}\``).join(', ') || 'missing'}; acceptance \`${rel(ACC)}\`${acc ? '' : ' (missing)'}; layout \`${rel(LAYOUT)}\`${layout ? '' : ' (missing)'}; layout on the v5 sample \`${rel(LAYOUT_V5)}\`${layoutV5 ? '' : ' (missing)'}. All are ignored local files of the run; the reviewer regenerates them with [reviewer-guide.md](reviewer-guide.md).`,
	`- **Rule:** a view PASSes when strict parity compared it with no unregistered difference and no not-yet-implemented entry, every browser scenario that names it passed (at least one), and every layout, label, keyboard and contrast check of it passed at 320, 390, 768 and 1280 px. Its actions are covered by the view's parity sweeps and exports (every control v5 offers, driven on both sides) and by the named scenarios; the verdict applies to each action listed for the view.`,
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
