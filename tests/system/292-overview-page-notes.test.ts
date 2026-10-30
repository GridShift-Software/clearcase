// GRS-292: the overview's My notes tile says how many page notes the case keeps in its originals' viewer, apart from its
// notes on documents, so a case whose only note is a page note never reads as having none. The local pilot keeps no page
// notes and shows no such line. Synthetic case only.
import path from 'node:path';
import { render } from 'svelte/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { cleanup, tempRoot } from '../../src/lib/local-case/test-support';
import OverviewPage from '../../src/routes/v/[vid]/overview/+page.svelte';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), invalidateAll: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

type J = Record<string, any>;
let root: string, lc: LocalCase, rv: string, caseId: string;
const env = { ...process.env };

beforeAll(async () => {
	root = await tempRoot('overview-page-notes');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const c = await buildCase(path.join(root, 'case'), { caseId: 'overview-page-notes' });
	expect((await lc.importPackage(c.caseDir, c.pkgDir)).kind).toBe('stored');
	rv = c.resultsVersion;
	caseId = lc.store.getVersion(rv)!.case_id;
}, 180_000);
afterAll(async () => {
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});

async function tile(pageNotes: number | undefined) {
	const mod = (await import('../../src/routes/v/[vid]/overview/+page.server')) as { load: (e: unknown) => Promise<unknown> };
	const version = { id: rv, caseId, titleName: 'Invented case', caseName: 'Invented case' };
	const data = (await mod.load({ params: { vid: rv }, url: new URL(`http://127.0.0.1/v/${rv}/overview`), parent: async () => ({ version, base: '/v' }) })) as J;
	const notes = { ...data.notes, ...(pageNotes === undefined ? {} : { pageNotes }) };
	const html = render(OverviewPage as never, { props: { data: { ...data, notes, version, base: '/v' }, form: null } as never, context: new Map([['clearcase:base', () => '/v']]) }).body;
	return html.slice(html.indexOf('id="notes-total"'), html.indexOf('</p>', html.indexOf('id="notes-total"')));
}

it('292 a case whose only notes are page notes says so beside its zero document notes', async () => {
	const line = await tile(1);
	expect(line).toContain('0 notes for this case');
	expect(line).toContain('Also 1 page note written in the originals’ viewer, listed with your notes.');
	expect(await tile(3)).toContain('Also 3 page notes written in the originals’ viewer');
});

it('292 no page notes, hosted (0) or local (absent), adds nothing', async () => {
	for (const n of [0, undefined]) {
		const line = await tile(n);
		expect(line).toContain('0 notes for this case');
		expect(line).not.toContain('page note');
	}
});
