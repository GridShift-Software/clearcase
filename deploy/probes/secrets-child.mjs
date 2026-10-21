// The child's half of deploy/probes/secrets.ts (GRS-107). The reader's preload (secrets-fd.mjs, or secrets-env.mjs under
// --to env) reads the values the reader wrote to the pipe on fd 3 and closes it before the child's code runs, so no
// process this child starts can read them there. takeSecrets() hands the child those values, once.
import { closeSync, readFileSync } from 'node:fs';

const KEPT = Symbol.for('clearcase.secrets.kept');

/** Reads the values off the pipe named by CLEARCASE_SECRETS_FD, closes it and removes the variable. */
function readAndClose() {
	const fd = Number(process.env.CLEARCASE_SECRETS_FD);
	if (!Number.isInteger(fd) || fd < 3) throw new Error('secrets: CLEARCASE_SECRETS_FD is not set; run this under deploy/probes/secrets.ts');
	delete process.env.CLEARCASE_SECRETS_FD;
	const text = readFileSync(fd, 'utf8');
	closeSync(fd);
	return new Map(text.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}

/** For the reader's preload: take the values off fd 3 now and keep them for takeSecrets(). */
export function keepSecrets() {
	globalThis[KEPT] = readAndClose();
}

/** @returns {Map<string, string>} the values, once: the preload's, or read off fd 3 here when no preload ran. */
export function takeSecrets() {
	const kept = globalThis[KEPT];
	if (!kept) return readAndClose();
	delete globalThis[KEPT];
	return kept;
}
