#!/usr/bin/env bun
// Race helper for durability.mjs LARGE-MUTATE: waits until a serve-time snapshot appears in <serveTmpDir> and has
// grown to at least <minBytes>, then overwrites <len> bytes at <offset> of <file> in place (same inode, same size)
// and prints one JSON line describing what it saw. Gives up after <timeoutMs>. Prints "ready" once polling.
import { closeSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const [dir, file, offset, len, minBytes, timeoutMs] = process.argv.slice(2);
const t0 = performance.now();
console.log('ready');
const tick = () => new Promise((r) => setImmediate(r));
for (;;) {
	let seen = null;
	try {
		for (const n of readdirSync(dir)) {
			const sz = statSync(join(dir, n)).size;
			if (sz >= Number(minBytes)) { seen = { name: n, size: sz }; break; }
		}
	} catch { /* serve-tmp not created yet */ }
	if (seen) {
		const fd = openSync(file, 'r+');
		const b = Buffer.alloc(Number(len), 0xa5);
		writeSync(fd, b, 0, b.length, Number(offset));
		closeSync(fd);
		console.log(JSON.stringify({ patched: true, snapshotSizeAtPatch: seen.size, ms: Math.round(performance.now() - t0) }));
		process.exit(0);
	}
	if (performance.now() - t0 > Number(timeoutMs)) { console.log(JSON.stringify({ patched: false, reason: 'no snapshot seen' })); process.exit(0); }
	await tick();
}
