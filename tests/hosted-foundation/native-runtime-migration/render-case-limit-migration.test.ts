// Synthetic SQLite only: no provider, Wrangler or D1. Every row below is invented for this file.
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import {
	assembleNativeRuntimeMigration, NATIVE_RUNTIME_MIGRATION_INPUTS, NATIVE_RUNTIME_INITIAL_SCHEMA, NATIVE_RUNTIME_MIGRATION_SOURCE,
	prepareNativeRuntimeMigration, readNativeRuntimeMigration,
	assembleNativeRenderCaseLimitMigration as assemble, prepareNativeRenderCaseLimitMigration as prepare,
	readNativeRenderCaseLimitMigration as read, checkNativeRenderCaseLimitMigrationInvocation as check,
	NATIVE_RENDER_CASE_LIMIT_MIGRATION_INPUTS as PINS, NATIVE_RENDER_CASE_LIMIT_MIGRATION_MODE as MODE,
	NATIVE_RENDER_CASE_LIMIT_MIGRATION_SOURCE as SOURCE, NATIVE_RENDER_CASE_LIMIT_APPLIED_RUNTIME as APPLIED,
} from '../../../deploy/native-alpha/runtime-migration.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const INPUT = 'src/lib/viewer/hosted/migrations/0002_preview_render_case_limit.sql';
const scratch: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'cc-render-case-limit-')); scratch.push(dir); return dir; };
afterEach(() => { for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true }); });
const read0 = (p: string) => readFileSync(path.join(root, p));
const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
const sources = () => PINS.map(pin => ({ path: pin.path, bytes: read0(pin.path) }));
const DAY_MS = 86_400_000, D = 20_000;

/** The applied chain: unchanged initial schema, then the applied 0002 runtime increment. */
function appliedChain() {
	const db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys=ON');
	db.exec(assembleNativeSchema(NATIVE_SCHEMA_INPUTS.map(pin => ({ path: pin.path, bytes: read0(pin.path) }))).sql);
	db.exec(assembleNativeRuntimeMigration(NATIVE_RUNTIME_MIGRATION_INPUTS.map(pin => ({ path: pin.path, bytes: read0(pin.path) }))).sql);
	return db;
}
type Res = { token: string; client: string; caseId: string; at: number; lease: number; caseLimit: number; clientLimit: number };
const reservationSql = `INSERT INTO npr_reservations (token,client_id,case_id,candidate_id,results_version,asset_id,input_sha256,input_size,renderer_version,binding_sha256,day,started_ms,lease_ms,case_limit,client_limit)
	VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const binding = (token: string) => sha(`synthetic-binding:${token}`);
function reserve(db: DatabaseSync, r: Res) {
	db.prepare(reservationSql).run(r.token, r.client, r.caseId, `cand-${r.caseId}`, `sha256:${'e'.repeat(64)}`, `asset-${r.token}`, sha(`input:${r.caseId}`), 4321,
		'synthetic-renderer', binding(r.token), Math.floor(r.at / DAY_MS), r.at, r.lease, r.caseLimit, r.clientLimit);
}
const transcript = (token: string) => JSON.stringify({ synthetic: true, token, pages: [{ number: 1, width: 100, height: 200 }] });
function succeed(db: DatabaseSync, r: Res, elapsed: number) {
	db.prepare('INSERT INTO npr_success_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(binding(r.token), r.token, r.client, r.caseId, `cand-${r.caseId}`,
		`sha256:${'e'.repeat(64)}`, `asset-${r.token}`, sha(`input:${r.caseId}`), 4321, 'synthetic-renderer', r.at + elapsed, 1, 20_000, transcript(r.token), sha(transcript(r.token)));
}
const start = D * DAY_MS + 3_600_000;
// Client A: one earlier-day run, then its whole day of 4 at the 20 s lease. Client B: two same-case runs at the 10 s lease.
const HISTORY: Res[] = [
	{ token: 'syn-a-0', client: 'client-a', caseId: 'case-a1', at: start - DAY_MS, lease: 82_000, caseLimit: 2, clientLimit: 4 },
	{ token: 'syn-a-1', client: 'client-a', caseId: 'case-a1', at: start, lease: 82_000, caseLimit: 2, clientLimit: 4 },
	{ token: 'syn-a-2', client: 'client-a', caseId: 'case-a2', at: start + 82_000, lease: 82_000, caseLimit: 2, clientLimit: 4 },
	{ token: 'syn-a-3', client: 'client-a', caseId: 'case-a2', at: start + 164_000, lease: 82_000, caseLimit: 2, clientLimit: 4 },
	{ token: 'syn-a-4', client: 'client-a', caseId: 'case-a1', at: start + 246_000, lease: 82_000, caseLimit: 2, clientLimit: 4 },
	{ token: 'syn-b-1', client: 'client-b', caseId: 'case-b1', at: start, lease: 72_000, caseLimit: 2, clientLimit: 2 },
	{ token: 'syn-b-2', client: 'client-b', caseId: 'case-b1', at: start + 72_000, lease: 72_000, caseLimit: 2, clientLimit: 2 },
];
function populated() {
	const db = appliedChain();
	for (const r of HISTORY) reserve(db, r);
	succeed(db, HISTORY[3]!, 9_876);
	succeed(db, HISTORY[5]!, 4_321);
	return db;
}
const TABLES = { npr_reservations: 'token', npr_case_days: 'client_id, case_id', npr_client_days: 'client_id', npr_success_receipts: 'binding_sha256' } as const;
const facts = (db: DatabaseSync) => Object.fromEntries(Object.entries(TABLES).map(([t, key]) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY ${key}`).all()]));
const objects = (db: DatabaseSync) => db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
const allRows = (db: DatabaseSync) => objects(db).filter(o => o.type === 'table').map(o => [o.name, db.prepare(`SELECT * FROM "${o.name}"`).all()]);
function migrate(db: DatabaseSync, sql: string) {
	db.exec('BEGIN');
	try { db.exec(sql); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
}

describe('0002_preview_render_case_limit on a populated applied chain', () => {
	it('keeps every reservation, counter and success receipt byte-for-byte and changes only the two case CHECKs', () => {
		const db = populated();
		const beforeFacts = facts(db), beforeObjects = objects(db), beforeRows = allRows(db);
		expect(beforeFacts.npr_reservations).toHaveLength(7);
		expect(beforeFacts.npr_success_receipts).toHaveLength(2);
		expect(beforeFacts.npr_case_days).toEqual([
			{ client_id: 'client-a', case_id: 'case-a1', day: D, runs: 2 }, { client_id: 'client-a', case_id: 'case-a2', day: D, runs: 2 },
			{ client_id: 'client-b', case_id: 'case-b1', day: D, runs: 2 }]);
		migrate(db, assemble(sources()).sql);
		expect(facts(db)).toEqual(beforeFacts);
		expect(allRows(db)).toEqual(beforeRows);
		const afterObjects = objects(db);
		expect(afterObjects.map(o => [o.type, o.name])).toEqual(beforeObjects.map(o => [o.type, o.name]));
		const changed = { npr_reservations: ['case_limit INTEGER NOT NULL CHECK (case_limit BETWEEN 1 AND 2)', 'case_limit INTEGER NOT NULL CHECK (case_limit BETWEEN 1 AND 3)'],
			npr_case_days: ['runs INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 2)', 'runs INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 3)'] } as Record<string, [string, string]>;
		for (const [i, after] of afterObjects.entries()) {
			const before = beforeObjects[i]!;
			const change = after.type === 'table' ? changed[after.name] : undefined;
			if (!change) { expect(after).toEqual(before); continue; }
			expect(before.sql).toContain(change[0]);
			expect(after.sql).toBe(before.sql!.replace(change[0], change[1]));
		}
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
		db.close();
	});

	it('retains every admission, append-only, counter and receipt guard, with the case boundary moved to 3', () => {
		const db = populated();
		migrate(db, assemble(sources()).sql);
		const b = HISTORY[6]!, a4 = HISTORY[4]!;
		const next = (over: Partial<Res>): Res => ({ token: 'syn-new', client: 'client-b', caseId: 'case-b1', at: b.at + b.lease, lease: 82_000, caseLimit: 3, clientLimit: 3, ...over });
		const snapshot = () => JSON.stringify(facts(db));
		const unchanged = (fn: () => void, pattern: RegExp) => { const s = snapshot(); expect(fn).toThrow(pattern); expect(snapshot()).toBe(s); };
		// Immutable reservations and receipts.
		unchanged(() => reserve(db, next({ token: 'syn-a-1' })), /reservation immutable/);
		unchanged(() => db.exec("UPDATE npr_reservations SET case_limit = 3 WHERE token = 'syn-b-1'"), /reservation immutable/);
		unchanged(() => db.exec("DELETE FROM npr_reservations WHERE token = 'syn-b-2'"), /reservation immutable/);
		unchanged(() => db.exec('UPDATE npr_success_receipts SET pages = 2'), /success immutable/);
		unchanged(() => db.exec('DELETE FROM npr_success_receipts'), /success immutable/);
		unchanged(() => succeed(db, HISTORY[3]!, 9_000), /success immutable/);
		unchanged(() => succeed(db, HISTORY[1]!, 90_000), /no exact reservation/);
		// Counters stay projections: no reset, refund, forgery or deletion.
		unchanged(() => db.exec("UPDATE npr_case_days SET runs = 1 WHERE case_id = 'case-b1'"), /monotonic/);
		unchanged(() => db.exec("UPDATE npr_case_days SET runs = 3 WHERE case_id = 'case-b1'"), /projection refused/);
		unchanged(() => db.exec("DELETE FROM npr_case_days WHERE case_id = 'case-b1'"), /immutable identity/);
		unchanged(() => db.exec(`INSERT INTO npr_case_days VALUES ('client-b','case-forged',${D},1)`), /projection refused/);
		unchanged(() => db.exec("INSERT OR REPLACE INTO npr_case_days VALUES ('client-b','case-b1',0,1)"), /immutable identity/);
		unchanged(() => db.exec("UPDATE npr_client_days SET runs = 1 WHERE client_id = 'client-b'"), /monotonic/);
		unchanged(() => db.exec("DELETE FROM npr_client_days WHERE client_id = 'client-a'"), /immutable identity/);
		// Client A is at its day ceiling of 4; a new case is refused on the client limit, not reopened by the case change.
		unchanged(() => reserve(db, next({ token: 'syn-a-5', client: 'client-a', caseId: 'case-a3', at: a4.at + a4.lease, clientLimit: 4 })), /client admission refused/);
		// Concurrency: B's next launch cannot start before its last lease ends; clock rollback cannot reopen a day.
		unchanged(() => reserve(db, next({ at: b.at + b.lease - 1 })), /client admission refused/);
		unchanged(() => reserve(db, next({ at: start - DAY_MS })), /client admission refused/);
		// The schema still caps limits: case 4, case above client, client 5.
		unchanged(() => reserve(db, next({ caseLimit: 4, clientLimit: 4 })), /CHECK constraint failed/);
		unchanged(() => reserve(db, next({ client: 'client-c', caseId: 'case-c1', caseLimit: 3, clientLimit: 2 })), /CHECK constraint failed/);
		unchanged(() => reserve(db, next({ clientLimit: 5 })), /CHECK constraint failed/);
		// The old case limit 2 still refuses B's third same-case run.
		unchanged(() => reserve(db, next({ caseLimit: 2 })), /case admission refused/);
		// The one new B run at case limit 3 is admitted; the counters advance from the preserved history.
		reserve(db, next({}));
		expect(db.prepare("SELECT day, runs FROM npr_case_days WHERE client_id = 'client-b'").get()).toEqual({ day: D, runs: 3 });
		expect(db.prepare("SELECT day, runs, next_launch_ms FROM npr_client_days WHERE client_id = 'client-b'").get()).toEqual({ day: D, runs: 3, next_launch_ms: b.at + b.lease + 82_000 });
		// A fourth same-case run is refused at case limit 3 even with client room left.
		unchanged(() => reserve(db, next({ token: 'syn-new-2', at: b.at + b.lease + 82_000, clientLimit: 4 })), /case admission refused/);
		// A receipt for the new reservation is accepted once, then immutable.
		succeed(db, next({}), 5_000);
		unchanged(() => succeed(db, next({}), 5_001), /success immutable/);
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		db.close();
	});

	it('is one atomic unit: a failure part-way, or a lost reservation at commit, leaves the old schema and every fact', () => {
		const sql = assemble(sources()).sql;
		const statements = sql.split('\n').filter(line => !line.startsWith('--') && !line.trimStart().startsWith('-- ')).join('\n');
		expect(statements.startsWith('PRAGMA defer_foreign_keys = on;\n')).toBe(true);
		expect(statements).not.toMatch(/defer_foreign_keys\s*=\s*(off|false|0)/i);
		expect(statements).not.toMatch(/writable_schema|foreign_keys\s*=\s*(off|false|0)|ignore_check_constraints|ALTER TABLE|RENAME/i);
		const lastTrigger = sql.lastIndexOf('CREATE TRIGGER');
		const lostRow = sql.replace(/(FROM npr_reservations_0002)(;)/, "$1 WHERE token <> 'syn-a-3'$2");
		expect(lostRow).not.toBe(sql);
		for (const [name, broken, pattern] of [
			['fails part-way', `${sql.slice(0, lastTrigger)}INSERT INTO synthetic_missing_table VALUES (1);\n${sql.slice(lastTrigger)}`, /no such table/],
			['loses the reservation a receipt names', lostRow, /FOREIGN KEY constraint failed/],
		] as const) {
			const db = populated();
			const objectsBefore = objects(db), rowsBefore = allRows(db);
			expect(() => migrate(db, broken), name).toThrow(pattern);
			expect(objects(db), name).toEqual(objectsBefore);
			expect(allRows(db), name).toEqual(rowsBefore);
			expect(() => reserve(db, { token: 'syn-x', client: 'client-b', caseId: 'case-b1', at: HISTORY[6]!.at + 72_000, lease: 82_000, caseLimit: 3, clientLimit: 3 }), name).toThrow(/CHECK constraint failed/);
			db.close();
		}
		// Why there is no closing `defer_foreign_keys = off`: it would let the same lost row commit as an orphan.
		const db = populated();
		migrate(db, `${lostRow}\nPRAGMA defer_foreign_keys = off;\n`);
		expect(db.prepare('PRAGMA foreign_key_check').all()).not.toEqual([]);
		db.close();
	});

	it('refuses to run on a database without the applied 0002 render tables', () => {
		const db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys=ON');
		db.exec(assembleNativeSchema(NATIVE_SCHEMA_INPUTS.map(pin => ({ path: pin.path, bytes: read0(pin.path) }))).sql);
		const before = objects(db);
		expect(() => migrate(db, assemble(sources()).sql)).toThrow(/no such table/);
		expect(objects(db)).toEqual(before);
		db.close();
	});
});

describe('the render case-limit 0004 packet', () => {
	it('pins the single viewer input and depends on the unchanged 0001 and applied 0002, which it never re-emits', () => {
		expect(MODE).toBe('render-case-limit-0004');
		expect(SOURCE).toMatch(/^[0-9a-f]{40}$/);
		expect(PINS).toEqual([{ path: INPUT, bytes: read0(INPUT).length, sha256: `sha256:${sha(read0(INPUT))}` }]);
		expect(APPLIED).toEqual({ path: 'migrations/0002_native_runtime.sql', bytes: 20618,
			sha256: 'sha256:e854e9d1c6bca7a439dd5903ace1a3e7d01382dae3a7e79e624146f870cda97f', source: NATIVE_RUNTIME_MIGRATION_SOURCE });
		const plan = assemble(sources());
		expect(assemble(sources())).toEqual(plan);
		expect(plan.manifest).toMatchObject({ schema: 'clearcase.native-render-case-limit-migration/1', mode: MODE, source: SOURCE,
			initialSchemaDependency: NATIVE_RUNTIME_INITIAL_SCHEMA, appliedRuntimeDependency: APPLIED, inputs: PINS, providerProof: false, provisioned: false });
		expect(plan.manifest.output).toEqual({ path: 'migrations/0004_native_render_case_limit.sql', bytes: Buffer.byteLength(plan.sql), sha256: `sha256:${sha(plan.sql)}` });
		expect(plan.sql).toBe(`-- ClearCase native render case-limit increment 0004; input source ${SOURCE}\n-- Requires unchanged 0001_native_alpha.sql and applied 0002_native_runtime.sql; never replaces either.\n-- ${INPUT}\n${read0(INPUT).toString()}\n`);
		// The applied 0002 output is byte-identical to its recorded application.
		const runtime = assembleNativeRuntimeMigration(NATIVE_RUNTIME_MIGRATION_INPUTS.map(pin => ({ path: pin.path, bytes: read0(pin.path) })));
		expect(runtime.manifest.output).toEqual({ path: APPLIED.path, bytes: APPLIED.bytes, sha256: APPLIED.sha256 });
		const changed = sources(); changed[0]!.bytes = Buffer.from(changed[0]!.bytes); changed[0]!.bytes[0] ^= 1;
		expect(() => assemble(changed)).toThrow(/differ/);
		expect(() => assemble([])).toThrow();
		expect(() => assemble([...sources(), ...sources()])).toThrow();
	});

	it('stages privately, checks only its own fixed invocation and never accepts a 0002 stage as itself', () => {
		const out = path.join(temp(), 'stage');
		const staged = prepare({ root, out });
		expect(staged.mode).toBe(MODE);
		expect(statSync(out).mode & 0o777).toBe(0o700);
		expect(statSync(path.join(out, 'migrations', '0004_native_render_case_limit.sql')).mode & 0o777).toBe(0o600);
		expect(read({ root, stage: out }).sql).toBe(staged.sql);
		for (const target of staged.manifest.targets) {
			expect(check({ root, stage: out, cwd: staged.stage, slot: target.slot, argv: target.argv }).target).toEqual(target);
			expect(() => check({ root, stage: out, cwd: staged.stage, slot: target.slot, argv: [...target.argv, '--local'] })).toThrow();
		}
		const runtimeStage = path.join(temp(), 'runtime');
		prepareNativeRuntimeMigration({ root, out: runtimeStage });
		expect(() => read({ root, stage: runtimeStage })).toThrow();
		expect(() => readNativeRuntimeMigration({ root, stage: out })).toThrow();
		writeFileSync(path.join(out, 'migrations', '0004_native_render_case_limit.sql'), `${staged.sql}-- tampered\n`);
		expect(() => read({ root, stage: out })).toThrow();
	});
});
