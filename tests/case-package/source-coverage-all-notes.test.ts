// PR #76 review, GRS-24 F1: the validation report's Source coverage section reaches every note the converter recorded,
// including the 101st of one code. Synthetic case only; every value is invented.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import path from 'node:path';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { cleanup, tempRoot } from '../../src/lib/local-case/test-support';
import ImportPage from '../../src/routes/import/[id]/+page.svelte';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

type J = Record<string, any>;
const NOTES = 101;
const name = (i: number) => `invented${String(i).padStart(3, '0')}`;
let root: string, lc: LocalCase, importId: number;
const env = { ...process.env };

beforeAll(async () => {
	root = await tempRoot('coverage-all-notes');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const many = await buildCase(path.join(root, 'many'), {
		caseId: 'coverage-many',
		edit: (r) => { for (let i = 0; i < NOTES; i++) (r.DATA as J)[name(i)] = { a: i }; },
	});
	const imp = await lc.importPackage(many.caseDir, many.pkgDir);
	expect(imp.kind).toBe('stored');
	importId = imp.importId;
}, 180_000);
afterAll(async () => {
	const g = globalThis as { __clearcase?: { app: LocalCase } };
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = env;
	if (root) await cleanup(root);
});

type Loader = { load: (e: unknown) => Promise<unknown> };
const importLoad = async () =>
	(await ((await import('../../src/routes/import/[id]/+page.server')) as Loader).load({ params: { id: String(importId) }, url: new URL(`http://127.0.0.1/import/${importId}`) })) as J;

describe('source coverage with more than 100 notes of one code', () => {
	it('lists all 101 unmapped-key notes, so the 101st is reachable, and states the converter\'s total', async () => {
		const d = await importLoad();
		const group = d.sourceCoverage.groups.find((g: J) => g.code === 'V5_UNMAPPED_KEY');
		expect(group.total).toBe(NOTES);
		expect(group.items).toHaveLength(NOTES);
		const body = render(ImportPage, { props: { data: d, form: null } as never }).body;
		const at = body.indexOf('id="source-coverage"');
		const section = body.slice(at, body.indexOf('</section>', at));
		expect(section).toContain(`V5_UNMAPPED_KEY (${NOTES})`);
		for (let i = 0; i < NOTES; i++) expect(section).toContain(`DATA.${name(i)}`);
	});
});
