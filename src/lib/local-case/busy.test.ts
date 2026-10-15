import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isHttpError } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalCase } from './service.server.ts';
import { busyTimeout, cleanup, service, tempRoot, withoutBusyWait } from './test-support.ts';

let root: string, lc: LocalCase;
beforeAll(async () => {
	root = await tempRoot('busy');
	lc = service(path.join(root, 'data'));
	await lc.startup();
	lc.storage.db().exec('CREATE TABLE IF NOT EXISTS work.busy_probe(n INTEGER)');
});
afterAll(async () => {
	lc?.shutdown();
	if (root) await cleanup(root);
});

async function refusedWrite() {
	const l = new DatabaseSync(lc.storage.workFile);
	l.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
	const at = performance.now();
	try {
		await lc.storage.tx((d) => d.exec('INSERT INTO work.busy_probe VALUES (1)'));
		return { status: 200, message: '', ms: performance.now() - at };
	} catch (e) {
		if (!isHttpError(e)) throw e;
		return { status: e.status, message: e.body.message, ms: performance.now() - at };
	} finally {
		l.exec('ROLLBACK');
		l.close();
	}
}
const rows = () => (lc.storage.db().prepare('SELECT count(*) AS n FROM work.busy_probe').get() as { n: number }).n;

describe('Storage.tx() on a store locked by another process', () => {
	it('waits the production budget, 4 × 2,000 ms plus 1,500 ms of backoff, then refuses with 503 and writes nothing', async () => {
		expect(busyTimeout(lc.storage)).toBe(2000);
		const r = await refusedWrite();
		expect(r).toMatchObject({ status: 503, message: 'The ClearCase store is locked by another process; nothing was written. Try again in a moment.' });
		expect(r.ms).toBeGreaterThanOrEqual(9_400);
		expect(rows()).toBe(0);
	}, 30_000);

	it('withoutBusyWait keeps the four attempts and their backoff, skips only the wait inside each, and restores it', async () => {
		const restore = withoutBusyWait(lc.storage);
		expect(busyTimeout(lc.storage)).toBe(0);
		const r = await refusedWrite();
		restore();
		expect(busyTimeout(lc.storage)).toBe(2000);
		expect(r.status).toBe(503);
		expect(r.ms).toBeGreaterThanOrEqual(1_450);
		expect(r.ms).toBeLessThan(9_400);
		expect(rows()).toBe(0);
		await lc.storage.tx((d) => d.exec('INSERT INTO work.busy_probe VALUES (1)'));
		expect(rows()).toBe(1);
	}, 30_000);
});
