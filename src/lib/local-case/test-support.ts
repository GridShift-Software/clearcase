// Test support for the local-case unit tests: a LocalCase on a disposable data directory, and synthetic cases built
// through GRS-10's converter (tests/e2e/pilot/lib/fixtures.ts). Never imported by the app.
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { configFromEnv } from './config.server.ts';
import { isBusy, type Storage } from './db.server.ts';
import { LocalCase, type AckInput } from './service.server.ts';

export async function tempRoot(tag: string): Promise<string> {
	return mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), `cc-lc-${tag}-`));
}

export function service(dataDir: string, env: Record<string, string> = {}): LocalCase {
	const lc = new LocalCase(configFromEnv({ CLEARCASE_DATA_DIR: dataDir, PORT: '1', CLEARCASE_USERWORK_BACKUP_DELAY_MS: '60000', ...env }));
	const lock = lc.storage.acquireInstanceLock();
	if (!lock.ok) throw new Error(lock.reason);
	return lc;
}

export const cleanup = (dir: string) => rm(dir, { recursive: true, force: true });

/** The connection's busy_timeout in ms: how long SQLite waits inside one BEGIN IMMEDIATE on a locked store. */
export const busyTimeout = (storage: Storage) => Number(Object.values(storage.db().prepare('PRAGMA busy_timeout').get() as Record<string, unknown>)[0]);

/**
 * For a test that holds work.sqlite's write lock through every attempt and expects tx()'s refusal: SQLite's wait inside
 * each attempt drops from the production 2,000 ms to 0, so the refusal comes after about 1.5 s instead of 9.5 s. The
 * held lock, SQLITE_BUSY, tx()'s four attempts with their 250, 500 and 750 ms backoff and the 503 all stay real.
 * busy.test.ts runs the production wait end to end. Returns the restore; call it before the test's next write.
 */
export function withoutBusyWait(storage: Storage): () => void {
	const prev = busyTimeout(storage);
	storage.db().exec('PRAGMA busy_timeout=0');
	return () => storage.db().exec(`PRAGMA busy_timeout=${prev}`);
}

/** The acknowledgement an operator gives on the report page of a stored import: every warning new for the case. */
export function ackFor(lc: LocalCase, importId: number): AckInput {
	const imp = lc.store.getImport(importId)!;
	const r = JSON.parse(imp.report);
	const trusted = lc.trustedFor(r.caseId);
	return { resultsVersion: r.resultsVersion, manifestSha256: r.manifestSha256, diagnosticsSha256: r.diagnosticsSha256, validatorVersion: r.validatorVersion, warningFingerprints: r.warningFingerprints.filter((f: string) => !trusted.has(f)) };
}

/**
 * A checkout-wide lock for a test file that runs SvelteKit in a Vite dev server in its own process (ssr-pages.test.ts,
 * court-save-limit.test.ts). Two such servers starting at once in one checkout share .svelte-kit/ and Vite's dependency
 * cache: one rewrites generated types the other is reading (ENOENT under .svelte-kit/types), or re-optimizes
 * dependencies, which re-runs the other's server init (EADDRINUSE on its originals port). Waits, without blocking the
 * event loop, until no other file holds it; the kernel releases it if the holder dies. Returns the release.
 */
export async function devServerLock(root: string): Promise<() => void> {
	const d = new DatabaseSync(path.join(root, 'node_modules', '.clearcase-dev-server.lock'));
	d.exec('PRAGMA busy_timeout=0');
	for (;;) {
		try {
			d.exec('BEGIN EXCLUSIVE');
			return () => { d.exec('ROLLBACK'); d.close(); };
		} catch (e) {
			if (!isBusy(e)) { d.close(); throw e; }
			await new Promise((r) => setTimeout(r, 100));
		}
	}
}
