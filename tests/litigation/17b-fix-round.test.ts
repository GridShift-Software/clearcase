// Sprint ticket 17b, fix round (review of PR 191): the write fence of the hosted entry actions. A viewer is refused before
// anything else (403, storage unchanged); a write that rests on published content refuses a URL that is not the current
// publication; a plain user row, as in 17a, does not wait on the publication; two first saves of one step cannot both win.
import { describe, expect, it } from 'vitest';
import * as authorities from '../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/authorities_tab/+page.server.ts';
import * as heads from '../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/heads_tab/+page.server.ts';
import * as crossexam from '../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/crossexam_tab/+page.server.ts';
import * as enforcement from '../../deploy/client/routes/cases/[caseId]/v/[version]/litigation/enforcement_tab/+page.server.ts';
import { list, post, stale, stored, world } from './17b-world.ts';

const head = { head: 'Synthetic heading', sub: 'Synthetic submission', auth: '', ref: '' };

describe('17b fix round: a viewer is refused before anything else, with 403 and storage unchanged', () => {
	it.each([
		['authorities add', authorities, 'add', { topic: '', authority: 'Synthetic v Viewer', proposition: '' }],
		['authorities add that fails validation', authorities, 'add', { topic: 'Only a topic', authority: '', proposition: '' }],
		['heads add', heads, 'add', head],
		['heads add that fails validation', heads, 'add', { head: '', sub: '', auth: '', ref: '' }],
		['crossexam add', crossexam, 'add', { witness: 'Synthetic witness', topic: '', put: '', docs: '' }],
		['enforcement status', enforcement, 'status', { stepKey: 'step-key-1', status: 'Done', version: 'none' }],
		['enforcement status that fails validation', enforcement, 'status', { stepKey: 'step-key-1', status: 'Not a status', version: 'none' }],
	] as const)('%s', async (_name, route, action, form) => {
		const w = world('viewer');
		try {
			const before = stored(w);
			await expect(post(w, route, action, { ...form })).rejects.toMatchObject({ status: 403 });
			expect(stored(w)).toBe(before);
		} finally { w.db.close(); }
	});

	it('heads delete, crossexam row delete and crossexam seed delete', async () => {
		const w = world('viewer');
		try {
			const shown = (await list(w, crossexam)).rows[0];
			const before = stored(w);
			await expect(post(w, crossexam, 'delete', { seedId: shown.del, confirm: shown.del })).rejects.toMatchObject({ status: 403 });
			await expect(post(w, heads, 'delete', { rowId: 'no-such-row version', confirm: 'no-such-row version' })).rejects.toMatchObject({ status: 403 });
			await expect(post(w, crossexam, 'delete', { rowId: 'no-such-row version', confirm: 'no-such-row version' })).rejects.toMatchObject({ status: 403 });
			expect(stored(w)).toBe(before);
		} finally { w.db.close(); }
	});
});

describe('17b fix round: the publication fence follows 17a', () => {
	it('a plain user row on a URL that is not the published version still saves, as in 17a', async () => {
		const w = stale(world());
		try {
			expect(await post(w, authorities, 'add', { topic: '', authority: 'Synthetic v Stale URL', proposition: '' })).toMatchObject({ op: 'add' });
			expect(await post(w, heads, 'add', head)).toMatchObject({ op: 'add' });
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 2 });
		} finally { w.db.close(); }
	});

	it.each([['a stale version', (w: ReturnType<typeof world>) => stale(w)], ['a withdrawn publication', (_w: ReturnType<typeof world>) => world('editor', 'withdrawn')]] as const)(
		'a write that rests on published content is refused on %s, and storage is unchanged', async (_name, make) => {
			const base = world();
			const seed = (await list(base, crossexam)).rows[0];
			const w = make(base);
			try {
				const before = stored(w);
				await expect(post(w, crossexam, 'delete', { seedId: seed.del, confirm: seed.del })).rejects.toMatchObject({ status: 404 });
				await expect(post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Done', version: 'none' })).rejects.toMatchObject({ status: 404 });
				expect(stored(w)).toBe(before);
			} finally { base.db.close(); if (w.db !== base.db) w.db.close(); }
		});

	it('a status for a step the publication does not have is refused, and a seed it does not have is absent', async () => {
		const w = world();
		try {
			const before = stored(w);
			expect(await post(w, enforcement, 'status', { stepKey: 'no-such-step', status: 'Done', version: 'none' })).toMatchObject({ status: 404 });
			expect(await post(w, crossexam, 'delete', { seedId: 'no-such-seed none', confirm: 'no-such-seed none' })).toMatchObject({ status: 404 });
			expect(stored(w)).toBe(before);
		} finally { w.db.close(); }
	});
});

describe('17b fix round: two first saves of one step', () => {
	it('one wins and the other gets the local conflict message; one row is left', async () => {
		const w = world();
		try {
			const [a, b] = await Promise.all([
				post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Done', version: 'none' }),
				post(w, enforcement, 'status', { stepKey: 'step-key-1', status: 'Monitor', version: 'none' }),
			]);
			const outcomes = [a, b];
			expect(outcomes.filter((r) => r.saved === 'step-key-1')).toHaveLength(1);
			const lost = outcomes.find((r) => r.status === 409)!;
			expect(lost.data.errors['step-key-1'].message).toMatch(/^Not saved: this step's status was changed elsewhere/);
			expect(w.db.prepare("SELECT count(*) AS n FROM uw_register_row WHERE store = 'enforcement-status'").get()).toEqual({ n: 1 });
		} finally { w.db.close(); }
	});
});
