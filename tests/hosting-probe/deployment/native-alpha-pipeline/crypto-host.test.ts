// NATIVE24 (25 October 2026): the actual credential-free Wrangler bundle of ae9e2ae0 (2,958,271 bytes, entry sha256
// ec7889a3...) is refused for `import { createHash } from "node:crypto"` in two chunks of src/lib/case-package
// (verify-bytes, composition), beside static cloudflare:workers and node:buffer, two literal dynamic node:async_hooks and
// Svelte's obfuscated_import("node:crypto") forwarder. Workers provides node:crypto under an explicit nodejs_compat.
// Synthetic source through the real scanModule/uploadModuleProblems seam; no bundle, workerd, provider or flag waiver.
import { describe, expect, it } from 'vitest';
import { scanModule } from '../../../../deploy/probes/target.ts';
import { NATIVE_HOST_IMPORTS, dynamicHostImportsOf, hostImportsOf, uploadModuleProblems } from '../../../../deploy/native-alpha/pipeline.ts';

const ENTRY = 'artifact/cloudflare/_worker.js';
const HELPERS = `var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });`;
// The shape of the actual bundle: static host imports hoisted by esbuild, then the Svelte/SvelteKit dynamic imports.
const ACTUAL = `${HELPERS}
import { env } from "cloudflare:workers";
import { createHash } from "node:crypto";
import { createHash as createHash2 } from "node:crypto";
import { Buffer as Buffer2 } from "node:buffer";
var sha256Hex = (data) => createHash("sha256").update(data).digest("hex");
var other = (data) => createHash2("sha256").update(data).digest("hex");
var obfuscated_import = __name((module_name) => import(module_name), "obfuscated_import");
async function webcrypto() { return (await obfuscated_import("node:crypto")).webcrypto; }
async function als() { return [await import("node:async_hooks"), await import("node:async_hooks")]; }
export default { fetch() { return new Response(String([env, sha256Hex, other, Buffer2, webcrypto, als])); } };
`;
const problems = (source: string, flags?: readonly string[]) => uploadModuleProblems(scanModule(source), ENTRY, flags);
const staticCrypto = (clause: string) => `${clause}\nexport default {};\n`;
const FLAGS = [undefined, [], ['nodejs_als'], ['nodejs_compat_v2'], ['no_nodejs_compat'], ['nodejs_compat', 'no_nodejs_compat'], ['no_nodejs_compat', 'nodejs_compat']] as const;

describe('the actual bundle shape: static node:crypto beside the proven Buffer, ALS and forwarder host imports', () => {
	it.each([['nodejs_compat'], ['nodejs_als', 'nodejs_compat']])('passes closure under the explicit %j target', (...flags) => {
		expect(problems(ACTUAL, flags)).toEqual([]);
	});
	it('records exactly the host imports the upload record names, and no other dynamic host import', () => {
		const facts = scanModule(ACTUAL);
		expect(hostImportsOf(facts)).toEqual(['cloudflare:workers', 'node:buffer', 'node:crypto']);
		expect(dynamicHostImportsOf(facts)).toEqual([
			{ specifier: 'node:async_hooks', via: 'literal', sites: 2 },
			{ specifier: 'node:crypto', via: 'forwarder obfuscated_import', sites: 1 },
		]);
	});
	it('names node:crypto in the exact reviewed static host list, with nothing else added', () => {
		expect([...NATIVE_HOST_IMPORTS]).toEqual(['cloudflare:workers', 'node:async_hooks', 'node:buffer', 'node:crypto']);
	});
	it.each(FLAGS)('refuses the actual shape without an enabled nodejs_compat (flags %j)', (flags) => {
		expect(problems(ACTUAL, flags).join('\n')).toMatch(/node:crypto/);
	});
});

describe('static node:crypto needs an explicit, enabled nodejs_compat', () => {
	const forms: Array<[string, string]> = [
		['a named import', `import { createHash } from 'node:crypto';`],
		['an aliased import', `import { createHash as h } from "node:crypto";`],
		['a default import', `import c from 'node:crypto';`],
		['a namespace import', `import * as c from 'node:crypto';`],
		['a bare side-effect import', `import 'node:crypto';`],
		['an export-from', `export { createHash } from 'node:crypto';`],
	];
	it.each(forms)('admits %s under nodejs_compat', (_what, clause) => {
		expect(problems(staticCrypto(clause), ['nodejs_compat'])).toEqual([]);
	});
	it.each(forms.flatMap(([what, clause]) => FLAGS.map((f) => [what, clause, f] as const)))('refuses %s under flags %j', (_what, clause, flags) => {
		expect(problems(staticCrypto(clause), flags)).not.toEqual([]);
	});
	it('admits only the exact specifier: bare crypto, subpaths, case or whitespace variants and look-alikes stay refused', () => {
		for (const spec of ['crypto', 'crypto/', 'node:crypto/', 'node:crypto/webcrypto', 'node:crypto/x', 'node:cryptox', 'node:Crypto', 'NODE:crypto', 'node:crypto ', ' node:crypto', 'node:crypt', 'node:internal/crypto', 'node:webcrypto', '@node/crypto', './node:crypto', 'cloudflare:node:crypto', 'cloudflare:crypto'])
			expect(problems(staticCrypto(`import { createHash } from ${JSON.stringify(spec)};`), ['nodejs_compat']), spec).not.toEqual([]);
	});
	it('does not widen other Node or generic host capabilities, static or dynamic', () => {
		for (const spec of ['node:fs', 'fs', 'node:fs/promises', 'node:net', 'node:child_process', 'node:path', 'node:http', 'node:os', 'node:process', 'node:stream', 'node:util', 'node:module', 'node:vm', 'node:worker_threads', 'node:dns', 'node:tls']) {
			expect(problems(staticCrypto(`import x from ${JSON.stringify(spec)};`), ['nodejs_compat']), `static ${spec}`).not.toEqual([]);
			expect(problems(`export const p = import(${JSON.stringify(spec)});`, ['nodejs_compat']), `dynamic ${spec}`).not.toEqual([]);
		}
	});
	it('still refuses dynamic Buffer and a dynamic subpath or bare alias of crypto', () => {
		for (const spec of ['node:buffer', 'buffer', 'crypto', 'node:crypto/webcrypto'])
			expect(problems(`export const p = import(${JSON.stringify(spec)});`, ['nodejs_compat']), spec).not.toEqual([]);
	});
	it('does not turn a static node:crypto into a waiver for a computed, global or dynamic-forwarder escape', () => {
		const cases = ['import c from "node:crypto";\nexport const p = import(globalThis.where);', 'import c from "node:crypto";\nconst s = "node:" + "fs";\nexport const p = import(s);', 'import c from "node:crypto";\nexport const r = require("node:fs");', 'import c from "node:crypto";\nimport x from computed;'];
		for (const source of cases) expect(problems(source, ['nodejs_compat']), source).not.toEqual([]);
	});
});

describe('the resolved forwarder class is judged exactly, not any callback argument', () => {
	const fwd = (rest: string) => `${HELPERS}
var fwd = __name((module_name) => import(module_name), "fwd");
${rest}
export default {};
`;
	const flags = ['nodejs_compat'];
	it('admits a forwarder whose every use is a direct call with the literal node:crypto', () => {
		expect(problems(fwd('fwd("node:crypto");'), flags)).toEqual([]);
		expect(problems(fwd('fwd("node:crypto"); fwd("node:crypto");'), flags)).toEqual([]);
	});
	it.each([
		['an unknown fs literal', 'fwd("node:fs");'],
		['dynamic Buffer', 'fwd("node:buffer");'],
		['a crypto subpath', 'fwd("node:crypto/webcrypto");'],
		['a variable argument', 'var s = globalThis.s; fwd(s);'],
		['a concatenated argument', 'fwd("node:" + "crypto");'],
		['a template argument', 'fwd(`node:crypto`);'],
		['a callback argument (map)', '["node:crypto"].map(fwd);'],
		['a callback argument (then)', 'Promise.resolve("node:crypto").then(fwd);'],
		['an alias call', 'var alias = fwd; alias("node:crypto");'],
		['a property read', 'var o = { fwd }; o.fwd("node:crypto");'],
		['an exported forwarder', 'export { fwd };'],
		['an unresolved forwarder argument beside a good call', 'fwd("node:crypto"); fwd(globalThis.m);'],
	])('refuses %s even with nodejs_compat', (_what, rest) => {
		expect(problems(fwd(rest), flags), rest).not.toEqual([]);
	});
	it('still refuses an unresolved dynamic import and a fully obfuscated one', () => {
		expect(problems('export const p = (m) => import(m);', flags)).not.toEqual([]);
		expect(problems('export const p = import("node:" + "crypto");', flags)).not.toEqual([]);
		expect(problems('export const p = import(globalThis.name);', flags)).not.toEqual([]);
	});
	it.each(FLAGS)('refuses the resolved forwarder class for node:crypto without an enabled nodejs_compat (flags %j)', (flagList) => {
		expect(problems(fwd('fwd("node:crypto");'), flagList)).not.toEqual([]);
	});
});
