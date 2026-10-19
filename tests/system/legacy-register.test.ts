// GRS-56: the v5 importers are registered whatever happened at start-up. A storage error at start-up used to return
// from hooks.server.ts's init before registerV5Importers(), and nothing registered them later, so a v5 restore after
// the store recovered found no importer for the court bundles and imported nothing.
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures.ts';
import type { LocalCase } from '../../src/lib/local-case/service.server.ts';
import { ackFor, cleanup, service, tempRoot } from '../../src/lib/local-case/test-support.ts';

// hooks.server.ts runs outside SvelteKit here: no build flag, and initApp (instance lock, listeners) is not under test
vi.mock('$app/env', () => ({ building: false }));
vi.mock('$lib/local-case/app.server', async (orig) => ({ ...(await orig<typeof import('$lib/local-case/app.server')>()), initApp: async () => {} }));

const g = globalThis as { __clearcase?: unknown };
const KEY = 'ess_dcs_custom_bundles_v1';
let root: string, lc: LocalCase, caseId: string, rv: string, vid: string;
afterAll(async () => { try { lc?.shutdown(); } catch { /* closed */ } if (root) await cleanup(root); });

beforeAll(async () => {
	root = await tempRoot('legacy-register');
	lc = service(path.join(root, 'data'));
	await lc.startup();
	const built = await buildCase(path.join(root, 'case'), { caseId: 'legacy-register' });
	const i = await lc.importPackage(built.caseDir, built.pkgDir);
	expect(await lc.activate(built.resultsVersion, ackFor(lc, i.importId!))).toBeNull();
	caseId = 'legacy-register'; rv = built.resultsVersion; vid = rv;
	g.__clearcase = { app: lc, originals: null, id: caseId, startedAt: '', build: null };
}, 120_000);

const file = () => {
	const form = new FormData();
	form.set('confirm', 'yes');
	form.set('file', new File([JSON.stringify({ [KEY]: JSON.stringify([{ no: 'C1', name: 'Hearing bundle', rows: [] }]) })], 'ess_dcs_backup.json'));
	return new Request('http://127.0.0.1/', { method: 'POST', body: form });
};

describe('v5 importers after a start-up storage error', () => {
	it('start-up registers them even when storage failed, and a restore after recovery imports the court bundles', async () => {
		vi.resetModules();
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		lc.storageError = 'start-up check failed';
		try {
			const hooks = await import('../../src/hooks.server.ts');
			await hooks.init();
			const { legacyImporters } = await import('../../src/lib/user-work/backup/legacy.server.ts');
			expect(legacyImporters().map((x) => x.id)).toContain('v5-custom-bundles');
		} finally { lc.storageError = null; err.mockRestore(); }
	});

	it('the backup page registers them on first use, so a restore finds an importer without any start-up registration', async () => {
		vi.resetModules();
		const { legacyImporters } = await import('../../src/lib/user-work/backup/legacy.server.ts');
		expect(legacyImporters()).toEqual([]);
		const { actions } = await import('../../src/lib/views/system/backup.server.ts');
		const out = (await actions.restore({ params: { vid }, request: file() })) as { legacy?: { changed: boolean; rows: number; keys: { status: string }[] } };
		expect(out.legacy).toMatchObject({ changed: true, rows: 1, keys: [{ status: 'imported' }] });
		const { readCustom } = await import('../../src/lib/views/bundles/store.server.ts');
		expect((await readCustom(caseId)).map((c) => c.id)).toEqual(['v5-C1']);
	});
});
