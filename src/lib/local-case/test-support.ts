// Test support for the local-case unit tests: a LocalCase on a disposable data directory, and synthetic cases built
// through GRS-10's converter (tests/e2e/pilot/lib/fixtures.ts). Never imported by the app.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configFromEnv } from './config.server.ts';
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

/** The acknowledgement an operator gives on the report page of a stored import: every warning new for the case. */
export function ackFor(lc: LocalCase, importId: number): AckInput {
	const imp = lc.store.getImport(importId)!;
	const r = JSON.parse(imp.report);
	const trusted = lc.trustedFor(r.caseId);
	return { resultsVersion: r.resultsVersion, manifestSha256: r.manifestSha256, diagnosticsSha256: r.diagnosticsSha256, validatorVersion: r.validatorVersion, warningFingerprints: r.warningFingerprints.filter((f: string) => !trusted.has(f)) };
}
