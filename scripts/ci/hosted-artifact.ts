// The emitted-artifact half of the hosted import boundary. The source guard (hosted-imports.ts) walks first-party
// modules and stops at the allowlisted framework packages; this scan reads what the build actually emitted for workerd
// (.svelte-kit/cloudflare and the server output it imports) and refuses any import of a filesystem, SQLite, process or
// network module, any use of the process or Bun global, and any test double where the profile forbids one. Run by
// `build:hosted` after every hosted build.
//
//   bun scripts/ci/hosted-artifact.ts [--root DIR] --profile production|hosted-gate
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostedProfile } from './hosted-imports.ts';
import { manifestAssets, pinnedBrowserRefusal, PINNED_BROWSER_MODULES, scanModule, serverImportOfPinned } from './hosted-artifact-scope.ts';

const LOCAL_MODULES = '(?:node:)?(?:fs|fs/promises|sqlite|child_process|net|http|https|http2|cluster|worker_threads|dgram|tls|readline|repl|v8|vm)';
// import/export ... from, import() and require() naming a local-only module, or any bun: module. Node's getBuiltinModule is
// a use of the process global, refused by scope (hosted-artifact-scope.ts) unless it is one of Kit's exact KIT_PROBES.
const IMPORT = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|^\\s*import\\s*)["'\`](${LOCAL_MODULES}|bun:[a-z]+|better-sqlite3)["'\`]`, 'gm');
// Test doubles: the memory doubles never ship; the hosted-gate doubles ship only in a hosted-gate artifact.
const MEMORY = ['memory-contract-diagnostic', 'createMemoryBackend'];
const GATE = 'clearcase-test-double:hosted-gate';
const ROOTS = ['.svelte-kit/cloudflare', '.svelte-kit/output/server'];
const MANIFEST = '.svelte-kit/output/server/manifest.js';

export function scanArtifact(a: { root: string; profile: HostedProfile }): { errors: string[]; files: number } {
	const errors: string[] = [];
	let files = 0, gate = false;
	const manifest = path.join(a.root, MANIFEST), assets = manifestAssets(existsSync(manifest) ? readFileSync(manifest, 'utf8') : undefined);
	for (const dir of ROOTS) {
		const base = path.join(a.root, dir);
		if (!existsSync(base)) {
			errors.push(`hosted-artifact: ${dir} is missing`);
			continue;
		}
		for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
			if (!entry.isFile() || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
			const file = path.join(entry.parentPath, entry.name), name = path.relative(a.root, file).replaceAll(path.sep, '/');
			const bytes = readFileSync(file), text = bytes.toString('utf8'), scan = scanModule(text, name.startsWith('.svelte-kit/output/server/'));
			files++;
			if (scan.unparsed) errors.push(`hosted-artifact: ${name}: not parseable as an ES module (${scan.unparsed})`);
			// The reviewed PDF.js browser modules keep their Node branches only at their exact path, bytes and manifest role.
			const refusal = name in PINNED_BROWSER_MODULES ? pinnedBrowserRefusal({ name, bytes, uses: scan.uses, manifestAssets: assets }) : undefined;
			if (refusal) errors.push(`hosted-artifact: ${name}: ${refusal}`);
			if (refusal !== null) for (const use of scan.uses) errors.push(`hosted-artifact: ${name}: uses ${use}`);
			const pinned = serverImportOfPinned(name, scan.imports);
			if (pinned) errors.push(`hosted-artifact: ${name}: imports the browser-only PDF.js module ${pinned}`);
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
