import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFixedNow } from '../components/clock.ts';
import { configFromEnv } from './config.server.ts';
import { OriginalsServer } from './originals.server.ts';
import { LocalCase } from './service.server.ts';

type Instance = { app: LocalCase; originals: OriginalsServer; id: string; startedAt: string; build: Record<string, unknown> | null };
const g = globalThis as { __clearcase?: Instance };

function create(): Instance {
	const app = new LocalCase(configFromEnv());
	let build: Record<string, unknown> | null = null;
	try { build = JSON.parse(readFileSync(path.join(process.env.CLEARCASE_BUILD_DIR ?? 'build', 'clearcase-build.json'), 'utf8')); } catch {}
	let originals: OriginalsServer | null = null;
	return { app, get originals() { return (originals ??= new OriginalsServer(app)); }, id: randomUUID(), startedAt: new Date().toISOString(), build };
}

export const instance = (): Instance => (g.__clearcase ??= create());
export const app = (): LocalCase => instance().app;
export const originals = (): OriginalsServer => instance().originals;

export async function initApp(): Promise<void> {
	try { parseFixedNow(process.env.CLEARCASE_FIXED_NOW); } catch (e) {
		console.error(`FATAL: ${(e as Error).message}. Unset it to use the real clock. Exiting without touching the data directory.`);
		process.exit(1);
	}
	const a = app();
	const lock = a.storage.acquireInstanceLock();
	if (!lock.ok) {
		console.error(`FATAL: ${lock.reason}. This instance exits without touching the data directory.`);
		process.exit(1);
	}
	const o = originals();
	try {
		await o.start();
	} catch (e) {
		console.error(`FATAL: the originals listener cannot bind 127.0.0.1:${a.config.originalsPort} (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}). Is another program using that port? Exiting.`);
		a.storage.releaseInstanceLock();
		process.exit(1);
	}
	await a.startup();
	process.once('sveltekit:shutdown' as never, (reason: unknown) => {
		console.log(`sveltekit:shutdown (${String(reason)}): closing the originals listener and storage`);
		o.close();
		a.shutdown();
		console.log('storage closed cleanly');
	});
}

export const stateStamp = () => `${instance().id}:${instance().app.storage.writes}`;
