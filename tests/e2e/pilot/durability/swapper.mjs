#!/usr/bin/env bun
// Race helper for durability.mjs S31: flips <target> between a regular file (a fresh copy of <regularSrc>) and a
// symlink to <linkTarget> as fast as it can, each state installed by an atomic rename(2), until SIGTERM. A reader
// that checks the path and then opens it again can be redirected through the link; one that opens once and judges
// the descriptor cannot. Prints the number of flips on exit.
import { copyFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';

const [target, regularSrc, linkTarget] = process.argv.slice(2);
if (!target || !regularSrc || !linkTarget) { console.error('usage: swapper.mjs <target> <regularSrc> <linkTarget>'); process.exit(2); }
const tmpFile = `${target}.swap-file`, tmpLink = `${target}.swap-link`;
let flips = 0, stop = false;
process.on('SIGTERM', () => { stop = true; });
const tick = () => new Promise((r) => setImmediate(r));
while (!stop) {
	try {
		copyFileSync(regularSrc, tmpFile);
		renameSync(tmpFile, target);
		flips++;
		rmSync(tmpLink, { force: true });
		symlinkSync(linkTarget, tmpLink);
		renameSync(tmpLink, target);
		flips++;
	} catch { /* the test may be restoring the path; keep going */ }
	if (flips % 64 === 0) await tick(); // let SIGTERM in
}
// leave a regular file behind
try { copyFileSync(regularSrc, tmpFile); renameSync(tmpFile, target); } catch {}
rmSync(tmpLink, { force: true });
rmSync(tmpFile, { force: true });
console.log(JSON.stringify({ flips }));
process.exit(0);
