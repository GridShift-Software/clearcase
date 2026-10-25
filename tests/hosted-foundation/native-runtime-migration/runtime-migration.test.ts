import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assembleNativeSchema, NATIVE_SCHEMA_INPUTS } from '../../../deploy/native-alpha/schema.ts';
import { assembleNativeRuntimeMigration as assemble, prepareNativeRuntimeMigration as prepare, readNativeRuntimeMigration as read, checkNativeRuntimeMigrationInvocation as check, NATIVE_RUNTIME_MIGRATION_INPUTS as PINS, NATIVE_RUNTIME_INITIAL_SCHEMA as INITIAL } from '../../../deploy/native-alpha/runtime-migration.ts';

const failure = vi.hoisted(() => ({ write: false }));
vi.mock('node:fs', async importOriginal => {
	const fs = await importOriginal<typeof import('node:fs')>();
	return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
		if (failure.write) throw new Error('synthetic disk failure');
		return fs.writeFileSync(...args);
	} };
});
const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch: string[] = [];
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), 'cc-runtime-migration-')); scratch.push(dir); return dir; };
const sources = () => PINS.map(pin => ({ path: pin.path, bytes: readFileSync(path.join(root, pin.path)) }));
const stage = () => prepare({ root, out: path.join(temp(), 'stage') });
const hash = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
afterEach(() => { failure.write = false; for (const p of scratch.splice(0)) rmSync(p, { recursive: true, force: true }); });

it('applies unchanged initial schema then exact increment in synthetic SQLite with all objects and invariants intact', () => {
	const base = assembleNativeSchema(NATIVE_SCHEMA_INPUTS.map(pin => ({ path: pin.path, bytes: readFileSync(path.join(root, pin.path)) })));
	expect(INITIAL).toEqual({ path: 'migrations/0001_native_alpha.sql', bytes: 85251, sha256: 'sha256:42c5047823256b5bfbc25ba7f8d04b6a05decb2ad19683599d89801011040d89', source: 'c6f0d9536e381dc8eebbf2035f49834409434761' });
	expect(Buffer.byteLength(base.sql)).toBe(INITIAL.bytes);
	expect(hash(base.sql)).toBe(INITIAL.sha256);
	const plan = assemble(sources());
	expect(assemble(sources())).toEqual(plan);
	expect(plan.manifest.initialSchemaDependency).toEqual(INITIAL);
	expect(plan.manifest.source).toBe('79c0ee92a858e55a12c727760e258ce8e293a86b');
	expect(plan.manifest.providerProof).toBe(false);
	expect(plan.manifest.provisioned).toBe(false);
	const db = new DatabaseSync(':memory:');
	try {
		db.exec('PRAGMA foreign_keys=ON'); db.exec(base.sql);
		const objects = () => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
		const before = objects();
		db.exec(plan.sql);
		const after = objects();
		for (const obj of before) expect(after).toContainEqual(obj);
		const delta = after.filter(obj => !before.some(old => old.name === obj.name));
		const expected = sources().flatMap(s => [...s.bytes.toString().matchAll(/CREATE (TABLE|INDEX|TRIGGER) (?:IF NOT EXISTS )?(\w+)/g)].map(m => ({ type: m[1]!.toLowerCase(), name: m[2]! }))).sort((a, b) => a.name.localeCompare(b.name));
		expect(delta.map(o => ({ type: o.type, name: o.name })).sort((a, b) => String(a.name).localeCompare(String(b.name)))).toEqual(expected);
		expect(delta.filter(o => o.type === 'table')).toHaveLength(5);
		expect(delta.filter(o => o.type === 'trigger')).toHaveLength(39);
		expect(delta.filter(o => o.type === 'index')).toHaveLength(2);
		for (const table of after.filter(o => o.type === 'table')) expect(db.prepare(`SELECT count(*) AS n FROM ${table.name}`).get()).toEqual({ n: 0 });
		expect(() => db.exec("INSERT INTO rs_storage_identity VALUES(2,'synthetic','clearcase.rs/1')")).toThrow();
		expect(() => db.exec("INSERT INTO native_audit_recovery_cursor VALUES('a','','candidate','','id',0)")).toThrow();
		expect(() => db.exec("INSERT INTO native_audit_recovery_cursor VALUES('a','','cases','nonempty',NULL,0)")).toThrow();
		db.exec("INSERT INTO native_audit_recovery_cursor VALUES('a','','cases','',NULL,0)");
		const h = 'a'.repeat(64);
		const insert = db.prepare('INSERT INTO npr_reservations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
		insert.run('token','a','case','candidate','v','asset',h,10,'renderer',h,0,1000,62001,2,4);
		expect(db.prepare('SELECT runs,next_launch_ms FROM npr_client_days').get()).toEqual({ runs: 1, next_launch_ms: 63001 });
		expect(() => db.exec('UPDATE npr_client_days SET runs=0')).toThrow();
		expect(() => db.exec('DELETE FROM npr_reservations')).toThrow();
		expect(() => insert.run('token2','a','case','candidate','v','asset',h,10,'renderer',h,0,2000,62001,2,4)).toThrow(/admission/);
		db.prepare('INSERT INTO npr_success_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(h,'token','a','case','candidate','v','asset',h,10,'renderer',2000,1,100,'{}',h);
		expect(() => db.exec('DELETE FROM npr_success_receipts')).toThrow();
		// Compile every provenance trigger against the combined real table graph without seeding identities/cases/grants.
		for (const s of sources()[2]!.bytes.toString().matchAll(/(?:BEFORE|AFTER) (INSERT|DELETE|UPDATE)(?: OF [\s\S]*?)? ON (\w+)\s/g)) {
			const op = s[1], table = s[2];
			const sql = op === 'INSERT' ? `INSERT INTO ${table} DEFAULT VALUES` : op === 'DELETE' ? `DELETE FROM ${table}` : `UPDATE ${table} SET ${db.prepare(`PRAGMA table_info(${table})`).all()[0]!.name} = ${db.prepare(`PRAGMA table_info(${table})`).all()[0]!.name}`;
			expect(() => db.prepare(`EXPLAIN ${sql}`)).not.toThrow();
		}
		expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
		expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
	} finally { db.close(); }
	expect(hash(base.sql)).toBe(INITIAL.sha256);
});

it('rejects missing/extra/reordered/replaced and same-size changed input bytes', () => {
	for (const bad of [sources().slice(1), [...sources(), sources()[0]!], sources().reverse()]) expect(() => assemble(bad)).toThrow();
	const bad = sources(); bad[0]!.bytes[0] ^= 1; expect(() => assemble(bad)).toThrow(/bytes differ/);
	const replaced = sources(); replaced[0]!.path = '../sql'; expect(() => assemble(replaced)).toThrow(/path/);
});

it('rejects holes, inherited indices, accessor records/indices/bytes, symbols and overridden array or byte methods without callbacks', () => {
	const badArrays = [sources(), sources(), sources(), sources(), sources(), sources()];
	delete badArrays[0]![0];
	Object.setPrototypeOf(badArrays[1], { 0: sources()[0], length: 3 });
	const callback = vi.fn(() => sources()[0]);
	Object.defineProperty(badArrays[2], '0', { get: callback });
	Object.defineProperty(badArrays[3], 'map', { value: callback });
	Object.defineProperty(badArrays[4], 'every', { value: callback });
	Object.defineProperty(badArrays[5], Symbol.iterator, { value: callback });
	for (const bad of badArrays) expect(() => assemble(bad)).toThrow();
	for (const key of ['path', 'bytes']) { const bad = sources(); Object.defineProperty(bad[0], key, { get: callback }); expect(() => assemble(bad)).toThrow(); }
	const inherited = sources(); Object.setPrototypeOf(inherited[0], sources()[0]!); expect(() => assemble(inherited)).toThrow();
	const bytes = sources(); Object.defineProperty(bytes[0]!.bytes, 'slice', { value: callback }); expect(() => assemble(bytes)).toThrow();
	const symbol = sources(); Object.defineProperty(symbol[0], Symbol('extra'), { value: 1 }); expect(() => assemble(symbol)).toThrow();
	expect(callback).not.toHaveBeenCalled();
});

it.each([0, 1, 2])('rejects missing/null/inherited/accessor input at every pinned index %i', index => {
	for (const value of [undefined, null]) {
		const bad = sources(); Object.defineProperty(bad, index, { value }); expect(() => assemble(bad)).toThrow();
	}
	const hole = sources(); delete hole[index]; expect(() => assemble(hole)).toThrow();
	const inherited = sources(), prototype = Object.create(Array.prototype); prototype[index] = inherited[index]; delete inherited[index]; Object.setPrototypeOf(inherited, prototype); expect(() => assemble(inherited)).toThrow();
	const getter = vi.fn(() => sources()[index]); const accessor = sources(); Object.defineProperty(accessor, index, { get: getter }); expect(() => assemble(accessor)).toThrow(); expect(getter).not.toHaveBeenCalled();
});

it('rejects shared memory, byte accessors and own source/SQL overrides without executing them', () => {
	const bad = sources();
	Object.defineProperty(bad[0]!.bytes, 'byteLength', { get() { throw new Error('getter invoked'); } });
	expect(() => assemble(bad)).toThrow(/overridden/);
	const shared: { path: string; bytes: Uint8Array }[] = sources().map(s => ({ path: s.path, bytes: new Uint8Array(s.bytes) }));
	shared[0]!.bytes = new Uint8Array(new SharedArrayBuffer(PINS[0]!.bytes)); expect(() => assemble(shared)).toThrow();
	for (const key of ['sql','source','target','accountId']) {
		const inputs = sources(); Object.defineProperty(inputs[0], key, { value: 'override' }); expect(() => assemble(inputs)).toThrow();
		expect(() => prepare({ root, out: path.join(temp(), 'stage'), ...{ [key]: 'override' } })).toThrow();
	}
});

it('copies plain bytes without invoking caller methods or retaining mutable input', () => {
	const inputs = sources().map(s => ({ path: s.path, bytes: new Uint8Array(s.bytes) }));
	const result = assemble(inputs); inputs[0]!.bytes.fill(0);
	expect(assemble(sources())).toEqual(result);
	expect(Object.isFrozen(result.manifest.targets[0]!.argv)).toBe(true);
});

it('exclusive stage and exact fixed account/targets match the pinned initial plan', () => {
	const result = stage();
	expect(read({ root, stage: result.stage })).toEqual(result);
	const base = assembleNativeSchema(NATIVE_SCHEMA_INPUTS.map(p => ({ path: p.path, bytes: readFileSync(path.join(root, p.path)) })));
	expect(result.manifest.targets).toEqual(base.manifest.targets);
	for (const target of result.manifest.targets) {
		const v = { root, stage: result.stage, cwd: result.stage, slot: target.slot, argv: target.argv };
		expect(check(v).target).toEqual(target);
		for (const argv of [[...target.argv, '--local'], target.argv.map(a => a === '--remote' ? '--local' : a), [], new Array(target.argv.length)]) expect(() => check({ ...v, argv })).toThrow();
		const inherited = new Array(target.argv.length); Object.setPrototypeOf(inherited, target.argv); expect(() => check({ ...v, argv: inherited })).toThrow();
		for (const method of ['every','map','toJSON',Symbol.iterator]) { const argv = [...target.argv]; Object.defineProperty(argv, method, { value: () => target.argv }); expect(() => check({ ...v, argv })).toThrow(); }
		expect(() => check({ ...v, cwd: root })).toThrow();
		expect(() => check({ ...v, ...JSON.parse('{"slot":"staff"}') })).toThrow();
		for (const override of ['databaseId','accountId','sql','source','target']) expect(() => check({ ...v, [override]: 'other' })).toThrow();
	}
	expect(() => prepare({ root, out: result.stage })).toThrow();
	expect(read({ root, stage: result.stage })).toEqual(result);
});

it.each(['migrations/0002_native_runtime.sql','runtime-migration.json','client-a.wrangler.json','client-b.wrangler.json'])('refuses tampering, missing and linked %s', file => {
	const s = stage(); const full = path.join(s.stage, file); const original = readFileSync(full);
	writeFileSync(full, 'changed'); expect(() => read({ root, stage: s.stage })).toThrow();
	unlinkSync(full); expect(() => read({ root, stage: s.stage })).toThrow();
	const external = path.join(temp(), 'external'); writeFileSync(external, original); symlinkSync(external, full); expect(() => read({ root, stage: s.stage })).toThrow();
	unlinkSync(full); linkSync(external, full); expect(() => read({ root, stage: s.stage })).toThrow();
});

it.each(['.env','migrations/0001_native_alpha.sql','migrations/extra.sql','unknown'])('rejects unknown stage entries %s', file => {
	const s = stage(); writeFileSync(path.join(s.stage, file), 'extra'); expect(() => read({ root, stage: s.stage })).toThrow(/entries/);
});

it('refuses linked roots, output parents, stages and migrations directories, without changing existing paths', () => {
	const s = stage(), linked = path.join(temp(), 'link'); symlinkSync(s.stage, linked);
	expect(() => read({ root, stage: linked })).toThrow();
	expect(() => prepare({ root, out: path.join(linked, 'new') })).toThrow();
	expect(() => prepare({ root, out: linked })).toThrow();
	const fakeRoot = path.join(temp(), 'root'); symlinkSync(root, fakeRoot); expect(() => prepare({ root: fakeRoot, out: path.join(temp(), 'new') })).toThrow();
	rmSync(path.join(s.stage, 'migrations'), { recursive: true }); symlinkSync(temp(), path.join(s.stage, 'migrations')); expect(() => read({ root, stage: s.stage })).toThrow();
	const dangling = path.join(temp(), 'dangling'); symlinkSync('/nonexistent-cc-runtime-migration', dangling); expect(() => prepare({ root, out: dangling })).toThrow();
});

it('rechecks changed/missing/linked sources and rejects inherited/accessor API arguments', () => {
	const copied = temp();
	for (const s of sources()) { const file = path.join(copied, s.path); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, s.bytes); }
	const out = path.join(temp(), 'stage'); prepare({ root: copied, out });
	const file = path.join(copied, PINS[0]!.path); writeFileSync(file, 'changed'); expect(() => read({ root: copied, stage: out })).toThrow();
	unlinkSync(file); expect(() => read({ root: copied, stage: out })).toThrow(); symlinkSync(path.join(root, PINS[0]!.path), file); expect(() => read({ root: copied, stage: out })).toThrow();
	const getter = vi.fn(() => root); const v = { root, stage: out }; Object.defineProperty(v, 'root', { get: getter }); expect(() => read(v)).toThrow(); expect(getter).not.toHaveBeenCalled();
	expect(() => read(Object.create({ root, stage: out }))).toThrow();
});

it('deletes only its freshly created incomplete stage after a write failure', () => {
	const parent = temp(), out = path.join(parent, 'stage'); writeFileSync(path.join(parent, 'keep'), 'unchanged');
	failure.write = true; expect(() => prepare({ root, out })).toThrow(/disk failure/); failure.write = false;
	expect(existsSync(out)).toBe(false); expect(readFileSync(path.join(parent, 'keep'), 'utf8')).toBe('unchanged');
	mkdirSync(out); writeFileSync(path.join(out, 'keep'), 'existing');
	failure.write = true; expect(() => prepare({ root, out })).toThrow(); failure.write = false;
	expect(readFileSync(path.join(out, 'keep'), 'utf8')).toBe('existing');
});

it('bounded CLI only prepares/verifies, rejecting execution and overrides', () => {
	const out = path.join(temp(), 'stage');
	const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/hosted-native-runtime-migration.ts', ...args], { cwd: root, encoding: 'utf8' });
	expect(run('prepare', out).status).toBe(0); expect(run('verify', out).status).toBe(0);
	for (const args of [['execute',out],['verify'],['verify',out,'--source','other'],['prepare',out,'--sql','other'],['verify',out,'--database-id','other']]) expect(run(...args).status).toBe(2);
	writeFileSync(path.join(out, '.env'), 'SYNTHETIC=1'); expect(run('verify', out).status).toBe(1);
});
