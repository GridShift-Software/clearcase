// scripts/verify/matrix.mjs (GRS-21) on synthetic, mutually stamped inputs. A view is PASS only when each input says its
// run finished: a layout run that stopped early (exit 2 with an error and no rows, as when the browser fails to launch)
// or lacks a view, a width or a shared component is BLOCKED and the script exits 1. No case data.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VIEWS } from '../../src/lib/components/view-registry';
import { COMPONENTS, WIDTHS } from '../../scripts/verify/layout-spec.mjs';

const script = path.resolve('scripts/verify/matrix.mjs');
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const W = (p: string, v: unknown) => { mkdirSync(path.dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v)); };
const fresh = { head: SHA, buildRevision: SHA, trackedDirty: false, buildDirty: false, fresh: true };
const stampOf = { head: SHA, dirty: false, build: { revision: SHA, dirty: false } };
const measure = { sideways: false, onHeading: [], overlaps: [] };
const layoutDoc = () => ({
	case: 'synthetic', revision: stampOf, widths: WIDTHS, exit: 0, shots: [], failures: [], shellContrast: {},
	views: VIEWS.map((v) => ({ view: v.id, label: { ok: true }, keyboard: { ok: true }, contrast: { main: { failCount: 0 }, nav: { failCount: 0 } }, widths: Object.fromEntries(WIDTHS.map((w) => [w, measure])) })),
	components: COMPONENTS.map(([name]) => ({ name, textOk: true, states: Object.fromEntries(['default', 'hover', 'focus-visible', 'active'].map((s) => [s, { text: 7 }])) })),
});
const parityDoc = () => ({
	revision: SHA, dirty: false, exit: 0, evidence: true, aborted: null, register: { strict: true },
	views: Object.fromEntries(VIEWS.map((v) => [v.id, { status: 'PASS', v5: 'ok', app: 'ok', compared: 3, matched: 3, registered: {}, unregistered: 0 }])),
});
const accDoc = () => ({ ok: true, offline: true, revision: stampOf, scenarios: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: `AC${i}-x`, view: 'overview', pass: true })) });
const e2eRoot = () => ({ ok: true, evidence: true, freshBuild: fresh, categories: { suites: ['system'] }, results: [] });
const category = () => ({ ok: true, freshBuild: fresh, scenarios: VIEWS.map((v) => ({ id: `S-${v.id}`, view: v.id, pass: true })) });

let dir: string;
const at = (...p: string[]) => path.join(dir, ...p);
beforeEach(() => {
	dir = mkdtempSync(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), 'cc-matrix-'));
	W(at('build.json'), { revision: SHA, dirty: false });
	W(at('parity.json'), parityDoc());
	W(at('e2e', 'summary.json'), e2eRoot());
	W(at('e2e', 'system', 'summary.json'), category());
	W(at('acc.json'), accDoc());
	W(at('layout.json'), layoutDoc());
	W(at('layout-v5.json'), layoutDoc());
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(sha = SHA) {
	const r = spawnSync(process.execPath, [script, '--sha', sha, '--build-stamp', at('build.json'), '--parity', at('parity.json'), '--e2e', at('e2e'), '--acceptance', at('acc.json'), '--layout', at('layout.json'), '--layout-v5', at('layout-v5.json'), '--out', at('matrix.md')], { encoding: 'utf8' });
	const rows = (() => { try { return readFileSync(at('matrix.md'), 'utf8').split('\n').filter((l) => /^\| \d+ \|/.test(l)); } catch { return []; } })();
	const count = (k: string) => rows.filter((l) => l.includes(`**${k}**`)).length;
	return { status: r.status, out: r.stdout + r.stderr, rows, pass: count('PASS'), fail: count('FAIL'), blocked: count('BLOCKED') };
}
const edit = (file: string, f: (d: any) => void) => { const d = JSON.parse(readFileSync(at(file), 'utf8')); f(d); W(at(file), d); };
const n = VIEWS.length;

describe('acceptance matrix', () => {
	it('passes every view on a complete, mutually stamped set', () => {
		const r = run();
		expect(r.status, r.out).toBe(0);
		expect([r.pass, r.fail, r.blocked]).toEqual([n, 0, 0]);
	});

	for (const file of ['layout.json', 'layout-v5.json']) {
		const early = { exit: 2, error: 'browser launch failed', views: [], components: [], failures: [] };
		it(`blocks every view when ${file} stopped early (exit 2, an error, no rows)`, () => {
			edit(file, (d) => Object.assign(d, early));
			const r = run();
			expect(r.status, r.out).toBe(1);
			expect([r.pass, r.fail, r.blocked]).toEqual([0, 0, n]);
		});
		it(`blocks the view that ${file} lacks, and only that view`, () => {
			edit(file, (d) => { d.views = d.views.filter((x: any) => x.view !== VIEWS[3].id); });
			const r = run();
			expect(r.status, r.out).toBe(1);
			expect([r.pass, r.fail, r.blocked]).toEqual([n - 1, 0, 1]);
			expect(r.rows[3]).toContain('**BLOCKED**');
		});
		it(`blocks the view that ${file} lacks a width for`, () => {
			edit(file, (d) => { delete d.views[5].widths[768]; });
			const r = run();
			expect(r.status, r.out).toBe(1);
			expect(r.rows[5]).toContain('**BLOCKED**');
			expect(r.rows[5]).toContain('width 768');
		});
		it(`blocks every view when ${file} lacks a shared component`, () => {
			edit(file, (d) => { d.components.pop(); });
			const r = run();
			expect(r.status, r.out).toBe(1);
			expect(r.blocked).toBe(n);
		});
		it(`blocks when ${file} exits 0 with a failure listed, or 1 with none`, () => {
			edit(file, (d) => { d.failures = ['overview@320: scrolls sideways']; });
			expect(run().blocked).toBe(n);
			edit(file, (d) => { d.failures = []; d.exit = 1; });
			expect(run().blocked).toBe(n);
		});
	}

	it('still reports a layout failure (exit 1) as a FAIL of its view', () => {
		edit('layout.json', (d) => { d.exit = 1; d.failures = [`${VIEWS[2].id}@320: scrolls sideways`]; });
		const r = run();
		expect(r.status, r.out).toBe(0);
		expect([r.pass, r.fail, r.blocked]).toEqual([n - 1, 1, 0]);
	});

	it('rejects a revision shorter than 12 characters, in --sha and in an input', () => {
		expect(run(SHA.slice(0, 8)).status).toBe(2);
		edit('layout.json', (d) => { d.revision.head = SHA.slice(0, 8); });
		const r = run();
		expect(r.status, r.out).toBe(1);
		expect(r.blocked).toBe(n);
	});

	it('does not count a category summary that carries no stamp for this revision, or one this run did not run', () => {
		edit('e2e/system/summary.json', (d) => { d.freshBuild.head = 'f'.repeat(40); });
		expect(run().blocked).toBe(n);
		edit('e2e/system/summary.json', (d) => { delete d.freshBuild; });
		expect(run().blocked).toBe(n);
		// a leftover directory the root summary does not list is ignored, not counted
		W(at('e2e', 'old', 'summary.json'), { scenarios: [{ id: 'old', view: 'overview', pass: false }] });
		edit('e2e/system/summary.json', (d) => { d.freshBuild = fresh; });
		expect(run().pass).toBe(n);
	});

	it('does not pass runs that did not finish: e2e evidence false, parity aborted or non-strict, acceptance online', () => {
		const cases: [string, (d: any) => void][] = [
			['e2e/summary.json', (d) => { d.evidence = false; }],
			['parity.json', (d) => { d.aborted = { step: 'x' }; }],
			['parity.json', (d) => { d.exit = 2; }],
			['parity.json', (d) => { d.register.strict = false; }],
			['acc.json', (d) => { d.offline = false; }],
		];
		for (const [file, f] of cases) {
			edit(file, f);
			expect(run().blocked, `${file} ${f}`).toBe(n);
			W(at(file), { 'e2e/summary.json': e2eRoot(), 'parity.json': parityDoc(), 'acc.json': accDoc() }[file]);
		}
	});

	it('fails every view when a run failed with no failing scenario to blame', () => {
		edit('e2e/summary.json', (d) => { d.ok = false; d.results = [{ name: 'system suite (offline)', rc: 1 }]; });
		const r = run();
		expect([r.pass, r.fail]).toEqual([0, n]);
	});
});
