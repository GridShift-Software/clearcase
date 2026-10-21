// The user-work constraint check on SQLite itself (bun:sqlite), with the Worker's own schema.sql for the real tables:
//
//   bun test            (from this directory)
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type Db, constraintsOf, userWorkProblem } from './constraints.ts';

const schema = readFileSync(path.join(import.meta.dirname, '../schema.sql'), 'utf8');

function database(extra: string[] = []) {
	const sqlite = new Database(':memory:');
	sqlite.exec(schema);
	for (const statement of extra) sqlite.exec(statement);
	const db: Db = {
		all: async <T>(text: string, ...params: string[]) => sqlite.query(text).all(...params) as T[],
		first: async <T>(text: string, ...params: string[]) => (sqlite.query(text).get(...params) ?? null) as T | null,
	};
	return { sqlite, db };
}

async function problem(extra: string[], table: string, rows: Record<string, unknown>[]): Promise<string | null | 'unchecked'> {
	const { db } = database(extra);
	const constraints = await constraintsOf(db, table);
	return constraints === null ? 'unchecked' : userWorkProblem(table, rows, constraints);
}

const reg = (seq: unknown, n: number) => ({ case_id: 'c', store: 's', row_id: `r-${n}`, seq, version: 'v', fields: '{}', operation_id: `op-${n}` });

describe('key values are compared the way the column stores them', () => {
	test('INTEGER: 1 and "01" are one key, because the column stores both as 1', async () => {
		expect(await problem([], 'uw_register_row', [reg(1, 1), reg('01', 2)])).toContain('case_id, store, seq repeats');
	});
	test('INTEGER: " 1", "+1", "1.0" and "1e0" are also 1; "1.5" and "0x1" are not', async () => {
		for (const same of [' 1 ', '+1', '1.0', '1e0']) expect(await problem([], 'uw_register_row', [reg(1, 1), reg(same, 2)])).toContain('repeats');
		for (const other of ['1.5', '0x1', 'a']) expect(await problem([], 'uw_register_row', [reg(1, 1), reg(other, 2)])).toBeNull();
	});
	test('INTEGER: the SQLite database agrees about each of those', () => {
		const collides = (value: string) => {
			const { sqlite } = database();
			sqlite.exec(`INSERT INTO uw_register_row VALUES ('c','s','r-1',1,'v','{}','op-1')`);
			try {
				sqlite.query(`INSERT INTO uw_register_row VALUES ('c','s','r-2',?,'v','{}','op-2')`).run(value);
				return false;
			} catch (e) {
				return /UNIQUE/.test(String(e));
			}
		};
		for (const same of ['01', ' 1 ', '+1', '1.0', '1e0']) expect(collides(same)).toBe(true);
		for (const other of ['1.5', '0x1', 'a']) expect(collides(other)).toBe(false);
	});
	test('TEXT: 1 and "1" are one key; "01" and "1" are two', async () => {
		const note = (id: unknown) => ({ case_id: 'c', note_id: id, anchor: null, body: 'b', version: 'v' });
		expect(await problem([], 'uw_note', [note(1), note('1')])).toContain('repeats');
		expect(await problem([], 'uw_note', [note('01'), note('1')])).toBeNull();
	});
	test('a column with no declared type keeps 1 and "1" apart', async () => {
		const table = 'CREATE TABLE uw_loose (case_id TEXT NOT NULL, k, PRIMARY KEY (case_id, k))';
		expect(await problem([table], 'uw_loose', [{ case_id: 'c', k: 1 }, { case_id: 'c', k: '1' }])).toBeNull();
		expect(await problem([table], 'uw_loose', [{ case_id: 'c', k: 1 }, { case_id: 'c', k: 1 }])).toContain('repeats');
	});
	test('REAL and NUMERIC: 1 and "1.0" are one key', async () => {
		for (const type of ['REAL', 'NUMERIC', 'DOUBLE']) {
			const table = `CREATE TABLE uw_num (case_id TEXT NOT NULL, k ${type}, PRIMARY KEY (case_id, k))`;
			expect(await problem([table], 'uw_num', [{ case_id: 'c', k: 1 }, { case_id: 'c', k: '1.0' }])).toContain('repeats');
		}
	});
});

describe('a table whose comparisons are not the defaults is not checked', () => {
	test('COLLATE NOCASE on a key column', async () => {
		expect(await problem(['CREATE TABLE uw_nocase (case_id TEXT NOT NULL, k TEXT COLLATE NOCASE, PRIMARY KEY (case_id, k))'], 'uw_nocase', [])).toBe('unchecked');
	});
	test('a unique index with COLLATE NOCASE', async () => {
		expect(await problem(['CREATE TABLE uw_ix (case_id TEXT NOT NULL, k TEXT)', 'CREATE UNIQUE INDEX uw_ix_k ON uw_ix (case_id, k COLLATE NOCASE)'], 'uw_ix', [])).toBe('unchecked');
	});
	test('a STRICT table', async () => {
		expect(await problem(['CREATE TABLE uw_strict (case_id TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (case_id, k)) STRICT'], 'uw_strict', [])).toBe('unchecked');
		expect(await problem(['CREATE TABLE uw_strict2 (case_id TEXT NOT NULL, k TEXT NOT NULL, PRIMARY KEY (case_id, k)) WITHOUT ROWID, STRICT'], 'uw_strict2', [])).toBe('unchecked');
	});
	test('the schema’s own tables and a plain binary-collated one are checked', async () => {
		expect(await problem([], 'uw_note', [])).toBeNull();
		expect(await problem(['CREATE TABLE uw_plain (case_id TEXT NOT NULL, k TEXT COLLATE BINARY, PRIMARY KEY (case_id, k))'], 'uw_plain', [])).toBeNull();
	});
});
