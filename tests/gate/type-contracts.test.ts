// Compile-time contracts, proved with the project's own TypeScript compiler and tsconfig: each fixture below is
// compiled in one in-memory program next to the real sources. The valid fixture must compile with no diagnostic, and
// each invalid one must fail with exactly the expected error at the expected line, so it fails for the intended reason
// and not because of a typo or a missing import. They catch a union that widens to string (a dropped `as const`, a
// registry typed as Record<string, …>) or a TypeBox type that collapses to any, after which a misspelt diagnostic
// code, slot or manifest compiles silently.
import path from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve('.');
const HEADER = `import type { Code } from '../../src/lib/case-package/codes.ts';
import type { Manifest } from '../../src/lib/case-package/schema.ts';
import type { SlotId } from '../../src/lib/components/overview-slots.ts';
import type { ViewStatus } from '../../src/lib/components/view-registry.ts';
`;
const VALID = `const code: Code = 'ORIG_ESCAPE';
const slot: SlotId = 'deadlines';
const status: ViewStatus = 'unavailable-until:GRS-15';
const manifest = (m: Manifest) => m.resultsVersion.startsWith('sha256:');
export { code, slot, status, manifest };
`;
/** name, fixture body (line 5 onwards, after HEADER), expected TS code, line and message fragment */
const INVALID: [string, string, number, number, string][] = [
	['a misspelt diagnostic code', `export const c: Code = 'ORIG_ESCAPEE';\n`, 2820, 5, `Type '"ORIG_ESCAPEE"' is not assignable to type '"PKG_SOURCE_INVALID" | `],
	['a misspelt diagnostic code, with the compiler\'s suggestion', `export const c: Code = 'ORIG_ESCAPEE';\n`, 2820, 5, `Did you mean '"ORIG_ESCAPE"'?`],
	['an overview slot that does not exist', `export const s: SlotId = 'billing';\n`, 2322, 5, `Type '"billing"' is not assignable to type '"deadlines" | "unbilled-time" | "rescan-freshness"'`],
	['a view status without its owner', `export const v: ViewStatus = 'unavailable';\n`, 2820, 5, `Type '"unavailable"' is not assignable to type 'ViewStatus'. Did you mean '"available"'?`],
	['a manifest missing its required fields', `export const m: Manifest = { format: 'clearcase.results-package', formatVersion: 1 };\n`, 2740, 5, `is missing the following properties from type`],
	['a manifest with a field the schema does not have', `export const r = (m: Manifest) => m.resultVersion;\n`, 2551, 5, `Property 'resultVersion' does not exist on type`],
];

const fixture = (name: string) => path.join(root, 'tests', 'gate', `__type-contract-${name}.ts`);
const files = new Map<string, string>([[fixture('valid'), HEADER + VALID], ...INVALID.map(([, body], i): [string, string] => [fixture(`invalid-${i}`), HEADER + body])]);
let byFile: Map<string, readonly ts.Diagnostic[]>;

beforeAll(() => {
	const config = ts.getParsedCommandLineOfConfigFile(path.join(root, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
	if (!config) throw new Error('tsconfig.json could not be read (run `bun run --bun check` first: svelte-kit sync writes .svelte-kit/tsconfig.json)');
	const host = ts.createCompilerHost(config.options);
	const getSourceFile = host.getSourceFile.bind(host);
	host.getSourceFile = (name, lang, ...rest) => files.has(name) ? ts.createSourceFile(name, files.get(name)!, lang) : getSourceFile(name, lang, ...rest);
	const fileExists = host.fileExists.bind(host);
	host.fileExists = (name) => files.has(name) || fileExists(name);
	const program = ts.createProgram({ rootNames: [...files.keys()], options: config.options, host });
	byFile = new Map([...files.keys()].map((f) => [f, ts.getPreEmitDiagnostics(program, program.getSourceFile(f))]));
}, 60_000);

/** A diagnostic as an agent reads it: file:line, TS code and the full message chain. */
const show = (d: ts.Diagnostic) => {
	const at = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
	return `${d.file ? path.relative(root, d.file.fileName) : '<global>'}:${at ? `${at.line + 1}:${at.character + 1}` : '-'} TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
};

describe('type contracts (the project compiler on in-memory fixtures)', () => {
	it('the valid fixture compiles with no diagnostic', () => {
		expect(byFile.get(fixture('valid'))!.map(show)).toEqual([]);
	});

	it.each(INVALID.map((c, i) => [c[0], i, c[2], c[3], c[4]] as const))('rejects %s', (_, i, code, line, message) => {
		const got = byFile.get(fixture(`invalid-${i}`))!.map(show);
		expect(got, `expected exactly one TS${code} at line ${line}; reproduce: bun run --bun test tests/gate/type-contracts.test.ts`).toHaveLength(1);
		expect(got[0]).toMatch(new RegExp(`^tests/gate/__type-contract-invalid-${i}\\.ts:${line}:\\d+ TS${code} `));
		expect(got[0]).toContain(message);
	});
});
