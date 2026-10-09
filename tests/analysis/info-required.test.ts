// Info Required done flags (GRS-15, S-index-keys / S-info_required_tab-1): keyed by a stable item identity, never by
// position, so a reordered results version keeps each flag on its item; imported rows are never written.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INFO_STORE, infoRows, itemKeys, saveDone } from '../../src/lib/analysis/info-required.server.ts';
import { cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';

const items = [
	{ item: 'Invented item A', owner: 'Ann', status: 'Outstanding' },
	{ item: 'Invented item B', owner: 'Ben', status: 'In progress' },
	{ item: 'Invented item C', owner: 'Cal', status: 'To verify' },
];

let dir: string;
let lc: LocalCase;
beforeEach(async () => { dir = await tempRoot('info'); lc = service(dir); });
afterEach(async () => { lc.shutdown(); await cleanup(dir); });

describe('info required flags', () => {
	it('keys items by their text, with an occurrence number for repeats', () => {
		const k = itemKeys([...items, items[0]!]);
		expect(new Set(k).size).toBe(4);
		expect(k[3]).toBe(`${k[0]}#2`);
		expect(itemKeys([items[1]!, items[0]!])).toEqual([k[1], k[0]]);
		expect(itemKeys([{ ...items[0]!, status: 'Done', owner: 'Zed' }])[0]).toBe(k[0]);
	});

	it('saves a flag on its item and keeps it there when a later version reorders the list', async () => {
		const key = itemKeys(items)[1]!;
		expect(await saveDone(lc.userWork, 'case-1', 'rv-1', items, key, true)).toBe(true);
		expect(infoRows(lc.userWork, 'case-1', items).rows.map((r) => r.done)).toEqual([false, true, false]);
		const reordered = [items[2]!, items[1]!, items[0]!];
		expect(infoRows(lc.userWork, 'case-1', reordered).rows.map((r) => [r.item, r.done])).toEqual([['Invented item C', false], ['Invented item B', true], ['Invented item A', false]]);
		// the stored row names the item and the version it was set against, not a position
		const [row] = lc.userWork.listRows('case-1', INFO_STORE);
		expect(row!.rowId).toBe(key);
		expect(row!.fields).toEqual({ item: 'Invented item B', done: true, resultsVersion: 'rv-1' });
	});

	it('stores false on uncheck, as v5 does, and edits the same row', async () => {
		const key = itemKeys(items)[0]!;
		await saveDone(lc.userWork, 'case-1', 'rv-1', items, key, true);
		await saveDone(lc.userWork, 'case-1', 'rv-1', items, key, false);
		const rows = lc.userWork.listRows('case-1', INFO_STORE);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.fields.done).toBe(false);
	});

	it('scopes flags to the case and reports flags whose item left the version', async () => {
		await saveDone(lc.userWork, 'case-1', 'rv-1', items, itemKeys(items)[2]!, true);
		expect(infoRows(lc.userWork, 'case-2', items).rows.every((r) => !r.done)).toBe(true);
		const next = infoRows(lc.userWork, 'case-1', [{ ...items[2]!, item: 'Invented item C, reworded' }]);
		expect(next.rows[0]!.done).toBe(false);
		expect(next.detached).toBe(1);
	});

	it('refuses a key that is not an item of this version and writes nothing', async () => {
		expect(await saveDone(lc.userWork, 'case-1', 'rv-1', items, 'info:not-a-key', true)).toBe(false);
		expect(lc.userWork.listRows('case-1', INFO_STORE)).toHaveLength(0);
	});

	it('renders an empty list without rows or errors', () => {
		expect(infoRows(lc.userWork, 'case-1', [])).toEqual({ rows: [], detached: 0 });
	});
});
