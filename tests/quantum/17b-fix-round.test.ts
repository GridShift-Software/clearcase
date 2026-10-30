// Sprint ticket 17b, fix round: a viewer's payments writes are refused with 403 before validation, storage unchanged.
import { describe, expect, it } from 'vitest';
import * as payments from '../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/payments_tab/+page.server.ts';
import { list, post, stale, stored, world } from '../litigation/17b-world.ts';

const entry = { date: '2026-03-01', amount: '10.00', method: 'Synthetic', note: '' };

describe('17b fix round: payments', () => {
	it('a viewer\'s add, add that fails validation, and delete are each 403 and change nothing', async () => {
		const w = world('viewer');
		try {
			const before = stored(w);
			await expect(post(w, payments, 'add', entry)).rejects.toMatchObject({ status: 403 });
			await expect(post(w, payments, 'add', { ...entry, amount: 'lots' })).rejects.toMatchObject({ status: 403 });
			await expect(post(w, payments, 'delete', { rowId: 'no-such-row', hash: 'v1' })).rejects.toMatchObject({ status: 403 });
			expect(stored(w)).toBe(before);
		} finally { w.db.close(); }
	});

	it('a payment on a URL that is not the published version still saves, as in 17a', async () => {
		const w = stale(world());
		try {
			expect(await post(w, payments, 'add', entry)).toEqual({ op: 'add', added: true });
			expect((await list(world(), payments)).payments).toEqual([]);
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 1 });
		} finally { w.db.close(); }
	});
});
