// Ticket 04: one synthetic case imported through the real local service, for the pure/merge equivalence tests of the
// nine mixed loaders. Every value is invented. Each test file calls `bootCase` once in beforeAll and `stop` in afterAll.
import path from 'node:path';
import { buildCase, type SynthOptions } from '../e2e/pilot/lib/fixtures';
import type { LocalCase } from '../../src/lib/local-case/service.server';
import { cleanup, tempRoot } from '../../src/lib/local-case/test-support';
import { viewContentOf } from '../../src/lib/local-case/results.server';

export type J = Record<string, any>;
type Loader = { load: (e: unknown) => Promise<unknown> };

export interface Booted {
	lc: LocalCase;
	rv: string;
	caseId: string;
	/** the pure functions' input: the local store, the version and its view-content reader */
	input: () => { store: LocalCase['store']; vid: string; vc: ReturnType<typeof viewContentOf> };
	/** a route module's `load`, with the real `[vid]` layout as `parent()` */
	load: (route: unknown, query?: string) => Promise<J>;
	stop: () => Promise<void>;
}

export async function bootCase(tag: string, edit?: SynthOptions['edit']): Promise<Booted> {
	const env = { ...process.env };
	const root = await tempRoot(tag);
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000' });
	const { app } = await import('../../src/lib/local-case/app.server');
	const lc = app();
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	await lc.startup();
	const c = await buildCase(path.join(root, 'case'), { caseId: `case-${tag}`, edit });
	const imp = await lc.importPackage(c.caseDir, c.pkgDir);
	if (imp.kind !== 'stored') throw new Error(`import ${imp.kind}`);
	const rv = c.resultsVersion;
	const caseId = lc.store.getVersion(rv)!.case_id;
	const layout = (await import('../../src/routes/v/[vid]/+layout.server')) as unknown as { load: (e: unknown) => J };
	const parentData = () => layout.load({ params: { vid: rv } });
	return {
		lc, rv, caseId,
		input: () => ({ store: lc.store, vid: rv, vc: viewContentOf(lc.store, rv) }),
		load: async (route, query = '') =>
			(await (route as Loader).load({ params: { vid: rv }, url: new URL(`http://127.0.0.1/v/${rv}/view${query}`), parent: async () => parentData() })) as J,
		stop: async () => {
			const g = globalThis as { __clearcase?: { app: LocalCase } };
			g.__clearcase?.app.shutdown();
			delete g.__clearcase;
			process.env = env;
			await cleanup(root);
		},
	};
}
