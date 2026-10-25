// Build-only, hosted target only. Never import this file into the Worker.
//
// Kit 3's server runtime probes Node in two diagnostic modules: src/runtime/server/sourcemaps.js reads node:fs, node:url,
// node:path, node:module and the cwd to source-map stack traces, and src/runtime/server/internal.js reads node:util's
// styleText to colour log lines. Each probe is `globalThis.process?.…`, so it is undefined wherever `process` is, and
// both modules fall back honestly: fix_stack_trace returns at `!fs` and leaves the stack alone, and styleText becomes
// `(_format, text) => text`. The hosted build replaces each exact probe with `undefined`, the value it already has in
// workerd without nodejs_compat, so the emitted Worker holds no process reach at all and the artifact scan
// (scripts/ci/hosted-artifact.ts) needs no Kit exemption. Nothing is shimmed: no fs, url, path, SourceMap or styleText
// result is invented. Inputs and outputs are pinned by SHA-256; a Kit upgrade fails the build here until reviewed.
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const KIT = '@sveltejs/kit';
export const KIT_VERSION = '3.1.0';
type Adaptation = { probes: readonly string[]; inputSha256: string; outputSha256: string };
/** Each module's exact probe texts, as Kit writes them, and the SHA-256 of its installed input and adapted output. */
export const KIT_DIAGNOSTIC_MODULES: Readonly<Record<string, Adaptation>> = {
	'src/runtime/server/sourcemaps.js': {
		probes: [...['fs', 'url', 'path', 'module'].map((m) => `globalThis.process?.getBuiltinModule?.('node:${m}')`), 'globalThis.process?.cwd?.()'],
		inputSha256: 'eaf5cef63e5c7704a8c25849d5a960d1d2887b4ba5d658157f266ee9f52a5db9',
		outputSha256: 'c116cb8cfbdc96ee449a42c3db3fcca527967952acfb52f446dbc9ca2a4af168',
	},
	'src/runtime/server/internal.js': {
		probes: ["globalThis.process?.getBuiltinModule?.('node:util')"],
		inputSha256: '60e9d414524f2bfcf749bd8c88517fbec45707aacd3b4e11da17086cce529a6f',
		outputSha256: '5f4921d376c22241ac64b7bc2830f70afd368e4a114b1688aba12b6e74f77082',
	},
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
function refused(why: string): never { throw Error('hosted Kit diagnostics build refused: ' + why); }

/** The adapted source of one Kit diagnostic module: its pinned input with each probe, occurring exactly once, as `undefined`. */
export function adaptKitDiagnostics(module: string, source: string): string {
	const pin = KIT_DIAGNOSTIC_MODULES[module];
	if (!pin) refused(`${module} is not a Kit diagnostic module`);
	if (sha(source) !== pin.inputSha256) refused(`${module} is not the reviewed Kit ${KIT_VERSION} input (sha256 ${sha(source)})`);
	let code = source;
	for (const probe of pin.probes) {
		if (code.split(probe).length !== 2) refused(`${module} does not hold ${probe} exactly once`);
		code = code.replace(probe, 'undefined');
	}
	if (sha(code) !== pin.outputSha256) refused(`${module} adapted output is not the reviewed output (sha256 ${sha(code)})`);
	return code;
}

/** The Vite plugin for the hosted server build; undefined for the local target, which keeps Kit's Node diagnostics.
 * It adapts exactly the two modules at the installed Kit root and, at the end of the server build, refuses one that the
 * graph holds without the reviewed output, or a Kit diagnostic module reached from anywhere else. */
export function hostedKitDiagnosticsBuild(a: { root: string; target: 'local' | 'hosted' }): Plugin | undefined {
	if (a.target === 'local') return undefined;
	const kit = realpathSync(path.join(a.root, 'node_modules', KIT));
	const ids = new Map(Object.keys(KIT_DIAGNOSTIC_MODULES).map((m) => [path.join(kit, m), m]));
	const adapted = new Map<string, string>();
	return {
		name: 'clearcase-hosted-kit-diagnostics', enforce: 'pre', apply: 'build',
		applyToEnvironment: (environment) => environment.name === 'ssr',
		buildStart() {
			adapted.clear();
			const version = JSON.parse(readFileSync(path.join(kit, 'package.json'), 'utf8')).version;
			if (version !== KIT_VERSION) refused(`installed Kit is ${version}, reviewed ${KIT_VERSION}`);
		},
		transform(source, id) {
			const module = ids.get(id);
			if (!module) {
				if (Object.keys(KIT_DIAGNOSTIC_MODULES).some((m) => id.includes(`/${KIT}/${m}`))) refused(`a Kit diagnostic module outside the installed Kit root: ${id}`);
				return;
			}
			if (adapted.has(id)) refused(`${module} transformed twice`);
			const code = adaptKitDiagnostics(module, source);
			adapted.set(id, code);
			return { code, map: null };
		},
		generateBundle() {
			for (const [id, module] of ids) {
				const info = this.getModuleInfo(id);
				if (!info) refused(`${module} is not in the server graph`);
				if (info.code == null || info.code !== adapted.get(id)) refused(`${module} is in the server graph without its reviewed adaptation`);
			}
		},
	};
}
