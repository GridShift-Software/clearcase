// Sprint ticket 17b: the filings register on the hosted app, through the route's own load and actions over the synthetic D1
// user-work double. Every value is invented.
import { describe, expect, it } from 'vitest';
import * as filings from '../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/filings_tab/+page.server.ts';
import { rowVersion } from '../../src/lib/views/evidence/filings.ts';
import { list, post, postOrRedirect, world, type World } from '../litigation/17b-world.ts';

const entry = { filing: 'Synthetic notice', fdate: '2026-02-01', fparty: 'Synthetic party', response: '', rdate: '', ref: '' };
const rowCount = (w: World) => (w.db.prepare("SELECT count(*) AS n FROM uw_register_row WHERE store = 'filings-register'").get() as { n: number }).n;
const overlays = (w: World) => w.db.prepare('SELECT seed_id, fields_json FROM uw_seed_overlay').all() as { seed_id: string; fields_json: string }[];
const filingsOf = async (w: World) => (await list(w, filings)).entries.map((e: { key: string; fields: { filing: string }; state: string }) => [e.state, e.fields.filing]);

describe('17b filings register', () => {
	it('adds an entry after the imported one and lists it after a reload', async () => {
		const w = world();
		try {
			const page = await list(w, filings);
			expect(await post(w, filings, 'add', { ...entry, operationId: page.operationId })).toEqual({ op: 'add', saved: true });
			expect(await filingsOf(w)).toEqual([['seed', 'Imported filing'], ['user', 'Synthetic notice']]);
			expect((await list(w, filings)).operationId).not.toBe(page.operationId);
		} finally { w.db.close(); }
	});

	it('two posts with one operationId make one entry', async () => {
		const w = world();
		try {
			const form = { ...entry, operationId: 'eeeeeeee-1111-2222-3333-444444444444' };
			await post(w, filings, 'add', form); await post(w, filings, 'add', form);
			expect(rowCount(w)).toBe(1);
		} finally { w.db.close(); }
	});

	it('refuses an entry with no filing and writes nothing', async () => {
		const w = world();
		try {
			expect(await post(w, filings, 'add', { ...entry, filing: '' })).toMatchObject({ status: 400, data: { code: 'empty-add' } });
			expect(rowCount(w)).toBe(0);
		} finally { w.db.close(); }
	});

	it('edits an entry against the version it was shown and lists the change', async () => {
		const w = world();
		try {
			await post(w, filings, 'add', entry);
			const shown = (await list(w, filings)).entries.find((e: { state: string }) => e.state === 'user');
			const saved = await postOrRedirect(w, filings, 'save', { ...entry, filing: 'Synthetic notice, amended', key: shown.key, version: rowVersion(shown.fields) });
			expect(saved).toMatchObject({ redirected: '/' });
			expect(await filingsOf(w)).toEqual([['seed', 'Imported filing'], ['user', 'Synthetic notice, amended']]);
			expect(rowCount(w)).toBe(1);
		} finally { w.db.close(); }
	});

	it('a save with a stale version answers the local conflict message and changes nothing', async () => {
		const w = world();
		try {
			await post(w, filings, 'add', entry);
			const shown = (await list(w, filings)).entries.find((e: { state: string }) => e.state === 'user');
			const version = rowVersion(shown.fields);
			await postOrRedirect(w, filings, 'save', { ...entry, filing: 'Changed in another tab', key: shown.key, version });
			const stale = await postOrRedirect(w, filings, 'save', { ...entry, filing: 'Changed from a stale page', key: shown.key, version });
			expect(stale).toMatchObject({ status: 409, data: { op: 'save', code: 'stale', values: { filing: 'Changed from a stale page' } } });
			expect(await filingsOf(w)).toEqual([['seed', 'Imported filing'], ['user', 'Changed in another tab']]);
		} finally { w.db.close(); }
	});

	it('a save of an entry deleted elsewhere answers the local gone message', async () => {
		const w = world();
		try {
			await post(w, filings, 'add', entry);
			const shown = (await list(w, filings)).entries.find((e: { state: string }) => e.state === 'user');
			w.db.prepare('DELETE FROM uw_register_row').run();
			expect(await postOrRedirect(w, filings, 'save', { ...entry, key: shown.key, version: rowVersion(shown.fields) })).toMatchObject({ status: 404, data: { code: 'gone' } });
		} finally { w.db.close(); }
	});

	it('deletes an entry once confirmed, and asks first', async () => {
		const w = world();
		try {
			await post(w, filings, 'add', entry);
			const shown = (await list(w, filings)).entries.find((e: { state: string }) => e.state === 'user');
			const version = (await list(w, filings)).deleteVersions[shown.key];
			expect(await post(w, filings, 'delete', { delete: shown.key })).toMatchObject({ status: 400, data: { confirm: shown.key } });
			expect(rowCount(w)).toBe(1);
			expect(await post(w, filings, 'delete', { delete: shown.key, confirm: shown.key, [`deleteVersion.${shown.key}`]: version })).toMatchObject({ op: 'delete', deleted: true });
			expect(rowCount(w)).toBe(0);
		} finally { w.db.close(); }
	});

	it('editing an imported entry writes a seed overlay and leaves the imported row as it was', async () => {
		const w = world();
		try {
			const seed = (await list(w, filings)).entries[0];
			await postOrRedirect(w, filings, 'save', { ...entry, filing: 'Imported filing, my edit', key: seed.key, version: rowVersion(seed.fields) });
			expect(overlays(w)).toHaveLength(1);
			expect(rowCount(w)).toBe(0);
			expect(await filingsOf(w)).toEqual([['edited', 'Imported filing, my edit']]);
		} finally { w.db.close(); }
	});

	it('deleting an imported entry writes a seed overlay, not a row delete, and it is gone after a reload', async () => {
		const w = world();
		try {
			const seed = (await list(w, filings)).entries[0];
			expect(await post(w, filings, 'delete', { delete: seed.key, confirm: seed.key, [`deleteVersion.${seed.key}`]: 'none' })).toMatchObject({ op: 'delete', deleted: true });
			expect(overlays(w)).toMatchObject([{ seed_id: 'fr-1' }]);
			expect(JSON.parse(overlays(w)[0]!.fields_json)).toMatchObject({ deleted: true });
			expect(rowCount(w)).toBe(0);
			expect(await filingsOf(w)).toEqual([]);
		} finally { w.db.close(); }
	});

	it('the edit link selects the entry to edit', async () => {
		const w = world();
		try {
			await post(w, filings, 'add', entry);
			const mine = (await list(w, filings)).entries.find((e: { state: string }) => e.state === 'user');
			expect((await list(w, filings, `?edit=${encodeURIComponent(mine.key)}`)).editing).toBe(mine.key);
		} finally { w.db.close(); }
	});
});
