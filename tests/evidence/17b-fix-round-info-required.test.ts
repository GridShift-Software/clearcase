// Sprint ticket 17b, fix round: the Information Required toggle. A viewer is refused first; a tick names the version of the
// row the page showed (absence included) and is refused when the row has changed; the form's operation id survives a failed audit.
import { describe, expect, it } from 'vitest';
import * as info from '../../deploy/client/routes/cases/[caseId]/v/[version]/analysis/info_required_tab/+page.server.ts';
import { list, post, stale, stored, world } from '../litigation/17b-world.ts';

const doneOf = async (w: ReturnType<typeof world>) => Object.fromEntries((await list(w, info)).rows.map((r: { key: string; done: boolean }) => [r.key, r.done]));

describe('17b fix round: information required', () => {
	it('a viewer\'s tick, untick of an untouched item, and tick of an unknown item are each 403 and change nothing', async () => {
		const w = world('viewer');
		try {
			const before = stored(w);
			await expect(post(w, info, 'toggle', { key: 'info:one', done: 'true', version: 'none' })).rejects.toMatchObject({ status: 403 });
			await expect(post(w, info, 'toggle', { key: 'info:one', version: 'none' })).rejects.toMatchObject({ status: 403 });
			await expect(post(w, info, 'toggle', { key: 'info:nope', done: 'true', version: 'none' })).rejects.toMatchObject({ status: 403 });
			expect(stored(w)).toBe(before);
		} finally { w.db.close(); }
	});

	it('a tick on a URL that is not the published version, or with the publication withdrawn, is refused and changes nothing', async () => {
		const base = world(), gone = world('editor', 'withdrawn');
		try {
			for (const w of [stale(base), gone]) {
				const before = stored(w);
				await expect(post(w, info, 'toggle', { key: 'info:one', done: 'true', version: 'none' })).rejects.toMatchObject({ status: 404 });
				expect(stored(w)).toBe(before);
			}
		} finally { base.db.close(); gone.db.close(); }
	});

	it('the page names each item\'s version, absence included', async () => {
		const w = world();
		try {
			expect((await list(w, info)).versions).toEqual({ 'info:one': 'none', 'info:two': 'none' });
			await post(w, info, 'toggle', { key: 'info:one', done: 'true', version: 'none' });
			const after = (await list(w, info)).versions;
			expect(after['info:one']).not.toBe('none');
			expect(after['info:two']).toBe('none');
		} finally { w.db.close(); }
	});

	it('a tick made against a version the row has moved past answers the conflict and changes nothing', async () => {
		const w = world();
		try {
			await post(w, info, 'toggle', { key: 'info:one', done: 'true', version: 'none' });
			const shown = (await list(w, info)).versions['info:one'];
			await post(w, info, 'toggle', { key: 'info:one', version: shown });
			const before = stored(w);
			// the old page (version none, then the tick's version) tries to tick again: both are stale
			for (const version of ['none', shown]) {
				const r = await post(w, info, 'toggle', { key: 'info:one', done: 'true', version });
				expect(r).toMatchObject({ status: 409, data: { key: 'info:one', done: true } });
				expect(r.data.message).toMatch(/changed by someone else/);
			}
			expect(stored(w)).toBe(before);
			expect(await doneOf(w)).toMatchObject({ 'info:one': false });
		} finally { w.db.close(); }
	});

	it('a tick with no version is refused as changed, never run against the row as it is now', async () => {
		const w = world();
		try {
			expect(await post(w, info, 'toggle', { key: 'info:one', done: 'true' })).toMatchObject({ status: 409 });
			expect(await doneOf(w)).toMatchObject({ 'info:one': false });
		} finally { w.db.close(); }
	});

	it('two posts with one operationId are one write', async () => {
		const w = world();
		try {
			const form = { key: 'info:one', done: 'true', version: 'none', operationId: 'aaaaaaaa-0000-1111-2222-333333333333' };
			expect(await post(w, info, 'toggle', form)).toMatchObject({ saved: 'info:one' });
			expect(await post(w, info, 'toggle', form)).toMatchObject({ saved: 'info:one' });
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_operation').get()).toEqual({ n: 1 });
		} finally { w.db.close(); }
	});

	it('a tick whose audit failed answers 503; the same operation id replayed once the audit is back records the audit', async () => {
		const w = world();
		try {
			const form = { key: 'info:one', done: 'true', version: 'none', operationId: 'bbbbbbbb-0000-1111-2222-333333333333' };
			w.audit.state.down = true;
			expect(await post(w, info, 'toggle', form)).toMatchObject({ status: 503 });
			expect(w.audit.events.size).toBe(0);
			w.audit.state.down = false;
			expect(await post(w, info, 'toggle', form)).toMatchObject({ saved: 'info:one', done: true });
			expect(w.audit.events.size).toBe(1);
			expect(w.db.prepare('SELECT count(*) AS total, count(audited_at) AS audited FROM uw_operation').get()).toEqual({ total: 1, audited: 1 });
			expect(w.db.prepare('SELECT count(*) AS n FROM uw_register_row').get()).toEqual({ n: 1 });
		} finally { w.db.close(); }
	});
});
