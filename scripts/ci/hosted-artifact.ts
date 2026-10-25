// The emitted-artifact half of the hosted import boundary. The source guard (hosted-imports.ts) walks first-party
// modules and stops at the allowlisted framework packages; this scan reads what the build actually emitted for workerd
// (.svelte-kit/cloudflare and the server output it imports) and refuses any import of a filesystem, SQLite, process or
// network module, any use of the process or Bun global, any unresolved reach of the global object or unproven
// `import()` in a module the Worker can run, and any test double where the profile forbids one. Run by `build:hosted`
// after every hosted build.
//
//   bun scripts/ci/hosted-artifact.ts [--root DIR] --profile production|hosted-gate
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostedProfile } from './hosted-imports.ts';
import { readRegular } from '../../deploy/probes/target.ts';
import { manifestAssets, pinnedBrowserRefusal, PINNED_BROWSER_MODULES, reachChain, scanModule, workerReach, type ModuleScan } from './hosted-artifact-scope.ts';

const LOCAL_MODULES = '(?:node:)?(?:fs|fs/promises|sqlite|child_process|net|http|https|http2|cluster|worker_threads|dgram|tls|readline|repl|v8|vm)';
// import/export ... from, import() and require() naming a local-only module, or any bun: module. Node's getBuiltinModule is
// a use of the process global, refused by scope (hosted-artifact-scope.ts); the hosted build removes Kit's own probes
// (scripts/hosted-kit-diagnostics-build.ts). node:process and node:module (createRequire) are the same reach by import,
// matched on parsed specifiers because Kit's emitted JSDoc names `import('node:module').SourceMap`.
const IMPORT = new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|^\\s*import\\s*)["'\`](${LOCAL_MODULES}|bun:[a-z]+|better-sqlite3)["'\`]`, 'gm');
const LOCAL = new RegExp(`^(?:${LOCAL_MODULES}|(?:node:)?(?:process|module)|bun:[a-z]+|better-sqlite3)$`);
// Test doubles: the memory doubles never ship; the hosted-gate doubles ship only in a hosted-gate artifact.
const MEMORY = ['memory-contract-diagnostic', 'createMemoryBackend'];
const GATE = 'clearcase-test-double:hosted-gate';
const ROOTS = ['.svelte-kit/cloudflare', '.svelte-kit/output/server'];
const MANIFEST = '.svelte-kit/output/server/manifest.js';
const BUILD_ROOT = '.svelte-kit';
const MAX_MODULES = 4096, MAX_BYTES = 128 * 1024 * 1024; // readRegular also caps each descriptor read at 64 MiB.

export function scanArtifact(a: { root: string; profile: HostedProfile }): { errors: string[]; files: number } {
	const errors: string[] = [];
	let gate = false;
	const modules = new Map<string, { bytes: Buffer; text: string; scan: ModuleScan }>();
	let total = 0;
	const buildRoot = path.resolve(a.root, BUILD_ROOT);
	const directory = (at: string) => {
		for (let dir = path.resolve(at); ; dir = path.dirname(dir)) {
			if (!lstatSync(dir).isDirectory()) throw new Error('artifact directory is not a real directory (symlink refused)');
			if (dir === buildRoot) break;
		}
	};
	// All inventory and discovered dependencies use the same descriptor snapshot and containment rule. Nothing is
	// loaded from the checkout/package tree outside the build root, and no filename grants an exception.
	const load = (name: string) => {
		const known = modules.get(name);
		if (known) return known;
		if (!name.startsWith(`${BUILD_ROOT}/`) || path.posix.normalize(name) !== name || !/\.(?:js|mjs|cjs)$/.test(name)) throw new Error('not a canonical build-root JS path');
		if (modules.size >= MAX_MODULES) throw new Error(`over the ${MAX_MODULES} module limit`);
		const file = path.resolve(a.root, name);
		directory(path.dirname(file));
		const bytes = readRegular(file, buildRoot);
		total += bytes.length;
		if (total > MAX_BYTES) throw new Error(`over the ${MAX_BYTES} total byte limit`);
		const text = bytes.toString('utf8'), entry = { bytes, text, scan: scanModule(text) };
		modules.set(name, entry);
		return entry;
	};
	for (const dir of ROOTS) {
		const base = path.join(a.root, dir);
		if (!existsSync(base)) {
			errors.push(`hosted-artifact: ${dir} is missing`);
			continue;
		}
		try { directory(base); } catch (e) {
			errors.push(`hosted-artifact: ${dir}: cannot read artifact directory: ${(e as Error).message}`);
			continue;
		}
		for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
			if (!(entry.isFile() || entry.isSymbolicLink()) || !/\.(?:js|mjs|cjs)$/.test(entry.name)) continue;
			const file = path.join(entry.parentPath, entry.name), name = path.relative(a.root, file).replaceAll(path.sep, '/');
			try { load(name); } catch (e) { errors.push(`hosted-artifact: ${name}: cannot read artifact bytes: ${(e as Error).message}`); }
		}
	}
	const { assets, problem } = manifestAssets(modules.get(MANIFEST)?.text);
	if (problem) errors.push(`hosted-artifact: ${MANIFEST}: ${problem}`);
	const reach = workerReach(modules, load);
	for (const [name, why] of reach.problems) errors.push(`hosted-artifact: ${name}: ${why}`);
	for (const [name, specifier] of reach.host) if (LOCAL.test(specifier)) errors.push(`hosted-artifact: ${name}: imports ${specifier}`);
	for (const [name, { bytes, text, scan }] of modules) {
		const worker = reach.via.has(name);
		if (scan.unparsed) errors.push(`hosted-artifact: ${name}: not parseable as an ES module (${scan.unparsed})`);
		// The reviewed PDF.js browser modules keep their Node branches only at their exact path, bytes and manifest role,
		// and only while no module the Worker runs reaches them.
		const refusal = name in PINNED_BROWSER_MODULES ? pinnedBrowserRefusal({ name, bytes, uses: scan.uses, manifestAssets: assets, workerChain: worker ? reachChain(reach.via, name) : undefined }) : undefined;
		if (refusal) errors.push(`hosted-artifact: ${name}: ${refusal}`);
		if (refusal !== null) for (const use of scan.uses) errors.push(`hosted-artifact: ${name}: uses ${use}`);
		// A module only the browser loads may reach its own global object; one the Worker runs must not, unresolved.
		if (worker) for (const what of scan.unresolved) errors.push(`hosted-artifact: ${name}: unresolved global object access (${what})`);
		for (const [specifier, target] of reach.edges.get(name) ?? []) if (target in PINNED_BROWSER_MODULES) errors.push(`hosted-artifact: ${name}: imports the browser-only PDF.js module ${specifier}`);
		for (const m of text.matchAll(IMPORT)) errors.push(`hosted-artifact: ${name}: imports ${m[1]}`);
		for (const s of scan.imports) if (/^(?:node:)?(?:process|module)$/.test(s)) errors.push(`hosted-artifact: ${name}: imports ${s}`);
		for (const marker of MEMORY) if (text.includes(marker)) errors.push(`hosted-artifact: ${name}: contains the memory test double (${marker})`);
		if (text.includes(GATE)) {
			gate = true;
			if (a.profile === 'production') errors.push(`hosted-artifact: ${name}: contains the hosted-gate test doubles in a production artifact`);
		}
	}
	if (a.profile === 'hosted-gate' && !gate) errors.push('hosted-artifact: a hosted-gate artifact without its test doubles: the profile did not reach the build');
	if (!modules.size) errors.push('hosted-artifact: no emitted modules');
	return { errors, files: modules.size };
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
