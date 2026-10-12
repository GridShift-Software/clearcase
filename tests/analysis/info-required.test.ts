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
	it('keys items by their text; repeats of a text are told apart by owner and status, identical ones numbered', () => {
		const k = itemKeys(items);
		expect(k.every((x) => /^info:[0-9a-f]{32}$/.test(x))).toBe(true);
		expect(itemKeys([items[1]!, items[0]!])).toEqual([k[1], k[0]]);
		expect(itemKeys([{ ...items[0]!, status: 'Done', owner: 'Zed' }])[0]).toBe(k[0]);
		const rep = itemKeys([...items, items[0]!]);
		expect(new Set(rep).size).toBe(4);
		expect(rep[0]).not.toBe(k[0]);
		expect(rep[0]!.startsWith(`${k[0]}@`) && rep[3]!.startsWith(`${k[0]}@`)).toBe(true);
	});

	it('saves a flag on its item and keeps it there when a later version reorders the list', async () => {
		const key = itemKeys(items)[1]!;
		expect(await saveDone(lc.userWork, 'case-1', 'rv-1', items, key, true)).toBe(true);
		expect(infoRows(lc.userWork, 'case-1', items).rows.map((r) => r.done)).toEqual([false, true, false]);
		// a later version moves the item to another position: the flag follows the item, not the position
		const reordered = [items[1]!, items[2]!, items[0]!];
		expect(infoRows(lc.userWork, 'case-1', reordered).rows.map((r) => [r.item, r.done])).toEqual([['Invented item B', true], ['Invented item C', false], ['Invented item A', false]]);
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

	// Repeated texts (CC-05 r2): a flag stays on its item or detaches; it never moves to another item with the same text
	const dup = [
		{ item: 'Same invented text', owner: 'Ann', status: 'Outstanding' },
		{ item: 'Same invented text', owner: 'Ben', status: 'Outstanding' },
	];
	const flagFirst = async (list: typeof dup) => { await saveDone(lc.userWork, 'case-1', 'rv-1', list, itemKeys(list)[0]!, true); };
	const shown = (list: typeof dup) => { const r = infoRows(lc.userWork, 'case-1', list); return { rows: r.rows.map((x) => [x.owner, x.done]), detached: r.detached }; };

	it('detaches, never moves, the flag of a repeated text when the flagged repeat is reworded', async () => {
		await flagFirst(dup);
		expect(shown([{ ...dup[0]!, item: 'Same invented text, reworded' }, dup[1]!])).toEqual({ rows: [['Ann', false], ['Ben', false]], detached: 1 });
	});

	it('detaches, never moves, the flag of a repeated text when the flagged first repeat is removed', async () => {
		await flagFirst(dup);
		expect(shown([dup[1]!])).toEqual({ rows: [['Ben', false]], detached: 1 });
	});

	it('keeps the flag on its repeat when the repeats are reordered', async () => {
		await flagFirst(dup);
		expect(shown([dup[1]!, dup[0]!])).toEqual({ rows: [['Ben', false], ['Ann', true]], detached: 0 });
	});

	it('tells repeats with one owner apart by status, and detaches identical repeats whose count changed', async () => {
		const same = [{ ...dup[0]! }, { ...dup[0]! }, { ...dup[0]!, status: 'Done' }];
		expect(new Set(itemKeys(same)).size).toBe(3);
		await flagFirst(same);
		expect(shown(same)).toEqual({ rows: [['Ann', true], ['Ann', false], ['Ann', false]], detached: 0 });
		// one of the two identical repeats leaves: which one cannot be told, so the flag detaches
		expect(shown([same[1]!, same[2]!])).toEqual({ rows: [['Ann', false], ['Ann', false]], detached: 1 });
	});

	it('gives the NFC and NFD forms of a text one key', async () => {
		const nfc = { item: 'Caf\u00e9 receipt', owner: 'Ann', status: 'Outstanding' };
		const nfd = { ...nfc, item: 'Cafe\u0301 receipt' };
		expect(nfc.item).not.toBe(nfd.item);
		expect(itemKeys([nfd])).toEqual(itemKeys([nfc]));
		await saveDone(lc.userWork, 'case-1', 'rv-1', [nfc], itemKeys([nfc])[0]!, true);
		expect(infoRows(lc.userWork, 'case-1', [nfd])).toMatchObject({ rows: [{ done: true }], detached: 0 });
	});

	it('counts only saved checks (done) as detached, not unchecked flags', async () => {
		const key = itemKeys(items)[1]!;
		await saveDone(lc.userWork, 'case-1', 'rv-1', items, key, true);
		await saveDone(lc.userWork, 'case-1', 'rv-1', items, key, false);
		expect(infoRows(lc.userWork, 'case-1', [items[0]!]).detached).toBe(0);
	});

	it('answers 413 with a clear message, not a server error, for an item too long to store, and writes nothing', async () => {
		const huge = [{ item: 'x'.repeat(70_000), owner: 'Ann', status: 'Outstanding' }];
		await expect(saveDone(lc.userWork, 'case-1', 'rv-1', huge, itemKeys(huge)[0]!, true)).rejects.toMatchObject({ status: 413, body: { message: expect.stringMatching(/too long/) } });
		expect(lc.userWork.listRows('case-1', INFO_STORE)).toHaveLength(0);
	});

	it('renders an empty list without rows or errors', () => {
		expect(infoRows(lc.userWork, 'case-1', [])).toEqual({ rows: [], detached: 0 });
	});
});
