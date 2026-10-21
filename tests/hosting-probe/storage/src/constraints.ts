// What a uw_* table declares and whether a set of rows would break it, apart from the Worker so a test can run it on
// SQLite itself. The Worker turns a null from constraintsOf into 500 unchecked-constraint and a reason from
// userWorkProblem into 422.
type Row = Record<string, unknown>;
export interface Db {
	all<T = Row>(text: string, ...params: string[]): Promise<T[]>;
	first<T = Row>(text: string, ...params: string[]): Promise<T | null>;
}
export type Constraints = { keys: string[][]; required: string[] };

/**
 * What a uw_* table declares, read from the schema and never listed by hand: its PRIMARY KEY and UNIQUE column sets, and
 * its NOT NULL columns. A CHECK, a FOREIGN KEY, or an index on an expression or with a WHERE cannot be evaluated here,
 * and neither can a table whose comparisons are not SQLite's defaults, so null stops every restore (a fault of the
 * deployment, not of the backup) until this learns it.
 */
export async function constraintsOf(db: Db, table: string): Promise<Constraints | null> {
	const info = await db.all<{ name: string; notnull: number; pk: number }>('SELECT name, "notnull", pk FROM pragma_table_info(?) ORDER BY cid', table);
	const keys = new Map<string, string[]>();
	const pk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
	if (pk.length) keys.set(pk.join(','), pk);
	let unchecked = (await db.all('SELECT 1 FROM pragma_foreign_key_list(?)', table)).length > 0 || /\bCHECK\s*\(/i.test((await db.first<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", table))?.sql ?? '');
	for (const ix of await db.all<{ name: string; partial: number }>('SELECT name, partial FROM pragma_index_list(?) WHERE "unique" = 1', table)) {
		const columns = (await db.all<{ name: string | null }>('SELECT name FROM pragma_index_info(?) ORDER BY seqno', ix.name)).map((c) => c.name);
		if (ix.partial || columns.some((c) => c === null)) unchecked = true;
		else keys.set(columns.join(','), columns as string[]);
	}
	if (unchecked) return null;
	return { keys: [...keys.values()], required: info.filter((c) => c.notnull || c.pk > 0).map((c) => c.name) };
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
			const id = JSON.stringify(values.map(String)); // text and number columns coerce one into the other
			if (seen[i]!.has(id)) return `user-work.json ${table}: ${key.join(', ')} repeats`;
			seen[i]!.add(id);
		}
	}
	return null;
}
