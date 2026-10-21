// `bun run --bun probe`: starts probe.ts under GRS-107's reader (GRS-108). The reader hands keys to a real Node child
// only, through a preload that takes them off fd 3 before the child's code runs, so the runner is Node. This launcher, on
// Bun, finds that Node past `bun run --bun`'s stand-in and names its own Bun (PROBE_BUN) for the runner's build step.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { HERE, realNode, Refusal } from './harness.ts';

const KEYS = 'CLIENT_A_PK,CLIENT_A_SK,STAFF_PK,STAFF_SK';
let node: { path: string };
try {
	node = realNode();
} catch (e) {
	if (!(e instanceof Refusal)) throw e;
	console.error(`probe refused: ${e.message}`);
	process.exit(2);
}
const reader = path.join(HERE, '../../../deploy/probes/secrets.ts');
const r = spawnSync(process.execPath, [reader, 'run', 'clerk-dev', '--keys', KEYS, '--', node.path, path.join(HERE, 'probe.ts'), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, PROBE_BUN: process.execPath } });
process.exit(r.status ?? 1);
