// A stand-in gate leader for gate.test.ts: spins until the shared start time, tries gate.mjs's real admission against
// <pid file>, prints ADMITTED or the refusal, and an admitted one holds its claim for <hold ms> before releasing it.
import { admit } from '../../scripts/gate.mjs';
import { removePidFile } from '../../scripts/pidfile.ts';

const [pidFile, startAt, hold] = process.argv.slice(2);
while (Date.now() < Number(startAt));
const refused = admit(pidFile);
console.log(refused ?? 'ADMITTED');
if (!refused) {
	await new Promise((r) => setTimeout(r, Number(hold)));
	removePidFile(pidFile);
}
