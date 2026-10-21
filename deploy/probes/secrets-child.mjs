// The child's half of deploy/probes/secrets.ts (GRS-107): read the values the reader wrote to the pipe on fd 3, once,
// and close it, so no process this child starts afterwards can read them there.
import { closeSync, readFileSync } from 'node:fs';

/** @returns {Map<string, string>} */
export function takeSecrets() {
	const fd = Number(process.env.CLEARCASE_SECRETS_FD);
	if (!Number.isInteger(fd) || fd < 3) throw new Error('secrets: CLEARCASE_SECRETS_FD is not set; run this under deploy/probes/secrets.ts');
	delete process.env.CLEARCASE_SECRETS_FD;
	const text = readFileSync(fd, 'utf8');
	closeSync(fd);
	return new Map(text.split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
}
