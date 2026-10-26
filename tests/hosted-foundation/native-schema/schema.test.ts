import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
	assembleNativeSchema, checkNativeSchemaInvocation, NATIVE_RUNTIME_DDL, NATIVE_SCHEMA_INPUTS,
	NATIVE_SCHEMA_SOURCE, prepareNativeSchema, readNativeSchema,
} from '../../../deploy/native-alpha/schema.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const scratch: string[] = [];
function temp() { const dir = mkdtempSync(path.join(tmpdir(), 'cc-native-schema-')); scratch.push(dir); return dir; }
function sources() { return NATIVE_SCHEMA_INPUTS.map(pin => ({ path: pin.path, bytes: readFileSync(path.join(root, pin.path)) })); }
function copySources() {
	const dest = temp();
	for (const input of sources()) { const file = path.join(dest, input.path); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, input.bytes); }
	return dest;
}
function stage() { const out = path.join(temp(), 'stage'); return prepareNativeSchema({ root, out }); }
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('pinned native schema', () => {
	it('assembles deterministic actual combined DDL and all tables, without provisioning any identities or grants', () => {
		const inputs = sources();
		const plan = assembleNativeSchema(inputs);
		expect(assembleNativeSchema(sources())).toEqual(plan);
		expect(plan.manifest.source).toBe(NATIVE_SCHEMA_SOURCE);
		expect(plan.manifest.inputs.slice(1)).toEqual(NATIVE_SCHEMA_INPUTS);
		expect(plan.manifest.providerProof).toBe(false);
		// Prevent drift from the real runtime sentinel DDL without importing the gate fixture.
		expect(readFileSync(path.join(root, 'tests/hosted-foundation/runtime/gate-fixture.ts'), 'utf8')).toContain(NATIVE_RUNTIME_DDL.trim());
		const db = new DatabaseSync(':memory:');
		try {
			db.exec('PRAGMA foreign_keys = ON;');
			db.exec(plan.sql);
			// Compare ALL actual input table definitions, not a subset that could miss an owner.
			const expectedTables = ['runtime_sentinel', ...inputs.flatMap(input =>
				[...input.bytes.toString().matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/g)].map(match => match[1]!))].sort();
			const actual = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
			expect(actual).toEqual(expectedTables);
			expect(actual).toEqual(expect.arrayContaining(['native_audit_events', 'rs_verification_work', 'tenant_upload_grants', 'uw_note', 'native_candidate_audit_settlement', 'pub_apply_receipt']));
			expect(db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='pub_durable_intent'").get()).toBeTruthy();
			expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
			expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
			for (const name of expectedTables) expect(db.prepare(`SELECT count(*) AS n FROM ${name}`).get()).toEqual({ n: 0 });
			// Source binding/immutability triggers remain present and active in the real assembled DDL.
			expect(() => db.exec("INSERT INTO rs_storage_identity VALUES(2, 'synthetic', 'clearcase.rs/1')")).toThrow();
			expect(() => db.exec("INSERT INTO runtime_sentinel(name, value) VALUES('synthetic', NULL)")).toThrow();
		} finally { db.close(); }
	});

	it('refuses missing, extra, reordered, replaced or changed inputs, including same-size corruption', () => {
		expect(() => assembleNativeSchema(sources().slice(1))).toThrow(/missing/);
		expect(() => assembleNativeSchema([...sources(), sources()[0]!])).toThrow(/extra/);
		const reordered = sources(); [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
		expect(() => assembleNativeSchema(reordered)).toThrow(/order/);
		const replaced = sources(); replaced[0]!.path = '../outside.sql';
		expect(() => assembleNativeSchema(replaced)).toThrow(/path/);
		const changed = sources(); changed[0]!.bytes[0] = changed[0]!.bytes[0]! ^ 1;
		expect(() => assembleNativeSchema(changed)).toThrow(/bytes differ/);
	});

	it('actual atomic DDL rejects installation before candidate audit settlement or publication ledger', () => {
		for (const missing of ['native_candidate_audit_settlement', 'pub_operation']) {
			const db = new DatabaseSync(':memory:');
			try {
				const inputs = sources();
				const last = inputs.pop()!;
				for (const input of inputs) db.exec(input.bytes.toString());
				db.exec(`DROP TABLE ${missing}`);
				expect(() => db.exec(last.bytes.toString())).toThrow();
			} finally { db.close(); }
		}
	});

	it('emits a bounded stage, checks exact invocation and never targets staff', () => {
		const result = stage();
		expect(readNativeSchema({ root, stage: result.stage })).toEqual(result);
		expect(result.manifest.targets.map(t => t.databaseName)).toEqual(['cc-sbx-a-20261023-db', 'cc-sbx-b-20261025-r1-db']);
		for (const target of result.manifest.targets) {
			const invocation = { root, stage: result.stage, cwd: result.stage, slot: target.slot, argv: target.argv };
			expect(checkNativeSchemaInvocation(invocation).target).toEqual(target);
			for (const argv of [[...target.argv, '--local'], [...target.argv, '--command', 'DROP TABLE rs_case'], target.argv.map(a => a === '--remote' ? '--local' : a)]) {
				expect(() => checkNativeSchemaInvocation({ ...invocation, argv })).toThrow(/invocation/);
			}
			expect(() => checkNativeSchemaInvocation({ ...invocation, cwd: root })).toThrow(/invocation/);
			expect(() => checkNativeSchemaInvocation({ ...invocation, ...JSON.parse('{"slot":"staff"}') })).toThrow(/target/);
			expect(() => checkNativeSchemaInvocation({ ...invocation, ...JSON.parse('{"databaseId":"other"}') })).toThrow(/keys/);
		}
		expect(() => prepareNativeSchema({ root, out: result.stage })).toThrow(/must not exist/);
	});

	it.each(['migrations/0001_native_alpha.sql', 'schema.json', 'client-a.wrangler.json', 'client-b.wrangler.json'])('refuses changed staged %s', file => {
		const result = stage();
		writeFileSync(path.join(result.stage, file), 'changed');
		expect(() => readNativeSchema({ root, stage: result.stage })).toThrow(/bytes differ/);
	});

	it('refuses added dotenv, missing migrations and symlink substitutions', () => {
		const result = stage();
		writeFileSync(path.join(result.stage, '.env'), 'SYNTHETIC=1');
		expect(() => readNativeSchema({ root, stage: result.stage })).toThrow(/entries/);
		unlinkSync(path.join(result.stage, '.env'));
		unlinkSync(path.join(result.stage, 'migrations/0001_native_alpha.sql'));
		expect(() => readNativeSchema({ root, stage: result.stage })).toThrow(/entries/);
		const other = stage();
		const file = path.join(other.stage, 'schema.json');
		unlinkSync(file);
		symlinkSync(path.join(result.stage, 'schema.json'), file);
		expect(() => readNativeSchema({ root, stage: other.stage })).toThrow(/real file/);
		const link = path.join(temp(), 'linked');
		symlinkSync(other.stage, link);
		expect(() => readNativeSchema({ root, stage: link })).toThrow(/real directory/);
	});

	it('rechecks pinned source bytes after preparation, even when stage remains unchanged', () => {
		const copied = copySources();
		const out = path.join(temp(), 'stage');
		prepareNativeSchema({ root: copied, out });
		const first = NATIVE_SCHEMA_INPUTS[0]!;
		writeFileSync(path.join(copied, first.path), 'changed source');
		expect(() => readNativeSchema({ root: copied, stage: out })).toThrow(/source pin/);
		expect(() => prepareNativeSchema({ root: copied, out: path.join(temp(), 'other') })).toThrow(/source pin/);
		unlinkSync(path.join(copied, first.path));
		expect(() => readNativeSchema({ root: copied, stage: out })).toThrow();
	});

	it('CLI prepares/verifies offline and refuses arbitrary SQL, ID and argument overrides', () => {
		const out = path.join(temp(), 'stage');
		const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/hosted-native-schema.ts', ...args], { cwd: root, encoding: 'utf8' });
		expect(run('prepare', out).status).toBe(0);
		expect(run('verify', out).status).toBe(0);
		for (const args of [['execute', out], ['prepare', out, '--database-id', 'other'], ['verify', out, '--command', 'DROP TABLE rs_case'], ['verify']]) {
			expect(run(...args).status).toBe(2);
		}
	});
});
