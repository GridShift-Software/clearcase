// Process start with an invalid CLEARCASE_FIXED_NOW: a configuration error, refused before anything is opened, with
// one FATAL line and exit code 1 (like a taken originals port), never an unhandled rejection from the startup checks.
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { initApp } from './app.server.ts';
import { cleanup, tempRoot } from './test-support.ts';

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
