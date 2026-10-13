// scripts/verify/register-dispositions.mjs keeps approvals and fails closed (GRS-67, fix rounds): a rerun keeps
// approvedBy/approvedOn while the entry's view, type, productVisible and reason are unchanged, and resets them (naming the
// entry) when one changes. --check fails on a defect with no disposition, a disposition for a defect that is gone (in any
// form of an empty field), a defects.md row that does not parse, and an empty evidence pattern. Each case runs the script
// on a synthetic copy of docs/reference (--reference), never on the committed register.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..');
const SCRIPT = join(REPO, 'scripts', 'verify', 'register-dispositions.mjs');
const BUN = process.versions.bun ? process.execPath : 'bun';
const work = mkdtempSync(join(tmpdir(), 'dispositions-'));
const ref = join(work, 'reference');
afterAll(() => rmSync(work, { recursive: true, force: true }));
beforeEach(() => {
	rmSync(ref, { recursive: true, force: true });
	cpSync(join(REPO, 'docs', 'reference'), ref, { recursive: true });
});

type Entry = { id: string; source?: string; author?: string; approvedBy: string | null; approvedOn: string | null; [k: string]: unknown };
const run = (...args: string[]) => {
	const x = spawnSync(BUN, [SCRIPT, '--reference', ref, ...args], { encoding: 'utf8', timeout: 60_000 });
	return { status: x.status, out: `${x.stdout}${x.stderr}` };
};
const mine = (file: string) => (JSON.parse(readFileSync(join(ref, 'parity', file), 'utf8')) as { entries: Entry[] }).entries.filter((e) => e.author?.startsWith('GRS-67 dispositions'));
const edit = (file: string, f: (doc: { entries: Entry[] }) => void) => {
	const path = join(ref, 'parity', file);
	const doc = JSON.parse(readFileSync(path, 'utf8')) as { entries: Entry[] };
	f(doc);
	writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
};
const FILE = 'register/CC-07.json';

describe('register-dispositions --check', () => {
	it('passes on the committed register', () => {
		expect(run('--check')).toMatchObject({ status: 0 });
	});

	it('keeps an approval through a rerun, and does not report the approval as drift', () => {
		edit(FILE, (d) => { const e = d.entries.find((x) => x.author?.startsWith('GRS-67 dispositions'))!; e.approvedBy = 'dianbrown'; e.approvedOn = '2026-10-20'; });
		expect(run('--check')).toMatchObject({ status: 0 });
		expect(run()).toMatchObject({ status: 0 });
		const e = mine(FILE)[0]!;
		expect([e.approvedBy, e.approvedOn]).toEqual(['dianbrown', '2026-10-20']);
		expect(run('--check')).toMatchObject({ status: 0 });
	});

	it('keeps an approval when a rerun rewrites the entry because its evidence moved', () => {
		edit(FILE, (d) => { const e = d.entries.find((x) => x.author?.startsWith('GRS-67 dispositions'))!; e.approvedBy = 'dianbrown'; e.approvedOn = '2026-10-20'; e.reason = String(e.reason).replace(/Evidence: .*$/, 'Evidence: moved.ts:1.'); });
		expect(run('--check').status).toBe(1);
		expect(run().status).toBe(0);
		const e = mine(FILE)[0]!;
		expect(e.reason).not.toContain('moved.ts');
		expect([e.approvedBy, e.approvedOn]).toEqual(['dianbrown', '2026-10-20']);
	});

	it.each([
		['type', (e: Entry) => { e.type = e.type === 'known-gap' ? 'defect-fix' : 'known-gap'; }],
		['productVisible', (e: Entry) => { e.productVisible = !e.productVisible; }],
		['reason', (e: Entry) => { e.reason = `${String(e.reason).replace(/ Evidence: .*$/, '')} Changed.`; }],
		['view', (e: Entry) => { e.view = e.view === 'overview' ? 'chronology' : 'overview'; }],
	])('resets an approval when a rerun rewrites the entry because its %s changed, and names it', (_what, change) => {
		edit(FILE, (d) => { const e = d.entries.find((x) => x.author?.startsWith('GRS-67 dispositions'))!; e.approvedBy = 'dianbrown'; e.approvedOn = '2026-10-20'; change(e); });
		const first = mine(FILE)[0]!;
		const r = run();
		expect(r.status).toBe(0);
		expect(r.out).toContain('approval reset');
		expect(r.out).toContain(first.id);
		const e = mine(FILE)[0]!;
		expect([e.approvedBy, e.approvedOn]).toEqual([null, null]);
	});

	it('still reports a real change in an entry as drift', () => {
		edit(FILE, (d) => { d.entries.find((x) => x.author?.startsWith('GRS-67 dispositions'))!.reason = 'edited by hand'; });
		const r = run('--check');
		expect(r.status).toBe(1);
		expect(r.out).toContain('differs');
	});

	it('fails on a defect with no disposition', () => {
		// a new defect nobody has named: the checklist is the source dispositions.mjs reads it from
		const path = join(ref, 'view-checklist.md');
		writeFileSync(path, `${readFileSync(path, 'utf8')}\n  - \`S-overview-99\` (low) a synthetic defect no entry names\n`);
		const r = run('--check');
		expect(r.status).toBe(1);
		expect(r.out).toContain('S-overview-99: no disposition');
	});

	it('fails on a disposition for a defect that no longer exists', () => {
		const path = join(ref, 'view-checklist.md');
		writeFileSync(path, readFileSync(path, 'utf8').replace(/^\s*- `S-rescan_tab-5` .*\n/m, ''));
		const r = run('--check');
		expect(r.status).toBe(1);
		expect(r.out).toContain('S-rescan_tab-5: no such defect');
	});

	it('fails on a hand-written disposition of a defect that is gone', () => {
		edit('intentional-differences.json', (d) => { d.entries.push({ id: 'IDR-095', view: 'overview', field: [], type: 'defect-fix', source: 'S-overview-98', reason: 'a stale disposition', productVisible: false, author: 'someone', approvedBy: null, approvedOn: null }); });
		const r = run('--check');
		expect(r.status).toBe(1);
		expect(r.out).toContain('IDR-095: disposition of S-overview-98');
	});

	it('fails on a defects.md row that does not parse', () => {
		const path = join(ref, 'defects.md');
		writeFileSync(path, `${readFileSync(path, 'utf8')}\n| S-zzprobe-1 | high | a synthetic row with too few cells |\n`);
		const r = run('--check');
		expect(r.status).toBe(1);
		expect(r.out).toContain('S-zzprobe-1 does not parse');
	});

	it.each([
		['an empty string', { field: '' }],
		['a null field', { field: null }],
		['no field', {}],
	])('fails on a hand-written disposition with %s of a defect that is gone', (_what, form) => {
		edit('intentional-differences.json', (d) => { d.entries.push({ id: 'IDR-095', view: 'overview', type: 'defect-fix', source: 'S-overview-98', reason: 'a stale entry', productVisible: false, author: 'someone', approvedBy: null, approvedOn: null, ...form }); });
		const r = run('--check');
		expect(r.status).toBe(1);
		expect(r.out).toContain('IDR-095: disposition of S-overview-98');
	});

	it('fails on an empty evidence pattern', () => {
		// the script's own table: a copy of it in the temp dir with one pattern emptied and its imports made absolute
		const copy = join(work, 'empty-pattern.mjs');
		const original = readFileSync(SCRIPT, 'utf8');
		const abs = (rel: string) => JSON.stringify(join(REPO, 'scripts', 'verify', rel));
		const src = original
			.replace('"export const asOfStatus = (r: PrescRow, asOf: string)"', '""')
			.replace(`'../parity/lib/register.mjs'`, abs('../parity/lib/register.mjs'))
			.replace(`'./lib/defects.mjs'`, abs('lib/defects.mjs'))
			.replace(`'../../src/lib/components/view-registry.ts'`, abs('../../src/lib/components/view-registry.ts'))
			.replace(`resolve(import.meta.dirname, '..', '..')`, JSON.stringify(REPO));
		expect(src).not.toBe(original);
		writeFileSync(copy, src);
		const x = spawnSync(BUN, [copy, '--reference', ref, '--check'], { encoding: 'utf8', timeout: 60_000, cwd: REPO });
		expect(x.status).toBe(1);
		expect(`${x.stdout}${x.stderr}`).toContain('S-prescription-frozen: empty evidence pattern');
	});
});
