#!/usr/bin/env bun
// The hosted gate's evidence walk (GRS-138 fix round, review M1): every leaf and container of each evidence file a
// passing run writes (build, health, test-hosted, drive, inner) and of the gate's own summary is deleted, nulled,
// retyped, emptied, flipped, zeroed, or given an unknown key, one at a time, and the gate's real validators must
// refuse each mutant. GRS-106's tests/hosting-probe/runtime/check-mutations.ts is the precedent: the walk is over the
// evidence itself, not over the validators' field lists, so a field they forget cannot hide from it. Run alone with
//   bun tests/hosted-foundation/gate/mutations.mjs
// refusals.mjs runs the same walk as its `evidence-walk` refusal, which is how `gate:hosted` runs it.
//
// Not judged, because a run's own logs and measurements are free-form: a step's `evidence` record (but not the fields the
// gate requires inside it: drive's no-egress canaryHits), one assertion fewer in a leg's `asserted`, and the value of
// any `ms` and of drive's `startedAt` (their type is judged). SKIPPED below names each rule; the walk reports how many
// mutants each skipped.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateSummaryProblem } from '../../../scripts/gate-hosted.mjs';
import { DRIVE_STEPS } from '../../../.agents/skills/verify-clearcase-hosted/lib/evidence.mjs';
import { FILE_STEP, gateWith, SHA, validEvidence } from './fixtures.mjs';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const at = (doc, path) => path.reduce((o, k) => o[k], doc);

/** [path, kind, apply(doc)] for every mutant of `doc`. */
export function mutants(doc) {
	const out = [];
	const walk = (value, path) => {
		const label = path.join('.') || '<root>';
		if (path.length) {
			const key = path.at(-1);
			const set = (v) => (d) => { at(d, path.slice(0, -1))[key] = v; };
			out.push([label, 'deleted', (d) => (Array.isArray(at(d, path.slice(0, -1))) ? at(d, path.slice(0, -1)).splice(key, 1) : delete at(d, path.slice(0, -1))[key])]);
			if (value !== null) out.push([label, 'null', set(null)]);
			out.push([label, 'retyped', set(typeof value === 'string' ? 1 : isObject(value) || Array.isArray(value) ? 'x' : String(value))]);
			if (typeof value === 'string') out.push([label, 'emptied', set('')]);
			if (typeof value === 'boolean') out.push([label, 'flipped', set(!value)]);
			if (typeof value === 'number') out.push([label, 'zeroed', set(0)]);
			if (Array.isArray(value)) out.push([label, 'emptied-array', set([])]);
		}
		if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
		else if (isObject(value)) {
			out.push([label, 'unknown-key', (d) => { at(d, path).__unknown = 1; }]);
			for (const [k, v] of Object.entries(value)) walk(v, [...path, k]);
		}
	};
	walk(doc, []);
	return out;
}

/** Why a mutant is not a defect when accepted, or null. `path` is dotted from the file's root. */
const SKIPPED = {
	'free-value': (path, kind) => kind === 'zeroed' && /(^|\.)(ms|startedAt)$/.test(path),
	'step-record': (path, kind, file, doc) => {
		const m = /^results\.(\d+)\.evidence(\.|$)/.exec(path);
		if (!m || !['drive.json', 'inner.json'].includes(file)) return false;
		if (file === 'drive.json' && doc.results[m[1]]?.id === 'no-egress' && path === `results.${m[1]}.evidence.canaryHits`) return false;
		return path !== `results.${m[1]}.evidence` || kind === 'unknown-key';
	},
	'one-assertion': (path, kind) => kind === 'deleted' && /^legs\.\d+\.asserted\.\d+$/.test(path),
};
const skipped = (file, path, kind, doc) => Object.entries(SKIPPED).find(([, f]) => f(path, kind, file, doc))?.[0] ?? null;

/** Runs the walk. Returns { cases: [{ case, status, got }], skips: { rule: n }, total }. */
export async function evidenceWalk(scratch = tmpdir()) {
	const cases = [], skips = {};
	const root = mkdtempSync(join(scratch, 'walk-'));
	try {
		const control = await gateWith(() => {}, root);
		const summary = control.summary;
		const targets = [...Object.keys(FILE_STEP).map((file) => ({ file, doc: validEvidence()[file] })), { file: 'summary.json', doc: summary }];
		for (const { file, doc } of targets) {
			if (!doc) { cases.push({ case: `${file}: control`, status: 'FAIL', got: `no control ${file}: ${control.lines.at(-1)}` }); continue; }
			for (const [path, kind, apply] of mutants(doc)) {
				const rule = skipped(file, path, kind, doc);
				if (rule) { skips[rule] = (skips[rule] ?? 0) + 1; continue; }
				const copy = structuredClone(doc);
				apply(copy);
				if (JSON.stringify(copy) === JSON.stringify(doc)) continue;
				let refused, got;
				if (file === 'summary.json') {
					try { got = gateSummaryProblem(copy, SHA); } catch (e) { got = null; refused = false; }
					refused = !!got;
				} else {
					// a gate that throws on a malformed file did not name the problem: that is a defect too
					const r = await gateWith((f) => { f[file] = copy; }, root).catch((e) => ({ crashed: String(e?.message ?? e).split('\n')[0] }));
					refused = !r.crashed && !r.pass && r.failed === FILE_STEP[file] && r.summary === null;
					got = r.crashed ? `the gate threw: ${r.crashed}` : r.pass ? 'accepted: GATE PASS' : r.failed !== FILE_STEP[file] ? `refused under ${r.failed}, not ${FILE_STEP[file]}` : r.lines.at(-1);
				}
				cases.push({ case: `${file}: ${path} ${kind}`, status: refused ? 'PASS' : 'FAIL', got: refused ? 'refused' : got ?? 'accepted' });
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	return { cases, skips, total: cases.length };
}

if (import.meta.main) {
	const { cases, skips, total } = await evidenceWalk();
	const bad = cases.filter((c) => c.status !== 'PASS');
	for (const c of bad.slice(0, 60)) console.log(`ACCEPTED ${c.case}: ${c.got}`);
	console.log(`not judged (free-form): ${Object.entries(skips).map(([k, n]) => `${k} ${n}`).join(', ')}; drive steps ${DRIVE_STEPS.length}`);
	console.log(bad.length ? `MUTATION WALK FAIL: ${bad.length} of ${total} mutants accepted or refused under the wrong step` : `MUTATION WALK PASS: ${total} mutants refused`);
	process.exit(bad.length ? 1 : 0);
}
