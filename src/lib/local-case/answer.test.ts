import { error, isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { actionCase, answer, guarded } from './answer.server.ts';
import { UserWorkError } from './user-work.server.ts';

const say = { busy: 'Busy: kept, try again.', refused: (e: UserWorkError) => `Not saved: ${e.message}`, failed: 'Not saved: the app failed. Kept.' };
const values = { head: 'typed' };
const thrown = (f: () => unknown) => { try { f(); } catch (e) { return e; } throw new Error('did not throw'); };

describe('answer()', () => {
	it("a busy store (the API's 503 after its retries) is 503 with retry, the values and the target", () => {
		const a = answer('delete', values, thrown(() => error(503, 'busy')), say, { target: 'r1' });
		expect([a.status, a.data]).toEqual([503, { op: 'delete', values, message: 'Busy: kept, try again.', retry: true, target: 'r1' }]);
	});
	it('a refused write (UserWorkError) is 400 with its reason and no retry', () => {
		const a = answer('add', values, new UserWorkError('fields are too large'), say);
		expect([a.status, a.data]).toEqual([400, { op: 'add', values, message: 'Not saved: fields are too large', retry: false }]);
	});
	it('a fixed refusal text is used as given', () => {
		expect(answer('add', values, new UserWorkError('x'), { ...say, refused: 'Refused.' }).data.message).toBe('Refused.');
	});
	it('any other fault is 500, keeps the values, offers no retry and never shows the fault', () => {
		for (const e of [new Error('SQLITE_CORRUPT at /secret/path'), thrown(() => error(404, 'nope')), 'a string']) {
			const a = answer('add', values, e, say);
			expect([a.status, a.data]).toEqual([500, { op: 'add', values, message: 'Not saved: the app failed. Kept.', retry: false }]);
		}
	});
});

describe('guarded()', () => {
	it('answers with the value, or with the failure answer', async () => {
		expect(await guarded('add', values, async () => 7, say)).toEqual({ ok: true, value: 7 });
		const r = await guarded('add', values, async () => { throw new UserWorkError('no'); }, say);
		expect(r.ok ? null : [r.failure.status, r.failure.data.message]).toEqual([400, 'Not saved: no']);
	});
});

describe('actionCase()', () => {
	const store = { getVersion: (id: string) => (id === 'v1' ? { id: 'v1', case_id: 'case-1' } : undefined) };
	it("names a stored version's case", () => expect(actionCase({ vid: 'v1' }, store)).toEqual({ vid: 'v1', caseId: 'case-1' }));
	it('an unknown version is a 404', () => {
		const e = thrown(() => actionCase({ vid: 'gone' }, store));
		expect(isHttpError(e) ? [e.status, e.body.message] : e).toEqual([404, 'Unknown results version']);
	});
});
