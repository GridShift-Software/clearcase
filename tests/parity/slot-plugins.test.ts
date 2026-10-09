// Overview tiles and slot plug-ins (scripts/parity/adapters/app/_shell.mjs, overview.mjs): readOverviewTiles returns
// the seven tiles under v5's labels; a filled slot with a plug-in (adapters/app/slots/<slot-id>.mjs) is read by it;
// the overview's seeded_user_work sweep seeds through every plug-in, reads the tiles and cleans up, also on failure.
// Without a plug-in the output is what the adapter produced before. A fake page and fake plug-ins in a temp folder;
// nothing touches the repository.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { loadSlotPlugins, readOverviewTiles, SLOTS_DIR, type SlotPlugin } from '../../scripts/parity/adapters/app/_shell.mjs';
import overview from '../../scripts/parity/adapters/app/overview.mjs';
import { seededUserWork } from '../../scripts/parity/lib/sweeps.mjs';

const root = mkdtempSync(join(tmpdir(), 'parity-slots-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const CLOCK = '2026-10-08T09:00:00Z';
const UNFILLED = (linear: string, owner: string) => `Not yet available — owned by ${linear} (${owner}).`;

/** A fake app page: the overview's tiles as the shared extractor sees them, and the three slots in the given states. */
function fakePage(status: Record<string, string> = {}) {
	const visits: string[] = [];
	const kpi = (label: string, value: string, sub: string) => ({ label, value, sub });
	const p = {
		visits,
		goto: async (url: string) => { visits.push(url); },
		settled: async () => {},
		extract: async () => ({
			h1: ['Overview'], tables: [], paragraphs: [], lists: [], controls: [],
			kpis: [kpi('Documents indexed', '12', 'synthetic'), kpi('Amount due (to date)', 'R 1.00', 'a'), kpi('Invoices', '2', 'b'), kpi('Contradiction flags', '0', 'c'), kpi('Without extracted text', '1', 'd')],
		}),
		evaluate: async () => [
			{ id: 'deadlines', status: status.deadlines ?? 'unavailable', label: 'Open deadlines', text: status.deadlines === 'filled' ? '4 widget' : UNFILLED('GRS-17', 'CC-07') },
			{ id: 'unbilled-time', status: status['unbilled-time'] ?? 'unavailable', label: 'Unbilled time', text: UNFILLED('GRS-17', 'CC-07') },
			{ id: 'rescan-freshness', status: status['rescan-freshness'] ?? 'unavailable', label: 'Freshness', text: UNFILLED('GRS-20', 'CC-10') },
		],
	};
	return p;
}
const ctxWith = (plugins: Map<string, SlotPlugin>) => ({ base: '/v/x', clock: CLOCK, slotPlugins: plugins });

/** A fake deadlines plug-in recording its calls; `rows` is what the seed received. */
function fakeDeadlines({ failRead = false } = {}) {
	const log: string[] = [];
	const state = { rows: 0 };
	const pl: SlotPlugin & { log: string[]; state: typeof state } = {
		log, state,
		seed: async (_p, _c, rows) => { log.push('seed'); state.rows = (rows as ReturnType<typeof seededUserWork>).ess_dcs_deadlines_v1.length; },
		read: async () => { log.push('read'); if (failRead) throw new Error('synthetic read failure'); return { value: String(state.rows), sub: 'synthetic caption' }; },
		cleanup: async () => { log.push('cleanup'); state.rows = 0; },
	};
	return pl;
}

describe('readOverviewTiles', () => {
	test('the seven tiles under v5 labels; unfilled slots by their wording with an empty caption', async () => {
		const p = fakePage();
		const tiles = await readOverviewTiles(p, ctxWith(new Map()));
		expect(Object.keys(tiles)).toEqual(['Documents indexed', 'Amount due (to date)', 'Invoices', 'Open deadlines', 'Unbilled time', 'Contradiction flags', 'Scanned (need OCR)']);
		expect(tiles['Open deadlines']).toEqual({ value: UNFILLED('GRS-17', 'CC-07'), sub: '' });
		expect(tiles['Scanned (need OCR)']).toEqual({ value: '1', sub: 'd' });
		expect(p.visits).toEqual(['/v/x/overview']);
	});
	test('a filled slot with a plug-in is read by the plug-in; an unfilled one is not, even with a plug-in', async () => {
		const pl = fakeDeadlines();
		pl.state.rows = 2;
		expect((await readOverviewTiles(fakePage({ deadlines: 'filled' }), ctxWith(new Map([['deadlines', pl]]))))['Open deadlines']).toEqual({ value: '2', sub: 'synthetic caption' });
		expect((await readOverviewTiles(fakePage(), ctxWith(new Map([['deadlines', pl]]))))['Open deadlines']).toEqual({ value: UNFILLED('GRS-17', 'CC-07'), sub: '' });
		expect(pl.log).toEqual(['read']);
	});
});

describe('the seeded_user_work sweep', () => {
	test('without a plug-in: nothing is seeded and the output is the tiles as before', async () => {
		const out = await overview.sweeps.seeded_user_work(fakePage(), ctxWith(new Map()));
		// the pre-plug-in adapter's encoding: '<label>.value' and '<label>.sub' per tile, in tile order
		expect(out).toEqual({
			'Documents indexed.value': '12', 'Documents indexed.sub': 'synthetic', 'Amount due (to date).value': 'R 1.00', 'Amount due (to date).sub': 'a', 'Invoices.value': '2', 'Invoices.sub': 'b',
			'Open deadlines.value': UNFILLED('GRS-17', 'CC-07'), 'Open deadlines.sub': '', 'Unbilled time.value': UNFILLED('GRS-17', 'CC-07'), 'Unbilled time.sub': '',
			'Contradiction flags.value': '0', 'Contradiction flags.sub': 'c', 'Scanned (need OCR).value': '1', 'Scanned (need OCR).sub': 'd',
		});
		expect(Object.keys(out)[0]).toBe('Documents indexed.value');
	});
	test("with a plug-in: seed with seededUserWork(clock), read the tiles, then clean up", async () => {
		const pl = fakeDeadlines();
		const out = await overview.sweeps.seeded_user_work(fakePage({ deadlines: 'filled' }), ctxWith(new Map([['deadlines', pl]])));
		expect(pl.log).toEqual(['seed', 'read', 'cleanup']);
		expect(out['Open deadlines.value']).toBe(String(seededUserWork(CLOCK).ess_dcs_deadlines_v1.length));
		expect(out['Open deadlines.sub']).toBe('synthetic caption');
		expect(pl.state.rows).toBe(0);
	});
	test('cleanup runs even when the read fails', async () => {
		const pl = fakeDeadlines({ failRead: true });
		await expect(overview.sweeps.seeded_user_work(fakePage({ deadlines: 'filled' }), ctxWith(new Map([['deadlines', pl]])))).rejects.toThrow(/synthetic read failure/);
		expect(pl.log).toEqual(['seed', 'read', 'cleanup']);
	});
});

describe('loadSlotPlugins', () => {
	const dir = (files: Record<string, string>) => { const d = mkdtempSync(join(root, 'slots-')); for (const [n, s] of Object.entries(files)) writeFileSync(join(d, n), s); return d; };
	const plugin = `export default { read: async () => ({ value: '1', sub: '' }), seed: async () => {}, cleanup: async () => {} };\n`;
	test('one module per declared slot, in slot order; named exports work; _ files are skipped', async () => {
		const named = `export const read = async () => ({ value: '2', sub: '' }); export const seed = async () => {}; export const cleanup = async () => {};\n`;
		const m = await loadSlotPlugins(dir({ 'unbilled-time.mjs': named, 'deadlines.mjs': plugin, '_helper.mjs': 'throw new Error("not loaded")', 'notes.txt': '' }));
		expect([...m.keys()]).toEqual(['deadlines', 'unbilled-time']);
		expect(await m.get('unbilled-time')!.read(null, null)).toEqual({ value: '2', sub: '' });
	});
	test('an unknown slot name or a missing function is an error', async () => {
		await expect(loadSlotPlugins(dir({ 'deadline.mjs': plugin }))).rejects.toThrow(/deadline is not an overview slot/);
		await expect(loadSlotPlugins(dir({ 'deadlines.mjs': 'export default { read() {}, seed() {} };\n' }))).rejects.toThrow(/must export read\(p, ctx\), seed\(p, ctx, rows\) and cleanup\(p, ctx\)/);
	});
	test('the committed tree has no plug-in yet, so the overview behaves as before', async () => {
		expect((await loadSlotPlugins(SLOTS_DIR)).size).toBe(0);
		expect((await loadSlotPlugins(join(root, 'no-such-dir'))).size).toBe(0);
	});
});
