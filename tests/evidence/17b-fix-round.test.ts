// Sprint ticket 17b, fix round: the filings register's write fence (viewer 403, publication, stale deletes).
import { describe, expect, it } from 'vitest';
import * as filings from '../../deploy/client/routes/cases/[caseId]/v/[version]/evidence/filings_tab/+page.server.ts';
import { rowVersion } from '../../src/lib/views/evidence/filings.ts';
import { list, post, postOrRedirect, stale, stored, world, type World } from '../litigation/17b-world.ts';

const entry = { filing: 'Synthetic notice', fdate: '2026-02-01', fparty: 'Synthetic party', response: '', rdate: '', ref: '' };
const mine = async (w: World) => (await list(w, filings)).entries.find((e: { state: string }) => e.state === 'user');
const count = (w: World) => (w.db.prepare("SELECT count(*) AS n FROM uw_register_row WHERE store = 'filings-register'").get() as { n: number }).n;

describe('17b fix round: filings viewer', () => {
	it('add, add that fails validation, save and delete are each 403 and change nothing', async () => {
		const w = world('viewer');
		try {
			const seed = (await list(w, filings)).entries[0];
			const before = stored(w);
			await expect(post(w, filings, 'add', entry)).rejects.toMatchObject({ status: 403 });
			await expect(post(w, filings, 'add', { ...entry, filing: '' })).rejects.toMatchObject({ status: 403 });
			await expect(postOrRedirect(w, filings, 'save', { ...entry, key: seed.key, version: rowVersion(seed.fields) })).rejects.toMatchObject({ status: 403 });
			await expect(post(w, filings, 'delete', { delete: seed.key, confirm: seed.key })).rejects.toMatchObject({ status: 403 });
			await expect(post(w, filings, 'delete', { delete: 'row:no-such-row', confirm: 'row:no-such-row' })).rejects.toMatchObject({ status: 403 });
			expect(stored(w)).toBe(before);
		} finally { w.db.close(); }
	});
});

describe('17b fix round: filings publication fence', () => {
	it('a plain user row on a URL that is not the published version still saves and deletes, as in 17a', async () => {
		const w = stale(world());
		try {
			expect(await post(w, filings, 'add', entry)).toMatchObject({ op: 'add', saved: true });
			expect(count(w)).toBe(1);
		} finally { w.db.close(); }
	});

	it('an edit or delete of an imported row is refused on a version that is not the published one, storage unchanged', async () => {
		const base = world();
		const seed = (await list(base, filings)).entries[0];
		const w = stale(base);
		try {
			const before = stored(w);
			await expect(postOrRedirect(w, filings, 'save', { ...entry, key: seed.key, version: rowVersion(seed.fields) })).rejects.toMatchObject({ status: 404 });
			await expect(post(w, filings, 'delete', { delete: seed.key, confirm: seed.key, [`deleteVersion.${seed.key}`]: 'none' })).rejects.toMatchObject({ status: 404 });
			expect(stored(w)).toBe(before);
		} finally { base.db.close(); }
	});
});

describe('17b fix round: stale filing deletes', () => {
	it('the page names each row\'s and each imported row\'s version for its Delete', async () => {
		const w = world();
		try {
			await post(w, filings, 'add', entry);
			const page = await list(w, filings);
			const row = await mine(w);
			expect(page.deleteVersions[page.entries[0].key]).toBe('none');
			expect(page.deleteVersions[row.key]).toMatch(/\S/);
			expect(page.deleteVersions[row.key]).not.toBe('none');
		} finally { w.db.close(); }
	});

	it('a delete of a row amended elsewhere after the page showed it answers the conflict and changes nothing', async () => {
		const w = world();
		try {
			await post(w, filings, 'add', entry);
			const shown = (await list(w, filings)).deleteVersions;
			const row = await mine(w);
			await postOrRedirect(w, filings, 'save', { ...entry, filing: 'Amended elsewhere', key: row.key, version: rowVersion(row.fields) });
			const r = await post(w, filings, 'delete', { delete: row.key, confirm: row.key, [`deleteVersion.${row.key}`]: shown[row.key] });
			expect(r).toMatchObject({ status: 409, data: { op: 'delete' } });
			expect(r.data.message).toMatch(/changed elsewhere/);
			expect(count(w)).toBe(1);
		} finally { w.db.close(); }
	});

	it('a delete that names the version it was shown deletes; one that names none is refused as changed', async () => {
		const w = world();
		try {
			await post(w, filings, 'add', entry);
			const row = await mine(w);
			const shown = (await list(w, filings)).deleteVersions;
			expect(await post(w, filings, 'delete', { delete: row.key, confirm: row.key })).toMatchObject({ status: 409 });
			expect(count(w)).toBe(1);
			expect(await post(w, filings, 'delete', { delete: row.key, confirm: row.key, [`deleteVersion.${row.key}`]: shown[row.key] })).toMatchObject({ op: 'delete', deleted: true });
			expect(count(w)).toBe(0);
		} finally { w.db.close(); }
	});

	it('a delete of an imported row edited elsewhere after the page showed it answers the conflict and keeps the edit', async () => {
		const w = world();
		try {
			const seed = (await list(w, filings)).entries[0];
			const shown = (await list(w, filings)).deleteVersions[seed.key];
			expect(shown).toBe('none');
			await postOrRedirect(w, filings, 'save', { ...entry, filing: 'Imported filing, my edit', key: seed.key, version: rowVersion(seed.fields) });
			const r = await post(w, filings, 'delete', { delete: seed.key, confirm: seed.key, [`deleteVersion.${seed.key}`]: shown });
			expect(r).toMatchObject({ status: 409 });
			expect((await list(w, filings)).entries.map((e: { fields: { filing: string } }) => e.fields.filing)).toEqual(['Imported filing, my edit']);
		} finally { w.db.close(); }
	});

	it('a delete of an imported row at the version it was shown writes the overlay', async () => {
		const w = world();
		try {
			const seed = (await list(w, filings)).entries[0];
			expect(await post(w, filings, 'delete', { delete: seed.key, confirm: seed.key, [`deleteVersion.${seed.key}`]: 'none' })).toMatchObject({ op: 'delete', deleted: true });
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_seed_overlay').get()).toEqual({ n: 1 });
		} finally { w.db.close(); }
	});
});
