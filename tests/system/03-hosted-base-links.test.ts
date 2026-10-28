// Ticket 03 review M1: the overview's "Go to" links and the Quantum page's charging-calculation link follow the route
// base, so the same page components keep hosted readers under /cases/<caseId>/v/... instead of sending them to /v/....
import path from 'node:path';
import { render } from 'svelte/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildCase } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { cleanup, tempRoot } from '../../src/lib/local-case/test-support';
import OverviewPage from '../../src/routes/v/[vid]/overview/+page.svelte';
import QuantumPage from '../../src/routes/v/[vid]/quantum/quantum_tab/+page.svelte';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve(), invalidateAll: () => Promise.resolve() }));
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy() {} }) }));

type J = Record<string, any>;
type Loader = { load: (e: unknown) => Promise<unknown> };
const HOSTED = '/cases/c1/v';
let root: string, lc: LocalCase, rv: string, caseId: string;
const env = { ...process.env };

beforeAll(async () => {
	root = await tempRoot('hosted-base-links');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const c = await buildCase(path.join(root, 'case'), { caseId: 'hosted-links' });
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	expect(imp.kind).toBe('stored');
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

const version = () => ({ id: rv, caseId, titleName: 'Invented case', caseName: 'Invented case' });
const loaders: Record<string, () => Promise<unknown>> = {
	overview: () => import('../../src/routes/v/[vid]/overview/+page.server'),
	'quantum/quantum_tab': () => import('../../src/routes/v/[vid]/quantum/quantum_tab/+page.server'),
};
async function page(route: string, Page: never, base: string) {
	const mod = (await loaders[route]()) as Loader;
	const data = (await mod.load({ params: { vid: rv }, url: new URL(`http://127.0.0.1/v/${rv}/${route}`), parent: async () => ({ version: version(), base }) })) as J;
	return render(Page, { props: { data: { ...data, version: version(), base }, form: null } as never }).body;
}
const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replaceAll('&amp;', '&'));

describe('page links follow the route base', () => {
	it.each([
		['overview', OverviewPage, '/chronology'],
		['quantum/quantum_tab', QuantumPage, '/chronology?'],
	] as const)('%s keeps every case link under a hosted base', async (route, Page, expected) => {
		const local = hrefs(await page(route, Page as never, '/v'));
		const hosted = hrefs(await page(route, Page as never, HOSTED));
		const enc = encodeURIComponent(rv);
		expect(local.some((h) => h.startsWith(`/v/${enc}${expected}`)), `local ${route} links to ${expected}`).toBe(true);
		expect(hosted.some((h) => h.startsWith(`${HOSTED}/${enc}${expected}`)), `hosted ${route} links to ${expected}`).toBe(true);
		expect(hosted.filter((h) => h.startsWith('/v/')), `hosted ${route} links that leave the base`).toEqual([]);
	});
});
