// `probe.ts --check` must refuse every mutation of a real PASS summary (GRS-106 fix round). From this directory:
//
//   bun run --bun test:check
//
// It takes the committed evidence summary, points its SHAs at HEAD so the control passes, then mutates every leaf and
// every container one at a time (delete, null, retype, empty string, flipped boolean, zeroed number, an unknown key
// added to every object) and runs the real `--check` CLI on each file. Any mutation that prints CHECK PASS is a hole.
// The walk is over the summary itself, not over the checker's own field list, so a field the checker forgets cannot
// hide from it. A few named cases (the review's ten) run on top, so a regression names what it let through.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const HERE = import.meta.dirname;
const EVIDENCE = path.join(HERE, '../../../docs/acceptance/hosting/evidence/runtime-summary.json');
type Json = Record<string, unknown>;

const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: HERE, encoding: 'utf8' }).stdout.trim();
const original = JSON.parse(readFileSync(EVIDENCE, 'utf8')) as Json;
const base = structuredClone(original);
base.sourceSha = head;
base.servedStamp = head;

const dir = mkdtempSync(path.join(tmpdir(), 'runtime-check-'));
let n = 0;
function check(summary: unknown): Promise<{ pass: boolean; out: string }> {
	const file = path.join(dir, `m${n++}.json`);
	writeFileSync(file, JSON.stringify(summary));
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['probe.ts', '--check', file], { cwd: HERE, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		child.stdout.on('data', (b: Buffer) => (out += b));
		child.stderr.on('data', (b: Buffer) => (out += b));
		child.on('close', (code) => resolve({ pass: code === 0 && out.includes('CHECK PASS'), out: out.trim() }));
	});
}

type Edit = (summary: Json) => void;
const at = (summary: Json, p: (string | number)[]) => p.slice(0, -1).reduce<any>((o, k) => o[k], summary);
const mutations: [string, Edit][] = [];

function walk(value: unknown, p: (string | number)[]) {
	const label = p.join('.') || '<root>';
	if (p.length) {
		const key = p.at(-1)!;
		mutations.push([`${label} deleted`, (s) => (Array.isArray(at(s, p)) ? at(s, p).splice(key as number, 1) : delete at(s, p)[key])]);
		if (value !== null) mutations.push([`${label} null`, (s) => (at(s, p)[key] = null)]);
		mutations.push([`${label} retyped`, (s) => (at(s, p)[key] = typeof value === 'string' ? 1 : typeof value === 'object' && value !== null ? 'x' : String(value))]);
		if (typeof value === 'string') mutations.push([`${label} emptied`, (s) => (at(s, p)[key] = '')]);
		if (typeof value === 'boolean') mutations.push([`${label} flipped`, (s) => (at(s, p)[key] = !value)]);
		if (typeof value === 'number') mutations.push([`${label} zeroed`, (s) => (at(s, p)[key] = 0)]);
	}
	if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...p, i]));
	else if (typeof value === 'object' && value !== null) {
		mutations.push([`${label} + unknown key`, (s) => ((p.reduce<any>((o, k) => o[k], s) as Json).__unknown = 1)]);
		for (const [k, v] of Object.entries(value)) walk(v, [...p, k]);
	}
}
walk(base, []);

const named: [string, Edit][] = [
	['hold deleted', (s) => delete s.hold],
	['isolation deleted', (s) => delete s.isolation],
	['CLOUDFLARE_API_TOKEN added to isolation.env', (s) => (s.isolation as { env: string[] }).env.push('CLOUDFLARE_API_TOKEN')],
	['hosts.wrangler = "Bun 1.4.2"', (s) => ((s.hosts as Json).wrangler = 'Bun 1.4.2')],
	['hosts.app null', (s) => ((s.hosts as Json).app = null)],
	['checker deleted', (s) => delete s.checker],
	['checker.accepted set', (s) => ((s.checker as Json).accepted = 'schema deleted')],
	['checker.mutationsRefused zero', (s) => ((s.checker as Json).mutationsRefused = 0)],
	['commands null', (s) => ((s.legs as Record<string, Json>).build!.commands = null)],
	['failure string on a PASS leg', (s) => ((s.legs as Record<string, Json>).request!.failure = 'assertion failed: x')],
	['hosts.workerd = "Node 26"', (s) => ((s.hosts as Json).workerd = 'Node 26')],
	['hosts.node differs from hosts.wrangler', (s) => ((s.hosts as Json).node = '24.0.0')],
	['hold entry changed', (s) => ((s.hold as string[])[0] = 'workers.dev smoke deploy done')],
	['unknown top-level key', (s) => (s.extra = true)],
	['absolute runDir', (s) => (s.runDir = '/home/someone/run')],
];

const control = await check(base);
const results: string[] = [];
if (!control.pass) results.push(`control: the unmutated PASS summary is refused:\n${control.out}`);
const all = [...mutations, ...named];
const queue = [...all];
let accepted = 0;
await Promise.all(
	Array.from({ length: 8 }, async () => {
		for (let m = queue.shift(); m; m = queue.shift()) {
			const copy = structuredClone(base);
			m[1](copy);
			if (JSON.stringify(copy) === JSON.stringify(base)) continue; // not a mutation
			if ((await check(copy)).pass) (accepted++, results.push(`ACCEPTED: ${m[0]}`));
		}
	}),
);
rmSync(dir, { recursive: true, force: true });
console.log(results.sort().join('\n'));
console.log(accepted || !control.pass ? `MUTATION CHECK FAIL: ${accepted} of ${all.length} mutations accepted` : `MUTATION CHECK PASS: ${all.length} mutations refused`);
process.exit(accepted || !control.pass ? 1 : 0);
