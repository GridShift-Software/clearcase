// Round-trip property of the user-work backup (GRS-13 gate round 2): for seeded random multi-case stores with case and
// store tables, NULL cells, 64-bit integers, BLOBs and Unicode, exportAll() -> JSON -> importAll() is lossless into the
// same store after edits (case tables replace the snapshot's cases, store tables merge by key) and into a fresh store,
// and it never changes the active case or trust. Defined tables are written through putTableRow/deleteTableRow (round
// 3), and every definition must declare its scope. Out-of-band tables (NOCASE or RTRIM collations, NUMERIC columns,
// non-finite and numeric-text cells written through raw SQL, PRFIX-12) never make an export a restore refuses: each is
// exported and restores, or is excluded with a reason. Synthetic data only.
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCase } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import type { LocalCase } from './service.server.ts';
import { ackFor, cleanup, service, tempRoot } from './test-support.ts';
import { UserWorkError, type TableCell, type UserWorkExport } from './user-work.server.ts';

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
/** A generated value as a table cell: BigInts beyond the safe range as `$int`, bytes as `$b64` (as exportAll writes). */
const cell = (v: bigint | Uint8Array | string | number | null): TableCell =>
	typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : { $int: String(v) }) : v instanceof Uint8Array ? { $b64: Buffer.from(v).toString('base64') } : v;
const GRS17 = { owner: 'GRS-17' };
const GRS18 = { owner: 'GRS-18' };

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
	for (const caseId of cases) {
		for (let i = r.int(3); i >= 0; i--) await uw.addNote(caseId, rv, 'OD-001', `${r.text()} note`);
		for (let i = r.int(4); i >= 0; i--) await uw.putRow(caseId, r.pick(['deadlines', 'privilege-log', 'time']), null, { title: r.text(), n: r.int(1000), done: r.next() < 0.5, empty: null });
		await uw.putSeedOverlay({ caseId, datasetKey: 'ds', seedId: `${tag}-${caseId}`, baseSeedSha256: 'a'.repeat(64), fields: { label: r.text() } });
		for (let i = r.int(6); i >= 0; i--) {
			await uw.putTableRow('entry', { case_id: caseId, entry_id: `${tag}-e${i}-${r.text(3)}`, hours: r.maybe(() => r.next() * 1e6 - 5e5), big: cell(r.maybe(r.big)), blob: cell(r.maybe(r.bytes)), memo: r.maybe(r.text) }, GRS17);
			await uw.putTableRow('ledger', { id: `${tag}-${caseId}-l${i}`, case_id: caseId, amount: cell(r.maybe(r.big)), memo: r.maybe(r.text) }, GRS17);
		}
		// trust has no write API here (activation writes it); a restore must never create it
		lc.storage.db().prepare('INSERT OR REPLACE INTO work.trusted_warning VALUES (?, ?, ?)').run(caseId, `fp-${tag}-${r.int(1e6)}`, '2030-01-01T00:00:00Z');
	}
	for (let i = r.int(6); i >= 0; i--) {
		await uw.putTableRow('pref', { k: `${tag}-${r.text(4)}`, v: r.maybe(r.text), n: r.maybe(() => r.next()) }, GRS18);
		await uw.putTableRow('tally', { n: cell(r.big()), big: cell(r.maybe(r.big)), b: cell(r.maybe(r.bytes)) }, GRS18);
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
			// the scope is required: an owner cannot get a store table by forgetting it
			const loose = { name: 'loose', owner: 'GRS-17', description: '', columns: [{ name: 'id', type: 'TEXT' }, { name: 'case_key', type: 'TEXT' }], primaryKey: ['id'] };
			await expect(uw.defineTable(loose as never)).rejects.toSatisfy((e) => e instanceof UserWorkError && e.code === 'invalid');
			expect(uw.tables().some((t) => t.name === 'loose')).toBe(false);
			await uw.defineTable({ name: 'entry', owner: 'GRS-17', description: 'per-case, composite key', scope: 'case', columns: [{ name: 'case_id', type: 'TEXT' }, { name: 'entry_id', type: 'TEXT' }, { name: 'hours', type: 'REAL' }, { name: 'big', type: 'INTEGER' }, { name: 'blob', type: 'BLOB' }, { name: 'memo', type: 'TEXT' }], primaryKey: ['case_id', 'entry_id'] });
			await uw.defineTable({ name: 'ledger', owner: 'GRS-17', description: 'per-case, single key', scope: 'case', columns: [{ name: 'id', type: 'TEXT' }, { name: 'case_id', type: 'TEXT', notNull: true }, { name: 'amount', type: 'INTEGER' }, { name: 'memo', type: 'TEXT' }], primaryKey: ['id'] });
			await uw.defineTable({ name: 'pref', owner: 'GRS-18', description: 'store-wide', columns: [{ name: 'k', type: 'TEXT' }, { name: 'v', type: 'TEXT' }, { name: 'n', type: 'REAL' }], primaryKey: ['k'], scope: 'store' });
			await uw.defineTable({ name: 'tally', owner: 'GRS-18', description: 'store-wide, 64-bit key', columns: [{ name: 'n', type: 'INTEGER' }, { name: 'big', type: 'INTEGER' }, { name: 'b', type: 'BLOB' }], primaryKey: ['n'], scope: 'store' });
			const cases = ['e2e-case', 'case-β', `case-${r.int(100)}`];
			await populate(lc, r, c.resultsVersion, cases, 's');
			const active = lc.effectiveActive('e2e-case');

			const snap = json(uw.exportAll());
			expect(snap.excluded).toEqual([]);
			expect(snap.tables.find((t) => t.name === 'tally')!.rows.some((x) => typeof x.n === 'object')).toBe(true); // 64-bit keys present
			// listTableRows reads back exactly what the export holds: one case's rows of a case table, all of a store table
			for (const name of ['entry', 'ledger']) for (const caseId of cases) expect(uw.listTableRows(name, { caseId })).toEqual(snap.tables.find((t) => t.name === name)!.rows.filter((x) => x.case_id === caseId));
			for (const name of ['pref', 'tally']) expect(uw.listTableRows(name)).toEqual(snap.tables.find((t) => t.name === name)!.rows);

			// edits after the backup: changed, deleted and added rows in the snapshot's cases, a new case, store-wide rows
			for (const row of uw.listTableRows('entry', { caseId: cases[0]! })) await uw.putTableRow('entry', { ...row, memo: 'edited', blob: null }, GRS17);
			const gone = uw.listTableRows('ledger', { caseId: cases[0]! })[0]!;
			expect(await uw.deleteTableRow('ledger', { id: gone.id!, case_id: cases[0]! }, GRS17)).toBe(true);
			for (const row of uw.listTableRows('pref')) await uw.putTableRow('pref', { ...row, v: 'edited' }, GRS18);
			expect(await uw.deleteTableRow('tally', { n: uw.listTableRows('tally')[0]!.n! }, GRS18)).toBe(true);
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

	// numeric text written through raw SQL: SQLite's affinity makes some of it a non-finite or a large number
	const EDGE = ['1e999', '-1e999', 'NaN', 'Infinity', '-Infinity', ' 1e999 ', '1e308', '99999999999999999999', `1${'0'.repeat(400)}`, '7', '7.0', '-0', '0x10'];
	for (const seed of [3, 11, 99, 2027]) {
		it(`seed ${seed}: out-of-band collations and numeric edge cells: the export restores here and fresh, and each exclusion says why`, async () => {
			const r = rng(seed);
			const { lc } = await fresh(`oob${seed}`);
			const uw = lc.userWork;
			const db = lc.storage.db();
			await uw.defineTable({ name: 'gauge', owner: 'GRS-17', description: 'API-written edge cells', scope: 'store', columns: [{ name: 'id', type: 'TEXT' }, { name: 'r', type: 'REAL' }, { name: 'n', type: 'INTEGER' }, { name: 'b', type: 'BLOB' }], primaryKey: ['id'] });
			// the API refuses an edge cell SQLite would store as a non-finite number, and keeps every other row exportable
			for (let i = 0; i < 12; i++) {
				const row = { id: `g${i}`, r: r.next() < 0.5 ? r.pick(EDGE) : r.next(), n: r.next() < 0.5 ? r.pick(EDGE) : r.int(1e6), b: r.pick(EDGE) };
				try { await uw.putTableRow('gauge', row, GRS17); } catch (e) { expect(e).toBeInstanceOf(UserWorkError); expect((e as UserWorkError).code).toBe('invalid'); }
			}
			const COLL = ['', '', '', ' COLLATE NOCASE', ' COLLATE RTRIM', ' COLLATE BINARY'];
			const keyColl = () => (r.next() < 0.3 ? r.pick(COLL) : '');
			const TYPES = ['TEXT', 'INTEGER', 'REAL', 'BLOB', 'TEXT', 'INTEGER', 'REAL', 'BLOB', 'NUMERIC'];
			for (let t = 0; t < 12; t++) {
				const name = `oob_${seed}_${t}`;
				const caseCol = r.next() < 0.3;
				const cols = [{ name: 'id', type: r.pick(['TEXT', 'TEXT', 'INTEGER', 'REAL']), coll: keyColl() }, ...(caseCol ? [{ name: 'case_id', type: 'TEXT NOT NULL', coll: keyColl() }] : []),
					...Array.from({ length: r.int(3) + 1 }, (_, i) => ({ name: `c${i}`, type: r.pick(TYPES), coll: r.pick(COLL) }))];
				const keyInClause = r.next() < 0.5;
				const pkColl = keyInClause ? keyColl() : '';
				db.exec(`CREATE TABLE work.${name}(${cols.map((c, i) => `${c.name} ${c.type}${c.coll}${i === 0 && !keyInClause ? ' PRIMARY KEY NOT NULL' : i === 0 ? ' NOT NULL' : ''}`).join(', ')}${keyInClause ? `, PRIMARY KEY(id${pkColl})) WITHOUT ROWID` : ')'}`);
				// some are catalogued by hand, as a table a later ticket adopted (a case table needs a recorded scope)
				if (r.next() < 0.4) {
					db.prepare("INSERT INTO work.userwork_catalog(name, kind, owner, description) VALUES (?, 'user-work', 'GRS-18', '')").run(name);
					if (caseCol && r.next() < 0.5) db.prepare("INSERT INTO work.userwork_catalog_scope(name, scope) VALUES (?, 'case')").run(name);
				}
				const value = () => r.next() < 0.08 ? r.pick(EDGE) : r.next() < 0.5 ? r.text(4) : r.next() < 0.5 ? r.int(1000) : null;
				const ins = db.prepare(`INSERT OR IGNORE INTO work.${name} VALUES (${cols.map(() => '?').join(', ')})`);
				// SQLite refuses some generated rows itself (a non-integer INTEGER PRIMARY KEY): those are skipped
				for (let i = r.int(6); i >= 0; i--) try { ins.run(...(cols.map((c) => (c.name === 'id' ? (r.next() < 0.05 ? r.pick(EDGE) : r.pick(['a', 'A', 'a ', `k${i}`, `${i}`])) : c.name === 'case_id' ? r.pick(['A', 'a', 'B']) : value())) as never[])); } catch (e) { expect(String(e)).toMatch(/datatype mismatch/); }
			}
			const snap = json(uw.exportAll());
			for (const x of snap.excluded!) expect(x.reason, x.name).toMatch(/\w/);
			expect(snap.tables.length + snap.excluded!.length).toBe(uw.tables().filter((t) => t.kind !== 'activation').length);
			// into the same store, in both modes: nothing throws and the export is unchanged
			for (const replace of ['cases', 'tables'] as const) {
				await uw.importAll(json(snap), { replace });
				expect(sortedRows(json(uw.exportAll()))).toEqual(sortedRows(snap));
			}
			// into a fresh store: every exported table and row comes back (trust is never created)
			const { lc: lc2 } = await fresh(`oob${seed}b`);
			await lc2.userWork.importAll(json(snap));
			const back = json(lc2.userWork.exportAll());
			expect(back.excluded).toEqual([]);
			expect(sortedRows(back)).toEqual(new Map([...sortedRows(snap)].map(([n, rows]) => [n, n === 'trusted_warning' ? [] : rows])));
			await lc2.userWork.importAll(json(back));
		});
	}
});
