// Round-trip property of the user-work backup (GRS-13 gate round 2): for seeded random multi-case stores with case and
// store tables, NULL cells, 64-bit integers, BLOBs and Unicode, exportAll() -> JSON -> importAll() is lossless into the
// same store after edits (case tables replace the snapshot's cases, store tables merge by key) and into a fresh store,
// and it never changes the active case or trust. Synthetic data only.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, service, tempRoot } from './test-support.ts';
import type { UserWorkExport } from './user-work.server.ts';

const roots: string[] = [];
const open: LocalCase[] = [];
afterEach(async () => {
	for (const lc of open.splice(0)) lc.shutdown();
	for (const r of roots.splice(0)) await cleanup(r);
});
async function fresh(tag: string) {
	const root = await tempRoot(tag);
	roots.push(root);
	const lc = service(path.join(root, 'data'));
	open.push(lc);
	await lc.startup();
	return { root, lc };
}

/** mulberry32: a small seeded PRNG, so a failing seed reproduces. */
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
	const int = (n: number) => Math.floor(next() * n);
	const pick = <T,>(xs: readonly T[]) => xs[int(xs.length)]!;
	const GLYPHS = ['a', 'Z', '0', ' ', '\n', '"', '\\', "'", 'é', 'ß', '中', '文', 'ж', 'ע', '́', '‮', '🙂', '👩‍⚖️', '𝔘'];
	const text = (max = 12) => Array.from({ length: int(max) + 1 }, () => pick(GLYPHS)).join('');
	const big = () => BigInt.asIntN(64, (BigInt(int(2 ** 32)) << 32n) | BigInt(int(2 ** 32)));
	const bytes = () => new Uint8Array(Array.from({ length: int(17) }, () => int(256)));
	const maybe = <T,>(v: () => T) => (next() < 0.25 ? null : v());
	return { next, int, pick, text, big, bytes, maybe };
}

type Snap = UserWorkExport;
type Row = Snap['tables'][number]['rows'][number];
const keyOf = (t: Snap['tables'][number], r: Row) => JSON.stringify(t.columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => r[c.name]));
const json = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** What a default ('cases') restore of `snap` into a store whose export was `edited` must leave. */
function expected(snap: Snap, edited: Snap): Map<string, Row[]> {
	const cases = new Set(snap.tables.filter((t) => t.scope === 'case' && t.name !== 'trusted_warning').flatMap((t) => t.rows.map((r) => r.case_id as string)));
	const out = new Map<string, Row[]>();
	for (const e of edited.tables) {
		const s = snap.tables.find((t) => t.name === e.name);
		if (!s || s.name === 'trusted_warning') { out.set(e.name, e.rows); continue; }
		const keys = new Set(s.rows.map((r) => keyOf(s, r)));
		const kept = s.scope === 'case' ? e.rows.filter((r) => !cases.has(r.case_id as string)) : e.rows.filter((r) => !keys.has(keyOf(s, r)));
		out.set(e.name, [...kept, ...s.rows].sort((a, b) => (keyOf(s, a) < keyOf(s, b) ? -1 : 1)));
	}
	return out;
}
const sortedRows = (x: Snap) => new Map(x.tables.map((t) => [t.name, [...t.rows].sort((a, b) => (keyOf(t, a) < keyOf(t, b) ? -1 : 1))]));

async function populate(lc: LocalCase, r: ReturnType<typeof rng>, rv: string, cases: string[], tag: string) {
	const uw = lc.userWork;
	const db = lc.storage.db();
	for (const caseId of cases) {
		for (let i = r.int(3); i >= 0; i--) await uw.addNote(caseId, rv, 'OD-001', `${r.text()} note`);
		for (let i = r.int(4); i >= 0; i--) await uw.putRow(caseId, r.pick(['deadlines', 'privilege-log', 'time']), null, { title: r.text(), n: r.int(1000), done: r.next() < 0.5, empty: null });
		await uw.putSeedOverlay({ caseId, datasetKey: 'ds', seedId: `${tag}-${caseId}`, baseSeedSha256: 'a'.repeat(64), fields: { label: r.text() } });
		for (let i = r.int(6); i >= 0; i--) {
			db.prepare('INSERT OR REPLACE INTO work.entry VALUES (?, ?, ?, ?, ?, ?)').run(caseId, `${tag}-e${i}-${r.text(3)}`, r.maybe(() => r.next() * 1e6 - 5e5), r.maybe(r.big), r.maybe(r.bytes), r.maybe(r.text));
			db.prepare('INSERT OR REPLACE INTO work.ledger VALUES (?, ?, ?, ?)').run(`${tag}-${caseId}-l${i}`, caseId, r.maybe(r.big), r.maybe(r.text));
		}
		db.prepare('INSERT OR REPLACE INTO work.trusted_warning VALUES (?, ?, ?)').run(caseId, `fp-${tag}-${r.int(1e6)}`, '2030-01-01T00:00:00Z');
	}
	for (let i = r.int(6); i >= 0; i--) {
		db.prepare('INSERT OR REPLACE INTO work.pref VALUES (?, ?, ?)').run(`${tag}-${r.text(4)}`, r.maybe(r.text), r.maybe(() => r.next()));
		db.prepare('INSERT OR REPLACE INTO work.tally VALUES (?, ?, ?)').run(r.big(), r.maybe(r.big), r.maybe(r.bytes));
	}
}

describe('user-work backup round trip (property, seeded)', () => {
	for (const seed of [1, 7, 42, 2026]) {
		it(`seed ${seed}: lossless into the same store after edits and into a fresh store; active case and trust kept`, async () => {
			const r = rng(seed);
			const { root, lc } = await fresh(`rt${seed}`);
			const c = await buildCase(path.join(root, 'c'));
			const imp = await lc.importPackage(c.caseDir, c.pkgDir);
			expect(await lc.activate(c.resultsVersion, ackFor(lc, imp.importId))).toBeNull();
			const uw = lc.userWork;
			await uw.defineTable({ name: 'entry', owner: 'GRS-17', description: 'per-case, composite key', scope: 'case', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }, { name: 'hours', type: 'REAL' }, { name: 'big', type: 'INTEGER' }, { name: 'blob', type: 'BLOB' }, { name: 'memo', type: 'TEXT' }], primaryKey: ['case_id', 'entry_id'] });
			await uw.defineTable({ name: 'ledger', owner: 'GRS-17', description: 'per-case, single key', scope: 'case', columns: [{ name: 'id', type: 'TEXT' }, { name: 'case_id', type: 'TEXT', notNull: true }, { name: 'amount', type: 'INTEGER' }, { name: 'memo', type: 'TEXT' }], primaryKey: ['id'] });
			await uw.defineTable({ name: 'pref', owner: 'GRS-18', description: 'store-wide', columns: [{ name: 'k', type: 'TEXT' }, { name: 'v', type: 'TEXT' }, { name: 'n', type: 'REAL' }], primaryKey: ['k'] });
			await uw.defineTable({ name: 'tally', owner: 'GRS-18', description: 'store-wide, 64-bit key', columns: [{ name: 'n', type: 'INTEGER' }, { name: 'big', type: 'INTEGER' }, { name: 'b', type: 'BLOB' }], primaryKey: ['n'] });
			const cases = ['e2e-case', 'case-β', `case-${r.int(100)}`];
			await populate(lc, r, c.resultsVersion, cases, 's');
			const active = lc.effectiveActive('e2e-case');

			const snap = json(uw.exportAll());
			expect(snap.excluded).toEqual([]);
			expect(snap.tables.find((t) => t.name === 'tally')!.rows.some((x) => typeof x.n === 'object')).toBe(true); // 64-bit keys present

			// edits after the backup: changed, deleted and added rows in the snapshot's cases, a new case, store-wide rows
			const db = lc.storage.db();
			db.prepare("UPDATE work.entry SET memo = 'edited', blob = NULL WHERE case_id = ?").run(cases[0]!);
			db.prepare('DELETE FROM work.ledger WHERE id IN (SELECT id FROM work.ledger LIMIT 1)').run();
			db.exec("UPDATE work.pref SET v = 'edited'; DELETE FROM work.tally WHERE n IN (SELECT n FROM work.tally LIMIT 1)");
			await populate(lc, r, c.resultsVersion, [cases[1]!, 'case-new'], 'p');
			const edited = json(uw.exportAll());
			const trustOf = (l: LocalCase) => Object.fromEntries([...cases, 'case-new'].map((x) => [x, [...l.trustedFor(x)].sort()]));
			const trust = trustOf(lc);
			expect(trust['case-new']).toHaveLength(1);

			// the edits matter: the restore has rows to put back, and rows of another case and other keys to keep
			expect(sortedRows(edited)).not.toEqual(expected(snap, edited));
			expect(['entry', 'ledger', 'note'].map((n) => expected(snap, edited).get(n)!.some((x) => x.case_id === 'case-new'))).toEqual([true, true, true]);
			const res = await uw.importAll(json(snap));
			const after = json(uw.exportAll());
			expect(sortedRows(after)).toEqual(expected(snap, edited));
			expect(res.cases).toEqual([...cases].sort());
			// restoring again changes nothing
			await uw.importAll(json(snap));
			expect(json(uw.exportAll()).tables).toEqual(after.tables);
			expect(lc.effectiveActive('e2e-case')).toBe(active);
			expect(trustOf(lc)).toEqual(trust);

			// a fresh store: every table, its metadata and every row come back; trust is never created
			const { lc: lc2 } = await fresh(`rt${seed}b`);
			await lc2.userWork.importAll(json(snap));
			const back = json(lc2.userWork.exportAll());
			expect(back.tables.map(({ rows, ...meta }) => meta)).toEqual(snap.tables.map(({ rows, ...meta }) => meta));
			expect(back.tables.map((t) => [t.name, t.rows])).toEqual(snap.tables.map((t) => [t.name, t.name === 'trusted_warning' ? [] : t.rows]));
			expect(cases.map((x) => lc2.trustedFor(x).size)).toEqual(cases.map(() => 0));
			// and the restored store's own backup restores into itself
			await lc2.userWork.importAll(json(back));
			expect(json(lc2.userWork.exportAll()).tables).toEqual(back.tables);
		});
	}
});
