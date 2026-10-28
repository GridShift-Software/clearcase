// Sprint ticket 17b: Payments & Net Claim on the hosted app, through the route's own load and actions over the synthetic D1
// user-work double. Every value is invented.
import { describe, expect, it } from 'vitest';
import * as payments from '../../deploy/client/routes/cases/[caseId]/v/[version]/quantum/payments_tab/+page.server.ts';
import { list, post, world } from '../litigation/17b-world.ts';

const entry = { date: '2026-03-01', amount: '1500.50', method: 'Synthetic EFT', note: 'Synthetic note' };
const rows = (w: ReturnType<typeof world>) => w.db.prepare("SELECT row_id, fields_json FROM uw_register_row WHERE store = 'payments'").all() as { row_id: string; fields_json: string }[];

describe('17b payments', () => {
	it('adds a payment and lists it after a reload, with the amount in cents', async () => {
		const w = world();
		try {
			const page = await list(w, payments);
			expect(page.payments).toEqual([]);
			expect(await post(w, payments, 'add', { ...entry, operationId: page.operationId })).toEqual({ op: 'add', added: true });
			const after = await list(w, payments);
			expect(after.payments).toMatchObject([{ date: '2026-03-01', amount: '1500.50', amountCents: '150050', method: 'Synthetic EFT', note: 'Synthetic note' }]);
			expect(after.operationId).not.toBe(page.operationId);
		} finally { w.db.close(); }
	});

	it('two posts with one operationId make one payment', async () => {
		const w = world();
		try {
			const form = { ...entry, operationId: 'dddddddd-1111-2222-3333-444444444444' };
			await post(w, payments, 'add', form); await post(w, payments, 'add', form);
			expect(rows(w)).toHaveLength(1);
		} finally { w.db.close(); }
	});

	it('refuses an amount that is not money and a date that is not a date, writing nothing', async () => {
		const w = world();
		try {
			expect(await post(w, payments, 'add', { ...entry, amount: 'lots' })).toMatchObject({ status: 400, data: { field: 'amount' } });
			expect(await post(w, payments, 'add', { ...entry, date: '2026-13-45' })).toMatchObject({ status: 400, data: { field: 'date' } });
			expect(rows(w)).toEqual([]);
		} finally { w.db.close(); }
	});

	it('deletes a payment by the version the page showed', async () => {
		const w = world();
		try {
			await post(w, payments, 'add', entry);
			const p = (await list(w, payments)).payments[0];
			expect(await post(w, payments, 'delete', { rowId: p.rowId, [`hash.${p.rowId}`]: p.hash })).toMatchObject({ op: 'delete', deleted: true, target: p.rowId });
			expect((await list(w, payments)).payments).toEqual([]);
		} finally { w.db.close(); }
	});

	it('a delete with a stale version answers the local conflict message and deletes nothing', async () => {
		const w = world();
		try {
			await post(w, payments, 'add', entry);
			const p = (await list(w, payments)).payments[0];
			w.db.prepare("UPDATE uw_register_row SET version = 'changed-elsewhere' WHERE row_id = ?").run(p.rowId);
			const r = await post(w, payments, 'delete', { rowId: p.rowId, hash: p.hash });
			expect(r).toMatchObject({ status: 409, data: { op: 'delete', retry: false } });
			expect(r.data.message).toMatch(/^Not deleted: this payment changed since the page showed it/);
			expect(rows(w)).toHaveLength(1);
		} finally { w.db.close(); }
	});

	it('a delete of a payment deleted elsewhere answers the local gone message', async () => {
		const w = world();
		try {
			await post(w, payments, 'add', entry);
			const p = (await list(w, payments)).payments[0];
			await w.locals.userWork.deleteRow({ caseId: w.params.caseId as never, store: 'payments', rowId: p.rowId, expected: { kind: 'match', version: p.hash }, operationId: 'deleted-in-another-tab' });
			expect(await post(w, payments, 'delete', { rowId: p.rowId, hash: p.hash })).toMatchObject({ status: 404, data: { gone: true } });
		} finally { w.db.close(); }
	});

	it('a delete that names no version is refused as changed', async () => {
		const w = world();
		try {
			await post(w, payments, 'add', entry);
			const p = (await list(w, payments)).payments[0];
			expect(await post(w, payments, 'delete', { rowId: p.rowId })).toMatchObject({ status: 409 });
			expect(rows(w)).toHaveLength(1);
		} finally { w.db.close(); }
	});
});
