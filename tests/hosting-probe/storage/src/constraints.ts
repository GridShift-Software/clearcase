// What a uw_* table declares and whether a set of rows would break it, apart from the Worker so a test can run it on
// SQLite itself. The Worker turns a null from constraintsOf into 500 unchecked-constraint and a reason from
// userWorkProblem into 422.
type Row = Record<string, unknown>;
export interface Db {
	all<T = Row>(text: string, ...params: string[]): Promise<T[]>;
	first<T = Row>(text: string, ...params: string[]): Promise<T | null>;
}
/** SQLite's column affinities (datatype3.html, 3.1): what a declared type makes of a value stored in the column. */
export type Affinity = 'integer' | 'text' | 'none' | 'real' | 'numeric';
export type Constraints = { keys: string[][]; required: string[]; affinity: Record<string, Affinity> };

/** The affinity SQLite gives a declared column type, by its five rules in order. */
export function affinityOf(declared: string): Affinity {
	const t = declared.toUpperCase();
	if (t.includes('INT')) return 'integer';
	if (/CHAR|CLOB|TEXT/.test(t)) return 'text';
	if (t.includes('BLOB') || t.trim() === '') return 'none';
	if (/REAL|FLOA|DOUB/.test(t)) return 'real';
	return 'numeric';
}

/**
 * What a uw_* table declares, read from the schema and never listed by hand: its PRIMARY KEY and UNIQUE column sets, and
 * its NOT NULL columns. A CHECK, a FOREIGN KEY, or an index on an expression or with a WHERE cannot be evaluated here,
 * and neither can a table that compares by another rule than the one here: a COLLATE other than BINARY (on a column or
 * in an index) or a STRICT table (which refuses a value rather than converting it). Null stops every restore (a fault of
 * the deployment, not of the backup) until this learns it.
 */
export async function constraintsOf(db: Db, table: string): Promise<Constraints | null> {
	const info = await db.all<{ name: string; type: string; notnull: number; pk: number }>('SELECT name, type, "notnull", pk FROM pragma_table_info(?) ORDER BY cid', table);
	const keys = new Map<string, string[]>();
	const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
	if (pk.length) keys.set(pk.join(','), pk);
	const ddl = (await db.first<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table))?.sql ?? '';
	// STRICT and WITHOUT ROWID follow the closing parenthesis of the column list; a COLLATE may sit in a column or a key
	let unchecked = (await db.all('SELECT 1 FROM pragma_foreign_key_list(?)', table)).length > 0 || /\bCHECK\s*\(/i.test(ddl) || /\bSTRICT\b/i.test(ddl.slice(ddl.lastIndexOf(')'))) || /\bCOLLATE\s+(?!BINARY\b)/i.test(ddl);
	for (const ix of await db.all<{ name: string; partial: number }>('SELECT name, partial FROM pragma_index_list(?) WHERE "unique" = 1', table)) {
		const columns = (await db.all<{ name: string | null }>('SELECT name FROM pragma_index_info(?) ORDER BY seqno', ix.name)).map((c) => c.name);
		const collated = (await db.all<{ coll: string | null }>('SELECT coll FROM pragma_index_xinfo(?) WHERE key = 1', ix.name)).some((c) => c.coll !== 'BINARY');
		if (ix.partial || collated || columns.some((c) => c === null)) unchecked = true;
		else keys.set(columns.join(','), columns as string[]);
	}
	if (unchecked) return null;
	return { keys: [...keys.values()], required: info.filter((c) => c.notnull || c.pk > 0).map((c) => c.name), affinity: Object.fromEntries(info.map((c) => [c.name, affinityOf(c.type)])) };
}

const NUMERIC_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * `value` as the column stores it, as a string that is equal exactly when SQLite's comparison is: a column of numeric
 * affinity turns text that reads as a number (leading and trailing white space allowed) into that number, and a column of
 * text affinity turns a number into text; a column with no affinity keeps both as they are.
 */
function stored(value: string | number, affinity: Affinity): string {
	if (affinity === 'none') return JSON.stringify([typeof value, value]);
	if (affinity === 'text') return JSON.stringify(['string', String(value)]);
	const n = typeof value === 'number' ? value : NUMERIC_TEXT.test(value.trim()) ? Number(value.trim()) : Number.NaN;
	return Number.isFinite(n) ? JSON.stringify(['number', n === 0 ? 0 : n]) : JSON.stringify(['string', value]);
}

/** The reason `rows` of `table` break one of its constraints, or null. The database would refuse them too, but only after the staging rows were written. */
export function userWorkProblem(table: string, rows: Row[], constraints: Constraints): string | null {
	const seen = constraints.keys.map(() => new Set<string>());
	for (const r of rows) {
		for (const [c, v] of Object.entries(r)) if (v !== null && typeof v !== 'string' && typeof v !== 'number') return `user-work.json ${table}: ${c} is not text, a number or null`;
		for (const c of constraints.required) if (r[c] === null) return `user-work.json ${table}: ${c} is null`;
		for (const [i, key] of constraints.keys.entries()) {
			const values = key.map((c) => r[c]);
			if (values.includes(null)) continue; // NULLs never collide in a UNIQUE constraint
			const id = JSON.stringify(values.map((v, k) => stored(v as string | number, constraints.affinity[key[k]!] ?? 'none')));
			if (seen[i]!.has(id)) return `user-work.json ${table}: ${key.join(', ')} repeats`;
			seen[i]!.add(id);
		}
	}
	return null;
}
