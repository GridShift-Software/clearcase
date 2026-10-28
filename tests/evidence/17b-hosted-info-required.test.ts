// Sprint ticket 17b: the Information Required checklist on the hosted app, through the route's own load and action over the
// synthetic D1 user-work double. Every value is invented.
import { describe, expect, it } from 'vitest';
import * as info from '../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/info_required_tab/+page.server.ts';
import { list, post, world } from '../litigation/17b-world.ts';

const doneOf = async (w: ReturnType<typeof world>) => Object.fromEntries((await list(w, info)).rows.map((r: { key: string; done: boolean }) => [r.key, r.done]));

describe('17b information required', () => {
	it('a tick persists across a reload and an untick persists too', async () => {
		const w = world();
		try {
			expect(await doneOf(w)).toEqual({ 'info:one': false, 'info:two': false });
			expect(await post(w, info, 'toggle', { key: 'info:one', done: 'true' })).toMatchObject({ saved: 'info:one', done: true });
			expect(await doneOf(w)).toEqual({ 'info:one': true, 'info:two': false });
			expect(await post(w, info, 'toggle', { key: 'info:one' })).toMatchObject({ saved: 'info:one', done: false });
			expect(await doneOf(w)).toEqual({ 'info:one': false, 'info:two': false });
			expect(w.db.prepare("SELECT row_id FROM uw_register_row WHERE store = 'info-required'").all()).toEqual([{ row_id: 'info:one' }]);
		} finally { w.db.close(); }
	});

	it('a tick of an item this version does not list is refused and writes nothing; the other pending checks ride along', async () => {
		const w = world();
		try {
			const pending = JSON.stringify({ key: 'info:two', done: true, message: 'Not saved.' });
			expect(await post(w, info, 'toggle', { key: 'info:nope', done: 'true', pending })).toMatchObject({ status: 400, data: { key: 'info:nope', message: 'This item is not in this results version.', pending: [{ key: 'info:two', done: true }] } });
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 0 });
		} finally { w.db.close(); }
	});

	it('the same tick posted twice is one write', async () => {
		const w = world();
		try {
			await post(w, info, 'toggle', { key: 'info:one', done: 'true' });
			await post(w, info, 'toggle', { key: 'info:one', done: 'true' });
			expect(await doneOf(w)).toMatchObject({ 'info:one': true });
			expect(w.db.prepare("SELECT count(*) AS n FROM uw_operation").get()).toEqual({ n: 1 });
		} finally { w.db.close(); }
	});

	it('a first tick still writes after the row it made was removed out of band (an operation is never replayed for it)', async () => {
		const w = world();
		try {
			await post(w, info, 'toggle', { key: 'info:one', done: 'true' });
			w.db.prepare('DELETE FROM uw_register_row').run();
			expect(await post(w, info, 'toggle', { key: 'info:one', done: 'true' })).toMatchObject({ saved: 'info:one' });
			expect(await doneOf(w)).toMatchObject({ 'info:one': true });
		} finally { w.db.close(); }
	});

	it('a viewer cannot tick', async () => {
		const w = world('viewer');
		try {
			await expect(post(w, info, 'toggle', { key: 'info:one', done: 'true' })).rejects.toMatchObject({ status: expect.any(Number) });
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 0 });
		} finally { w.db.close(); }
	});
});
