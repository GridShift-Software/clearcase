// scripts/verify/register-dispositions.mjs keeps approvals and fails closed (GRS-67, fix round): a rerun never clears
// approvedBy/approvedOn, and --check fails on a defect with no disposition, a disposition for a defect that is gone, and
// an empty evidence pattern. Each case runs the script on a synthetic copy of docs/reference (--reference), never on the
// committed register.
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
		edit(FILE, (d) => { const e = d.entries.find((x) => x.author?.startsWith('GRS-67 dispositions'))!; e.approvedBy = 'dianbrown'; e.approvedOn = '2026-10-20'; e.reason = 'stale'; });
		expect(run('--check').status).toBe(1);
		expect(run().status).toBe(0);
		const e = mine(FILE)[0]!;
		expect(e.reason).not.toBe('stale');
		expect([e.approvedBy, e.approvedOn]).toEqual(['dianbrown', '2026-10-20']);
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

	it('fails on an empty evidence pattern', () => {
		// the script's own table: a copy of it with one pattern emptied, run against the same synthetic reference
		const copy = join(REPO, 'scripts', 'verify', `.empty-pattern-${process.pid}.mjs`);
		const src = readFileSync(SCRIPT, 'utf8').replace('"export const asOfStatus = (r: PrescRow, asOf: string)"', '""');
		expect(src).not.toBe(readFileSync(SCRIPT, 'utf8'));
		writeFileSync(copy, src);
		try {
			const x = spawnSync(BUN, [copy, '--reference', ref, '--check'], { encoding: 'utf8', timeout: 60_000 });
			expect(x.status).toBe(1);
			expect(`${x.stdout}${x.stderr}`).toContain('S-prescription-frozen: empty evidence pattern');
		} finally {
			rmSync(copy, { force: true });
		}
	});
});
