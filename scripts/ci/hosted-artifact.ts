// The emitted-artifact half of the hosted import boundary. The source guard (hosted-imports.ts) walks first-party
// modules and stops at the allowlisted framework packages; this scan reads what the build actually emitted for workerd
// (.svelte-kit/cloudflare and the server output it imports) and refuses any import of a filesystem, SQLite, process or
// network module, and any test double where the profile forbids one. Run by `build:hosted` after every hosted build.
//
//   bun scripts/ci/hosted-artifact.ts [--root DIR] --profile production|hosted-gate
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostedProfile } from './hosted-imports.ts';

const LOCAL_MODULES = '(?:node:)?(?:fs|fs/promises|sqlite|child_process|net|http|https|http2|cluster|worker_threads|dgram|tls|readline|repl|v8|vm)';
// import/export ... from, import(), require() and Node's getBuiltinModule naming a local-only module, or any bun: module
const IMPORT = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|^\\s*import\\s*)["'\`](${LOCAL_MODULES}|bun:[a-z]+|better-sqlite3)["'\`]`, 'gm');
// A process or Bun capability used outright. Workerd defines neither without nodejs_compat, so first-party code that reaches
// one fails there; the framework's own probes are all optional-chained (`globalThis.process?.cwd?.()`) or read `.versions`.
const CAPABILITY = /(?<![\w$.])(?:globalThis\.)?(?:(process)\.(?!versions\b)[A-Za-z_$]|(Bun)\.[A-Za-z_$])[\w$]*/g;
// Kit's own server runtime asks for node:fs through process.getBuiltinModule, guarded by globalThis.process, which
// workerd does not define without nodejs_compat (the Worker sets nodejs_als only); that one line is the framework's.
const FRAMEWORK = /globalThis\.process\?\.getBuiltinModule\?\.\("node:fs"\)/g;
// Test doubles: the memory doubles never ship; the hosted-gate doubles ship only in a hosted-gate artifact.
const MEMORY = ['memory-contract-diagnostic', 'createMemoryBackend'];
const GATE = 'clearcase-test-double:hosted-gate';
const ROOTS = ['.svelte-kit/cloudflare', '.svelte-kit/output/server'];

export function scanArtifact(a: { root: string; profile: HostedProfile }): { errors: string[]; files: number } {
	const errors: string[] = [];
	let files = 0, gate = false;
	for (const dir of ROOTS) {
		const base = path.join(a.root, dir);
		if (!existsSync(base)) {
			errors.push(`hosted-artifact: ${dir} is missing`);
			continue;
		}
		for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
			const file = path.join(entry.parentPath, entry.name), name = path.relative(a.root, file).replaceAll(path.sep, '/');
			const text = readFileSync(file, 'utf8').replace(FRAMEWORK, '');
			files++;
			for (const m of text.matchAll(CAPABILITY)) errors.push(`hosted-artifact: ${name}: uses ${m[0].replace(/^globalThis\./, '')}`);
			for (const m of text.matchAll(IMPORT)) errors.push(`hosted-artifact: ${name}: imports ${m[1]}`);
			for (const marker of MEMORY) if (text.includes(marker)) errors.push(`hosted-artifact: ${name}: contains the memory test double (${marker})`);
			if (text.includes(GATE)) {
				gate = true;
				if (a.profile === 'production') errors.push(`hosted-artifact: ${name}: contains the hosted-gate test doubles in a production artifact`);
			}
		}
	}
	if (a.profile === 'hosted-gate' && !gate) errors.push('hosted-artifact: a hosted-gate artifact without its test doubles: the profile did not reach the build');
	if (!files) errors.push('hosted-artifact: no emitted modules');
	return { errors, files };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
	const profile = arg('--profile'), root = arg('--root') ?? process.cwd();
	if (profile !== 'production' && profile !== 'hosted-gate') {
		console.error('hosted-artifact: --profile production|hosted-gate is required');
		process.exit(2);
	}
	const result = scanArtifact({ root, profile });
	for (const e of result.errors) console.error(e);
	console.log(`hosted-artifact: ${result.errors.length ? 'FAIL' : 'PASS'} ${profile} (${result.files} emitted modules)`);
	process.exitCode = result.errors.length ? 1 : 0;
}
