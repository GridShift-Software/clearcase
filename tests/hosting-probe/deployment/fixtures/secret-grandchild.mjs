// A grandchild of the secrets reader (GRS-107 secrets.test.ts): prints the sha256 of every environment value it got and
// what each of its open file descriptors is, never a value.
import { createHash } from 'node:crypto';
import { readdirSync, readlinkSync } from 'node:fs';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const fds = readdirSync('/proc/self/fd').flatMap((fd) => {
	try {
		return [readlinkSync(`/proc/self/fd/${fd}`)];
	} catch {
		return [];
	}
});
console.log(JSON.stringify({ keys: Object.keys(process.env), hashes: Object.values(process.env).map(sha), fds }));
