#!/usr/bin/env bun
// Child helper for durability.mjs USERWORK-TABLE: runs UserWork.defineTable/importAll (mode "define") or reads the
// table back (mode "read") on a stopped server's data directory through the app's own service, in a process of its
// own (the instance lock is released when the process exits). Prints one JSON line.
import { service } from '../../../../src/lib/local-case/test-support.ts';

const [dataDir, mode, rowsJson] = process.argv.slice(2);
const lc = service(dataDir!);
if (mode === 'define') {
	await lc.userWork.defineTable({ name: 'e2e_ledger', owner: 'GRS-12 e2e', description: 'synthetic table for the durability suite', columns: [{ name: 'id', type: 'TEXT' }, { name: 'label', type: 'TEXT' }, { name: 'amount', type: 'INTEGER' }], primaryKey: ['id'], scope: 'store' });
	const meta = lc.userWork.tables().find((t) => t.name === 'e2e_ledger')!;
	const r = await lc.userWork.importAll({ format: 'clearcase.user-work/1', exportedAt: new Date().toISOString(), tables: [{ ...meta, rows: JSON.parse(rowsJson!) }] });
	console.log(JSON.stringify({ defined: true, restored: r }));
} else {
	const table = lc.userWork.tables().find((x) => x.name === 'e2e_ledger') ?? null;
	const rows = lc.userWork.exportAll().tables.find((x) => x.name === 'e2e_ledger')?.rows ?? null;
	console.log(JSON.stringify({ table, rows }));
}
lc.storage.close();
process.exit(0);
