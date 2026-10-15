import { existsSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { initApp } from './app.server.ts';
import { cleanup, service, tempRoot } from './test-support.ts';

const saved = { ...process.env };
const freePort = () => new Promise<number>((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
let root = '';
afterEach(async () => {
	const g = globalThis as { __clearcase?: { app: { shutdown(): void }; originals: { close(): void } } };
	g.__clearcase?.originals.close();
	g.__clearcase?.app.shutdown();
	delete g.__clearcase;
	process.env = { ...saved };
	vi.restoreAllMocks();
	if (root) await cleanup(root);
});

it('an invalid CLEARCASE_FIXED_NOW exits at boot with a FATAL message, before the data directory is touched', async () => {
	root = await tempRoot('fixednow');
	const data = path.join(root, 'data');
	Object.assign(process.env, { CLEARCASE_DATA_DIR: data, PORT: '1', ORIGINALS_PORT: String(await freePort()), CLEARCASE_FIXED_NOW: 'tomorrow' });
	const exit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
	const err = vi.spyOn(console, 'error').mockImplementation(() => {});
	await expect(initApp()).rejects.toThrow('exit 1');
	expect(exit).toHaveBeenCalledWith(1);
	expect(String(err.mock.calls[0]?.[0])).toMatch(/^FATAL: CLEARCASE_FIXED_NOW must be an ISO-8601 date/);
	expect((globalThis as { __clearcase?: unknown }).__clearcase).toBeUndefined();
	expect(existsSync(data)).toBe(false);
});

it('a second instance refused by the instance lock leaves link-key alone: no chmod (ctime) and no new key when it is missing', async () => {
	root = await tempRoot('second');
	const data = path.join(root, 'data');
	const first = service(data);
	try {
		const { LinkCapability } = await import('./originals.server.ts');
		new LinkCapability(data);
		const key = path.join(data, 'link-key');
		const before = statSync(key);
		Object.assign(process.env, { CLEARCASE_DATA_DIR: data, PORT: '1', ORIGINALS_PORT: String(await freePort()) });
		vi.spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		await new Promise((r) => setTimeout(r, 20));
		await expect(initApp()).rejects.toThrow('exit 1');
		expect(String(err.mock.calls[0]?.[0])).toMatch(/^FATAL: another ClearCase process/);
		expect(statSync(key).ctimeMs).toBe(before.ctimeMs);
		rmSync(key);
		delete (globalThis as { __clearcase?: unknown }).__clearcase;
		await expect(initApp()).rejects.toThrow('exit 1');
		expect(existsSync(key)).toBe(false);
	} finally { first.shutdown(); }
});

it('two concurrent first calls to initApp share one start-up: one instance, one originals listener, every call resolves', async () => {
	root = await tempRoot('concurrent');
	const originalsPort = await freePort();
	Object.assign(process.env, { CLEARCASE_DATA_DIR: path.join(root, 'data'), PORT: '1', ORIGINALS_PORT: String(originalsPort) });
	await Promise.all([initApp(), initApp()]);
	const g = globalThis as { __clearcase?: { id: string } };
	const id = g.__clearcase?.id;
	expect(id).toBeDefined();
	await initApp();
	expect(g.__clearcase?.id).toBe(id);
	const r = await fetch(`http://127.0.0.1:${originalsPort}/`);
	expect([r.status, await r.text()]).toEqual([421, 'misdirected request: unknown Host']);
});
