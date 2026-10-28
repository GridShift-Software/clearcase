// Sprint ticket 17b: Authorities, Heads of Argument, Cross-examination and the Enforcement Roadmap on the hosted app, through
// the routes' own loads and actions over the synthetic D1 user-work double. Every value is invented.
import { describe, expect, it } from 'vitest';
import * as authorities from '../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/authorities_tab/+page.server.ts';
import * as heads from '../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/heads_tab/+page.server.ts';
import * as crossexam from '../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/crossexam_tab/+page.server.ts';
import * as enforcement from '../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/enforcement_tab/+page.server.ts';
import { DELETE_GONE, DELETE_STALE } from '../../src/lib/views/litigation/answers.server.ts';
import { list, post, world, CASE } from './17b-world.ts';

const head = { head: 'Synthetic heading', sub: 'Synthetic submission', auth: 'Synthetic authority', ref: '' };
const rowsIn = (w: ReturnType<typeof world>, store: string) => w.db.prepare('SELECT row_id, fields_json FROM uw_register_row WHERE store = ? ORDER BY rowid').all(store) as { row_id: string; fields_json: string }[];

describe('17b authorities', () => {
	it('adds an authority and lists it after a reload', async () => {
		const w = world();
		try {
			const page = await list(w, authorities);
			expect(page.user).toEqual([]);
			expect(await post(w, authorities, 'add', { topic: 'Synthetic topic', authority: 'Synthetic v Synthetic', proposition: 'Synthetic proposition', addId: page.addId })).toMatchObject({ op: 'add' });
			const after = await list(w, authorities);
			expect(after.user).toMatchObject([{ topic: 'Synthetic topic', authority: 'Synthetic v Synthetic', proposition: 'Synthetic proposition' }]);
			expect(after.addId).not.toBe(page.addId);
		} finally { w.db.close(); }
	});

	it('two posts with one addId make one row; the same addId with changed text is a new entry', async () => {
		const w = world();
		try {
			const form = { topic: '', authority: 'Synthetic v One', proposition: '', addId: 'aaaaaaaa-1111-2222-3333-444444444444' };
			const first = await post(w, authorities, 'add', form), again = await post(w, authorities, 'add', form);
			expect(again.added).toBe(first.added);
			expect(rowsIn(w, 'authorities')).toHaveLength(1);
			await post(w, authorities, 'add', { ...form, authority: 'Synthetic v Two' });
			expect(rowsIn(w, 'authorities')).toHaveLength(2);
		} finally { w.db.close(); }
	});

	it('refuses an authority with no authority name and writes nothing', async () => {
		const w = world();
		try {
			expect(await post(w, authorities, 'add', { topic: 'Only a topic', authority: '', proposition: '' })).toMatchObject({ status: 400 });
			expect(rowsIn(w, 'authorities')).toEqual([]);
		} finally { w.db.close(); }
	});

	it('a viewer\'s add is refused by the store and nothing is written', async () => {
		const w = world('viewer');
		try {
			await expect(post(w, authorities, 'add', { topic: '', authority: 'Synthetic v Refused', proposition: '' })).rejects.toMatchObject({ status: expect.any(Number) });
			expect(rowsIn(w, 'authorities')).toEqual([]);
		} finally { w.db.close(); }
	});
});

describe('17b heads of argument', () => {
	it('adds a head, lists it with its delete token, and deletes it once confirmed', async () => {
		const w = world();
		try {
			expect(await post(w, heads, 'add', { ...head, addId: (await list(w, heads)).addId })).toMatchObject({ op: 'add' });
			const shown = (await list(w, heads)).rows;
			expect(shown).toMatchObject([{ head: 'Synthetic heading', sub: 'Synthetic submission' }]);
			// without the confirmation the server asks and deletes nothing
			expect(await post(w, heads, 'delete', { rowId: shown[0].del })).toMatchObject({ status: 400, data: { confirm: shown[0].del } });
			expect((await list(w, heads)).rows).toHaveLength(1);
			expect(await post(w, heads, 'delete', { rowId: shown[0].del, confirm: shown[0].del })).toMatchObject({ op: 'delete', deleted: shown[0].rowId });
			expect((await list(w, heads)).rows).toEqual([]);
		} finally { w.db.close(); }
	});

	it('two posts with one addId make one head', async () => {
		const w = world();
		try {
			const form = { ...head, addId: 'bbbbbbbb-1111-2222-3333-444444444444' };
			await post(w, heads, 'add', form); await post(w, heads, 'add', form);
			expect((await list(w, heads)).rows).toHaveLength(1);
			expect(w.db.prepare("SELECT count(*) AS n FROM uw_operation").get()).toEqual({ n: 1 });
		} finally { w.db.close(); }
	});

	it('a delete with a stale version answers the local conflict message and deletes nothing', async () => {
		const w = world();
		try {
			await post(w, heads, 'add', head);
			const row = (await list(w, heads)).rows[0];
			const id = row.rowId, version = row.del.slice(id.length + 1);
			// the row changes elsewhere: the version the page showed is no longer the row's
			w.db.prepare("UPDATE uw_register_row SET version = 'changed-elsewhere' WHERE row_id = ?").run(id);
			expect(await post(w, heads, 'delete', { rowId: `${id} ${version}`, confirm: `${id} ${version}` })).toMatchObject({ status: 409, data: { message: DELETE_STALE } });
			expect(rowsIn(w, 'heads')).toHaveLength(1);
		} finally { w.db.close(); }
	});

	it('a delete of a row deleted elsewhere answers the local gone message', async () => {
		const w = world();
		try {
			await post(w, heads, 'add', head);
			const row = (await list(w, heads)).rows[0];
			const version = row.del.slice(row.rowId.length + 1);
			// deleted in another tab: a different operation, so not a replay of this one
			await w.locals.userWork.deleteRow({ caseId: CASE, store: 'heads', rowId: row.rowId, expected: { kind: 'match', version: version as never }, operationId: 'deleted-in-another-tab' });
			expect(await post(w, heads, 'delete', { rowId: row.del, confirm: row.del })).toMatchObject({ gone: true, message: DELETE_GONE });
		} finally { w.db.close(); }
	});

	it('a delete that names no version is refused as changed, never run against the row as it is now', async () => {
		const w = world();
		try {
			await post(w, heads, 'add', head);
			const row = (await list(w, heads)).rows[0];
			expect(await post(w, heads, 'delete', { rowId: row.rowId, confirm: row.rowId })).toMatchObject({ status: 409, data: { message: DELETE_STALE } });
			expect(rowsIn(w, 'heads')).toHaveLength(1);
		} finally { w.db.close(); }
	});
});

describe('17b cross-examination', () => {
	const cx = { witness: 'Synthetic witness', topic: 'Synthetic topic', put: 'Synthetic put', docs: '' };

	it('adds a topic after the imported ones, lists it, and deletes it', async () => {
		const w = world();
		try {
			await post(w, crossexam, 'add', { ...cx, addId: (await list(w, crossexam)).addId });
			const rows = (await list(w, crossexam)).rows;
			expect(rows.map((r: { kind: string; witness: string }) => [r.kind, r.witness])).toEqual([['seed', 'Imported witness'], ['user', 'Synthetic witness']]);
			const mine = rows[1];
			expect(await post(w, crossexam, 'delete', { rowId: mine.del, confirm: mine.del })).toMatchObject({ op: 'delete', deleted: mine.target.rowId });
			expect((await list(w, crossexam)).rows).toHaveLength(1);
		} finally { w.db.close(); }
	});

	it('two posts with one addId make one topic', async () => {
		const w = world();
		try {
			const form = { ...cx, addId: 'cccccccc-1111-2222-3333-444444444444' };
			await post(w, crossexam, 'add', form); await post(w, crossexam, 'add', form);
			expect(rowsIn(w, 'crossexam')).toHaveLength(1);
		} finally { w.db.close(); }
	});

	it('deleting an imported topic writes a seed overlay, not a row delete, and the topic is gone after a reload', async () => {
		const w = world();
		try {
			const seed = (await list(w, crossexam)).rows[0];
			expect(seed.kind).toBe('seed');
			expect(await post(w, crossexam, 'delete', { seedId: seed.del, confirm: seed.del })).toMatchObject({ op: 'delete', deleted: seed.target.seedId });
			expect(w.db.prepare('SELECT seed_id, fields_json FROM uw_seed_overlay').all()).toEqual([{ seed_id: 'cx-1', fields_json: '{"deleted":true}' }]);
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 0 });
			expect((await list(w, crossexam)).rows).toEqual([]);
		} finally { w.db.close(); }
	});

	it('deleting an imported topic that was already deleted elsewhere answers the local gone message and writes nothing more', async () => {
		const w = world();
		try {
			const seed = (await list(w, crossexam)).rows[0];
			await w.locals.userWork.putSeedOverlay({ caseId: CASE, overlay: { caseId: CASE, datasetKey: 'lit-crossexam-seed', seedId: 'cx-1', baseSeedSha256: 'a'.repeat(64), fields: { deleted: true } }, expected: { kind: 'absent' }, operationId: 'deleted-in-another-tab' });
			expect(await post(w, crossexam, 'delete', { seedId: seed.del, confirm: seed.del })).toMatchObject({ gone: true, message: DELETE_GONE });
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_seed_overlay').get()).toEqual({ n: 1 });
		} finally { w.db.close(); }
	});

	it('a seed the user edited elsewhere is refused as changed when deleted from the page that showed it as imported', async () => {
		const w = world();
		try {
			const seed = (await list(w, crossexam)).rows[0];
			await w.locals.userWork.putSeedOverlay({ caseId: CASE, overlay: { caseId: CASE, datasetKey: 'lit-crossexam-seed', seedId: 'cx-1', baseSeedSha256: 'a'.repeat(64), fields: { put: 'Edited elsewhere' } }, expected: { kind: 'absent' }, operationId: 'edit-elsewhere' });
			expect(await post(w, crossexam, 'delete', { seedId: seed.del, confirm: seed.del })).toMatchObject({ status: 409, data: { message: DELETE_STALE } });
			expect(w.db.prepare('SELECT fields_json FROM uw_seed_overlay').all()).toEqual([{ fields_json: '{"put":"Edited elsewhere"}' }]);
		} finally { w.db.close(); }
	});
});

describe('17b enforcement roadmap', () => {
	const statusOf = (page: { rows: { key: string; override: string | null; status: string; version: string }[] }, key: string) => page.rows.find((r) => r.key === key)!;

	it('a status change persists and the step shows it after a reload', async () => {
		const w = world();
		try {
			const before = statusOf(await list(w, enforcement), 'step-key-1');
			expect(before).toMatchObject({ override: null, version: 'none' });
			expect(await post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Done', version: before.version })).toMatchObject({ op: 'status', saved: 'step-key-1' });
			const after = statusOf(await list(w, enforcement), 'step-key-1');
			expect(after.override).toBe('Done');
			expect(statusOf(await list(w, enforcement), 'step-key-2').override).toBeNull();
			// and it changes again against the version it now shows
			expect(await post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Monitor', version: after.version })).toMatchObject({ saved: 'step-key-1' });
			expect(statusOf(await list(w, enforcement), 'step-key-1').override).toBe('Monitor');
			expect(rowsIn(w, 'enforcement-status')).toHaveLength(1);
		} finally { w.db.close(); }
	});

	it('a save with a stale version answers the local conflict message and changes nothing', async () => {
		const w = world();
		try {
			const shown = statusOf(await list(w, enforcement), 'step-key-1');
			await post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Done', version: shown.version });
			const stale = await post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Monitor', version: shown.version });
			expect(stale).toMatchObject({ status: 409, data: { errors: { 'step-key-1': { retry: true } } } });
			expect(stale.data.errors['step-key-1'].message).toBe('Not saved: this step\'s status was changed elsewhere (in another tab or window) to “Done”. Your choice is kept; press Retry to save it over that change.');
			expect(statusOf(await list(w, enforcement), 'step-key-1').override).toBe('Done');
		} finally { w.db.close(); }
	});

	it('a first status still writes after the row it made was removed out of band (an operation is never replayed for it)', async () => {
		const w = world();
		try {
			await post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Done', version: 'none' });
			w.db.prepare('DELETE FROM uw_register_row').run();
			expect(await post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Done', version: 'none' })).toMatchObject({ saved: 'step-key-1' });
			expect(statusOf(await list(w, enforcement), 'step-key-1').override).toBe('Done');
		} finally { w.db.close(); }
	});

	it('refuses a status the step does not offer, and a step the version does not have, writing nothing', async () => {
		const w = world();
		try {
			expect(await post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Not a status', version: 'none' })).toMatchObject({ status: 400 });
			expect(await post(w, enforcement, 'status', { stepKey: 'no-such-step', status: 'Done', version: 'none' })).toMatchObject({ status: 404 });
			expect(rowsIn(w, 'enforcement-status')).toEqual([]);
		} finally { w.db.close(); }
	});

	it('saves several steps changed in one submission', async () => {
		const w = world();
		try {
			const r = await post(w, enforcement, 'status', { 'status:step-key-1': 'Done', 'was:step-key-1': 'To do', 'ver:step-key-1': 'none', 'status:step-key-2': 'In progress', 'was:step-key-2': 'To do', 'ver:step-key-2': 'none' });
			expect(r).toMatchObject({ savedKeys: ['step-key-1', 'step-key-2'] });
			expect((await list(w, enforcement)).rows.map((x: { override: string }) => x.override)).toEqual(['Done', 'In progress']);
		} finally { w.db.close(); }
	});
});
