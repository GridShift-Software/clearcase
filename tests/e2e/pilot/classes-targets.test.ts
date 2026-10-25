// The UI class suite's discovery (GRS-59) on a synthetic source tree: what it finds as a CSV producer, a leave guard, and
// what it refuses to leave unrecognised.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
// @ts-expect-error plain .mjs
import { csvExports, hasActions, hasLeaveGuard } from '../classes/targets.mjs';
// @ts-expect-error plain .mjs
import { HELPERS, NOT_PRODUCERS } from '../classes/declared.mjs';

const root = mkdtempSync(join(tmpdir(), 'cc-targets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text: string) => { const f = join(root, 'src', rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };

describe('csvExports', () => {
	test('the app export declarations agree with real CSV discovery', () => {
		const app = fileURLToPath(new URL('../../../', import.meta.url));
		const r = csvExports(app, { helpers: HELPERS, notProducers: NOT_PRODUCERS });
		expect(r.declaredButCsv).toEqual([]);
		expect(r.unrecognised).toEqual([]);
	});
	put('lib/components/csv.ts', "export const download = () => {};");
	put('routes/v/[vid]/a/+page.svelte', `<script>import { download } from "../../../../lib/components/csv.ts"; const go = () => download('a.csv', 'x');</script>`);
	put('routes/v/[vid]/b/+page.svelte', "<script>import Maker from '$lib/Maker.svelte';</script><Maker />");
	put('lib/Maker.svelte', "<script>import { download } from '$lib/components/csv'; const go = () => download('b.csv', 'x');</script>");
	put('routes/v/[vid]/c/+page.svelte', "<script>const go = () => downloadBlob('x.csv', 'a,b', 'text/csv');</script>");
	put('routes/v/[vid]/d/export/+server.ts', "export const GET = () => new Response(toCSV([]), { headers: { 'content-type': 'text/csv' } });");
	put('routes/v/[vid]/e/+page.svelte', "<a href='/x' download>Save</a>");
	put('routes/v/[vid]/f/+page.svelte', "<script>const go = () => downloadBlob('x.docx', b, DOCX);</script>");
	test('finds producers by import (either quote, relative), component, text/csv and a server toCSV', () => {
		const r = csvExports(root, { helpers: { 'src/lib/components/csv.ts': 'helper' } });
		expect(r.pages).toEqual(['/v/[vid]/a', '/v/[vid]/b', '/v/[vid]/c']);
		expect(r.servers).toEqual(['/v/[vid]/d/export']);
	});
	test('a file that hands content to the user and is not declared is unrecognised; a declared one is not', () => {
		const r = csvExports(root, { helpers: { 'src/lib/components/csv.ts': 'helper' }, notProducers: { 'src/routes/v/[vid]/f/+page.svelte': 'docx' } });
		expect(r.unrecognised).toEqual(['src/routes/v/[vid]/e/+page.svelte']);
		expect(r.declaredButCsv).toEqual([]);
	});
	test('a file declared not to produce CSV that now builds it is reported', () => {
		const r = csvExports(root, { helpers: { 'src/lib/components/csv.ts': 'helper' }, notProducers: { 'src/routes/v/[vid]/c/+page.svelte': 'was docx' } });
		expect(r.declaredButCsv).toEqual(['src/routes/v/[vid]/c/+page.svelte']);
	});
});

describe('hasLeaveGuard', () => {
	put('lib/Guarded.svelte', "<script>import { beforeNavigate } from '$app/navigation';</script>");
	put('routes/g1/+page.svelte', "<script>import LeaveGuard from '$lib/views/LeaveGuard.svelte';</script>");
	put('routes/g2/+page.svelte', "<script>import Guarded from '$lib/Guarded.svelte';</script>");
	put('routes/g3/+page.svelte', '<form></form>');
	test('a page is guarded by its own LeaveGuard or beforeNavigate, or by a component it imports', () => {
		expect(hasLeaveGuard(root, '/g1')).toBe(true);
		expect(hasLeaveGuard(root, '/g2')).toBe(true);
		expect(hasLeaveGuard(root, '/g3')).toBe(false);
	});
});


describe('CSV producers that discovery cannot map (GRS-61)', () => {
	const tree = () => mkdtempSync(join(root, 'unmapped-'));
	const file = (dir: string, rel: string, text: string) => { const f = join(dir, 'src', rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
	test('refuses a non-route TypeScript CSV producer instead of dropping it', () => {
		const dir = tree();
		file(dir, 'routes/a/+page.svelte', '<main />');
		file(dir, 'lib/export.ts', "import { download } from '$lib/components/csv'; export const save = () => download('a.csv', 'x');");
		expect(csvExports(dir).unrecognised).toEqual(['src/lib/export.ts']);
	});
	test('refuses a nested CSV component that is not mapped to a checked page', () => {
		const dir = tree();
		file(dir, 'routes/a/+page.svelte', "<script>import Shell from '$lib/Shell.svelte';</script><Shell />");
		file(dir, 'lib/Shell.svelte', "<script>import Maker from '$lib/Maker.svelte';</script><Maker />");
		file(dir, 'lib/Maker.svelte', "<script>import { download } from '$lib/components/csv'; const save = () => download('a.csv', 'x');</script>");
		expect(csvExports(dir).unrecognised).toEqual(['src/lib/Maker.svelte']);
	});
});


describe('shared direct and nested CSV producers (GRS-61)', () => {
 test('discovers every consuming page, including aliases, relative paths, cycles and several wrapper levels', () => {
  const dir = mkdtempSync(join(root, 'mixed-'));
  const file = (rel: string, source: string) => { const path = join(dir, 'src', rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); };
  file('routes/direct/+page.svelte', "<script>import Maker from '$lib/Maker.svelte';</script><Maker />");
  file('routes/wrapped/+page.svelte', "<script>import Shell from '$lib/Shell.svelte';</script><Shell />");
  file('routes/deep/+page.svelte', "<script>import Outer from '../../lib/Outer.svelte';</script><Outer />");
  file('lib/Outer.svelte', "<script>import Shell from './Shell.svelte';</script><Shell />");
  file('lib/Shell.svelte', "<script>import Renamed from './Maker.svelte'; import Outer from './Outer.svelte';</script><Renamed />");
  file('lib/Maker.svelte', "<script>import { download } from '$lib/components/csv'; const save = () => download('a.csv', 'x');</script>");
  expect(csvExports(dir)).toEqual({ pages: ['/deep', '/direct', '/wrapped'], servers: [], unrecognised: [], declaredButCsv: [] });
 });
 test('keeps every page the base found: a mapped producer reached through a barrel or a dynamic import, or a wrapper imported dynamically', () => {
  const dir = mkdtempSync(join(root, 'unfollowed-'));
  const file = (rel: string, source: string) => { const path = join(dir, 'src', rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); };
  file('routes/direct/+page.svelte', "<script>import Maker from '$lib/Maker.svelte';</script><Maker />");
  file('routes/barrel/+page.svelte', "<script>import { Maker } from '$lib';</script><Maker />");
  file('routes/lazy/+page.svelte', "<script>const Maker = import('$lib/Maker.svelte');</script>{#await Maker then M}<M.default />{/await}");
  file('routes/lazy-wrapped/+page.svelte', "<script>const Box = import('$lib/Shell.svelte');</script>{#await Box then B}<B.default />{/await}");
  file('lib/index.ts', "export { default as Maker } from './Maker.svelte';");
  file('lib/Shell.svelte', "<script>import Maker from './Maker.svelte';</script><Maker />");
  file('lib/Maker.svelte', "<script>import { download } from '$lib/components/csv'; const save = () => download('a.csv', 'x');</script>");
  expect(csvExports(dir)).toEqual({ pages: ['/barrel', '/direct', '/lazy', '/lazy-wrapped'], servers: [], unrecognised: [], declaredButCsv: [] });
 });
});

describe('barrel and alias edges between pages and a mapped CSV producer (GRS-61, PR #63 review)', () => {
 const MAKER = "<script>import { download } from '$lib/components/csv'; const save = () => download('a.csv', 'x');</script>";
 const build = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(root, 'barrel-'));
  for (const [rel, source] of Object.entries(files)) { const path = join(dir, 'src', rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); }
  return dir;
 };
 // every consuming page is discovered, or the file that hides it is refused: never neither
 const accounted = (r: { pages: string[]; unrecognised: string[] }, page: string, file: string) => r.pages.includes(page) || r.unrecognised.includes(file);
 test('a page importing the producer through an aliased barrel re-export is discovered next to a direct page', () => {
  const dir = build({
   'routes/direct/+page.svelte': "<script>import Maker from '$lib/Maker.svelte';</script><Maker />",
   'routes/alias/+page.svelte': "<script>import { CsvDownload } from '$lib';</script><CsvDownload />",
   'lib/index.ts': "export { default as CsvDownload } from './Maker.svelte';",
   'lib/Maker.svelte': MAKER,
  });
  const r = csvExports(dir);
  expect(accounted(r, '/alias', 'src/routes/alias/+page.svelte')).toBe(true);
  expect(r).toEqual({ pages: ['/alias', '/direct'], servers: [], unrecognised: [], declaredButCsv: [] });
 });
 test('a wrapper that reaches the producer through a barrel counts for every page that renders it', () => {
  const dir = build({
   'routes/direct/+page.svelte': "<script>import Maker from '$lib/Maker.svelte';</script><Maker />",
   'routes/shell/+page.svelte': "<script>import Shell from '$lib/Shell.svelte';</script><Shell />",
   'lib/Shell.svelte': "<script>import { CsvDownload } from './index';</script><CsvDownload />",
   'lib/index.ts': "export { default as CsvDownload } from './Maker.svelte';",
   'lib/Maker.svelte': MAKER,
  });
  const r = csvExports(dir);
  expect(accounted(r, '/shell', 'src/routes/shell/+page.svelte')).toBe(true);
  expect(r).toEqual({ pages: ['/direct', '/shell'], servers: [], unrecognised: [], declaredButCsv: [] });
 });
 test('follows nested barrels, export * and export { X }, with and without an extension on the barrel path', () => {
  const dir = build({
   'routes/direct/+page.svelte': "<script>import Maker from '$lib/Maker.svelte';</script><Maker />",
   'routes/star/+page.svelte': "<script>import { Csv } from '$lib/widgets';</script><Csv />",
   'routes/named/+page.svelte': "<script>import { Csv } from '$lib/widgets/index.ts';</script><Csv />",
   'lib/widgets/index.ts': "export * from './inner';",
   'lib/widgets/inner.ts': "export { default as Csv } from '../Maker.svelte';",
   'lib/Maker.svelte': MAKER,
  });
  expect(csvExports(dir).pages).toEqual(['/direct', '/named', '/star']);
 });
 test('refuses a consumer it cannot follow instead of dropping it: a computed dynamic import, and a directory import with no index to read', () => {
  const dir = build({
   'routes/direct/+page.svelte': "<script>import Maker from '$lib/Maker.svelte';</script><Maker />",
   'routes/computed/+page.svelte': "<script>const load = (n) => import(`$lib/${n}.svelte`);</script>",
   'routes/missing/+page.svelte': "<script>import { Csv } from '$lib/vendor';</script><Csv />",
   'lib/vendor/other.ts': 'export const x = 1;',
   'lib/Maker.svelte': MAKER,
  });
  const r = csvExports(dir);
  expect(accounted(r, '/computed', 'src/routes/computed/+page.svelte')).toBe(true);
  expect(accounted(r, '/missing', 'src/routes/missing/+page.svelte')).toBe(true);
  expect(r.unrecognised).toEqual(['src/routes/computed/+page.svelte', 'src/routes/missing/+page.svelte']);
  expect(r.pages).toEqual(['/direct']);
 });

 // `import(` in expression position after a keyword is a dynamic import; prose and method names are not (GRS-61, PR #63 re-check)
 const WRAPPER = { 'lib/x/Dl.svelte': "<script>import Maker from '$lib/Maker.svelte';</script><Maker />", 'lib/Maker.svelte': MAKER, 'routes/direct/+page.svelte': "<script>import Maker from '$lib/Maker.svelte';</script><Maker />" };
 test('a keyword-led dynamic import (void, else) of a wrapper of a mapped producer is discovered', () => {
  const dir = build({
   ...WRAPPER,
   'routes/void/+page.svelte': "<script>let C = $state(); void import('$lib/x/Dl.svelte').then((m) => (C = m.default));</script>",
   'routes/else/+page.svelte': "<script>let C; if (a) { x(); } else import('$lib/x/Dl.svelte').then((m) => (C = m.default));</script>",
  });
  expect(csvExports(dir)).toEqual({ pages: ['/direct', '/else', '/void'], servers: [], unrecognised: [], declaredButCsv: [] });
 });
 test('a keyword-led computed dynamic import is refused instead of dropped', () => {
  const dir = build({
   ...WRAPPER,
   'routes/void/+page.svelte': "<script>void import(`$lib/x/${n}.svelte`);</script>",
   'routes/else/+page.svelte': "<script>if (a) { x(); } else import(`$lib/x/${n}.svelte`);</script>",
  });
  const r = csvExports(dir);
  expect(r.unrecognised).toEqual(['src/routes/else/+page.svelte', 'src/routes/void/+page.svelte']);
  expect(r.pages).toEqual(['/direct']);
 });
 test('prose, a method named import and a $import call are not dynamic imports', () => {
  const dir = build({
   ...WRAPPER,
   'routes/prose/+page.svelte': "<script>const msg = 'changed since import (size differs)'; const t = `at import (size differs)`; db.import(rows); $import(rows);</script>{msg}",
  });
  expect(csvExports(dir)).toEqual({ pages: ['/direct'], servers: [], unrecognised: [], declaredButCsv: [] });
 });
 test('a line-start dynamic import after a line ending in a word, a comment or a \\r\\n ending is discovered', () => {
  const dir = build({
   ...WRAPPER,
   'routes/word/+page.svelte': "<script>let C;\n// preload\nimport('$lib/x/Dl.svelte').then((m) => (C = m.default));</script>",
   'routes/crlf/+page.svelte': "<script>let C;\r\n// preload\r\nimport('$lib/x/Dl.svelte').then((m) => (C = m.default));</script>",
   'routes/block/+page.svelte': "<script>let C; /* note */ import('$lib/x/Dl.svelte').then((m) => (C = m.default));</script>",
  });
  expect(csvExports(dir)).toEqual({ pages: ['/block', '/crlf', '/direct', '/word'], servers: [], unrecognised: [], declaredButCsv: [] });
 });
 test('a line-start computed dynamic import after a line ending in a word is refused instead of dropped', () => {
  const dir = build({
   ...WRAPPER,
   'routes/word/+page.svelte': "<script>let C;\n// preload\nimport(`$lib/x/${n}.svelte`);</script>",
   'routes/crlf/+page.svelte': "<script>let C;\r\n// preload\r\nimport(`$lib/x/${n}.svelte`);</script>",
   'routes/block/+page.svelte': "<script>let C; /* note */ import(`$lib/x/${n}.svelte`);</script>",
  });
  const r = csvExports(dir);
  expect(r.unrecognised).toEqual(['src/routes/block/+page.svelte', 'src/routes/crlf/+page.svelte', 'src/routes/word/+page.svelte']);
  expect(r.pages).toEqual(['/direct']);
 });
 test('imports of non-code files and packages are not consumers to refuse', () => {
  const dir = build({
   'routes/direct/+page.svelte': "<script>import Maker from '$lib/Maker.svelte'; import raw from '$lib/x.css?raw'; import { page } from '$app/state'; import z from 'zod'; import d from './data.json';</script><Maker />",
   'routes/direct/data.json': '{}',
   'lib/Maker.svelte': MAKER,
  });
  expect(csvExports(dir)).toEqual({ pages: ['/direct'], servers: [], unrecognised: [], declaredButCsv: [] });
 });
});

describe('the other page discoveries follow the same edges (GRS-61, PR #63 review)', () => {
 const build = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(root, 'sweep-'));
  for (const [rel, source] of Object.entries(files)) { const path = join(dir, 'src', rel); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); }
  return dir;
 };
 test('hasLeaveGuard follows an aliased barrel, a dynamic import and a relative directory import', () => {
  const dir = build({
   'lib/index.ts': "export { default as Guard } from './Guarded.svelte';",
   'lib/Guarded.svelte': "<script>import { beforeNavigate } from '$app/navigation';</script>",
   'routes/barrel/+page.svelte': "<script>import { Guard } from '$lib';</script><Guard />",
   'routes/lazy/+page.svelte': "<script>const G = import('$lib/Guarded.svelte');</script>",
   'routes/rel/+page.svelte': "<script>import { Guard } from '../../lib';</script><Guard />",
   'routes/none/+page.svelte': '<form></form>',
  });
  for (const r of ['/barrel', '/lazy', '/rel']) expect(hasLeaveGuard(dir, r)).toBe(true);
  expect(hasLeaveGuard(dir, '/none')).toBe(false);
 });
 test('hasLeaveGuard follows a keyword-led dynamic import and ignores prose and method calls', () => {
  const dir = build({
   'lib/Guarded.svelte': "<script>import { beforeNavigate } from '$app/navigation';</script>",
   'routes/void/+page.svelte': "<script>void import('$lib/Guarded.svelte').then((m) => m.default);</script>",
   'routes/prose/+page.svelte': "<script>const msg = 'changed since import (size differs)'; db.import(rows); $import(rows);</script>",
  });
  expect(hasLeaveGuard(dir, '/void')).toBe(true);
  expect(hasLeaveGuard(dir, '/prose')).toBe(false);
 });
 test('hasLeaveGuard refuses a page whose import it cannot follow instead of answering no', () => {
  const dir = build({
   'lib/vendor/other.ts': 'export const x = 1;',
   'routes/a/+page.svelte': "<script>import { Guard } from '$lib/vendor';</script><Guard />",
   'routes/b/+page.svelte': "<script>const load = (n) => import(`$lib/${n}.svelte`);</script>",
  });
  expect(() => hasLeaveGuard(dir, '/a')).toThrow(/cannot follow/);
  expect(() => hasLeaveGuard(dir, '/b')).toThrow(/cannot follow/);
 });
 test('hasActions sees a local export { actions }, an aliased re-export and an export * from another module', () => {
  const dir = build({
   'lib/forms.ts': 'export const actions = {};',
   'routes/local/+page.server.ts': 'const a = {}; export { a as actions };',
   'routes/alias/+page.server.ts': "export { default as actions } from '$lib/forms';",
   'routes/star/+page.server.ts': "export * from '$lib/forms';",
   'routes/plain/+page.server.ts': 'export const load = () => ({});',
  });
  for (const r of ['/local', '/alias', '/star']) expect(hasActions(dir, r)).toBe(true);
  expect(hasActions(dir, '/plain')).toBe(false);
 });
});

// The real app's CSV inventory at the GRS-61 base (1332ea8), recomputed there with that revision's own targets.mjs and declarations.
import baseProducers from './csv-producers.json';
// @ts-expect-error plain .mjs
import * as declared from '../classes/declared.mjs';
test('keeps the real app inventory at the base 19 pages and one server without rejected producers', () => {
 const result = csvExports(join(import.meta.dirname, '..', '..', '..'), { notProducers: declared.NOT_PRODUCERS, helpers: declared.HELPERS });
 expect(result).toEqual(baseProducers);
 expect(result.pages).toHaveLength(19);
 expect(result.servers).toHaveLength(1);
 expect(result.declaredButCsv).toEqual([]);
 expect(result.unrecognised).toEqual([]);
});

// The hosted route tree (deploy/client/routes, GRS-112) is not src/routes, so the class suite does not map its forms. Each
// hosted page with a form is declared with a reason (declared.mjs HOSTED_FORMS), and the reason is checked against evidence
// of a declared kind (HOSTED_FORM_EVIDENCE): the three test-identity routes are named by the hosted smoke run; the others
// are driven by tracked unit or component tests that import and call the real route modules over doubles. The unit and
// component kinds are never browser or workerd proof, and a harness file or a comment is not evidence.
// @ts-expect-error plain .mjs
import { hostedForms } from '../classes/targets.mjs';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import ts from 'typescript';

type Evidence = { kind: string; test: string; module?: string; via?: { file: string; export: string } };
const SMOKE = 'tests/hosted-foundation/runtime/smoke.ts';
// The original three smoke-bound routes, pinned here and not read from declared.mjs, so one cannot be relabelled to evade the smoke check.
const SMOKE_ROUTES = ['/cases', '/sign-in', '/sign-out'];

const parseTs = (root: string, rel: string) => ts.createSourceFile(rel, readFileSync(join(root, rel), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const visit = (node: ts.Node, fn: (n: ts.Node) => void) => { fn(node); ts.forEachChild(node, (c) => visit(c, fn)); };
const gitTracked = (root: string, rel: string) => spawnSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: root, stdio: 'ignore' }).status === 0;

// Driving code is a call on a reachable path from an enabled vitest test callback, over a small supported subset: straight-line
// statements, try and finally blocks, and `if` conditions. A call behind a condition, a short circuit, an optional chain, a
// loop or a switch does not count, and nothing after a statement that may end the function does: a return, throw or break
// behind any non-literal condition, a local function that may throw, a loop or another unsupported statement. A call reaches local helpers, callbacks a helper runs through its parameter, and const aliases, object
// tables and conditional or `??`/`||` choices of values. This is source evidence that the test executes the code, not that it passes.
type Param = { fn: ts.SignatureDeclaration; index: number };
type Value = ts.Node | Param | 'target';
const isNode = (v: Value): v is ts.Node => typeof v === 'object' && 'kind' in v;
const isFn = (v: Value): v is ts.FunctionLikeDeclaration => isNode(v) && ts.isFunctionLike(v) && 'body' in v && v.body !== undefined;
const strip = (e: ts.Expression): ts.Expression => {
 while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
 return e;
};
/** A literal condition's truth, undefined when it is opaque. */
function literal(e: ts.Expression): boolean | undefined {
 e = strip(e);
 if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
 if (e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return false;
 if (ts.isNumericLiteral(e)) return Number(e.text) !== 0;
 if (ts.isStringLiteralLike(e)) return e.text !== '';
 if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) { const k = literal(e.operand); return k === undefined ? undefined : !k; }
 return undefined;
}
const FALLS_THROUGH = new Set([ts.SyntaxKind.ExpressionStatement, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.EmptyStatement, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.InterfaceDeclaration, ts.SyntaxKind.TypeAliasDeclaration, ts.SyntaxKind.ImportDeclaration]);
const NO_TARGETS = new Set<string>();
/** Whether `n` may throw through a throw statement of its own or of a local function it calls (an IIFE or a helper). */
function mayThrow(n: ts.Node, seen = new Set<ts.Node>()): boolean {
 let hit = false;
 const walk = (m: ts.Node): void => {
  if (hit || (m !== n && ts.isFunctionLike(m))) return;
  if (ts.isThrowStatement(m)) hit = true;
  else if (ts.isCallExpression(m)) for (const v of values(m.expression, NO_TARGETS)) if (isFn(v) && !seen.has(v)) { seen.add(v); if (mayThrow(v.body!, seen)) hit = true; }
  ts.forEachChild(m, walk);
 };
 walk(n);
 return hit;
}
/** Whether what follows `s` in its block may not run: a statement that may end the function is not proved to fall through,
 * whatever its condition (only a literal is folded), and an unsupported statement counts as ending it. */
function ends(s: ts.Statement): boolean {
 if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isBreakOrContinueStatement(s)) return true;
 if (ts.isBlock(s)) return s.statements.some(ends);
 if (ts.isIfStatement(s)) {
  const k = literal(s.expression), other = s.elseStatement !== undefined && ends(s.elseStatement);
  return mayThrow(s.expression) || (k === true ? ends(s.thenStatement) : k === false ? other : other || ends(s.thenStatement));
 }
 if (ts.isTryStatement(s)) return ends(s.tryBlock) || (!!s.finallyBlock && ends(s.finallyBlock));
 if (ts.isExpressionStatement(s) || ts.isVariableStatement(s)) return mayThrow(s);
 return !FALLS_THROUGH.has(s.kind);
}
const SHORT_CIRCUIT = new Set([ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken]);
const liveMemo = new WeakMap<ts.Node, ts.CallExpression[]>();
/** The calls a function body makes on every run that reaches them, in the supported subset. */
function liveCalls(fn: ts.FunctionLikeDeclaration): ts.CallExpression[] {
 const memo = liveMemo.get(fn);
 if (memo) return memo;
 const out: ts.CallExpression[] = [];
 const expr = (e: ts.Node | undefined): void => {
  if (!e || ts.isFunctionLike(e) || ts.isClassLike(e) || ts.isOptionalChain(e)) return;
  if (ts.isConditionalExpression(e)) return expr(e.condition);
  if (ts.isBinaryExpression(e) && SHORT_CIRCUIT.has(e.operatorToken.kind)) return expr(e.left);
  if (ts.isCallExpression(e)) out.push(e);
  ts.forEachChild(e, expr);
 };
 const block = (ss: readonly ts.Statement[]) => { for (const s of ss) { statement(s); if (ends(s)) return; } };
 const statement = (s: ts.Statement) => {
  if (ts.isExpressionStatement(s) || ts.isReturnStatement(s) || ts.isThrowStatement(s)) expr(s.expression);
  else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) expr(d.initializer);
  else if (ts.isIfStatement(s)) expr(s.expression);
  else if (ts.isBlock(s)) block(s.statements);
  else if (ts.isTryStatement(s)) { block(s.tryBlock.statements); if (s.finallyBlock) block(s.finallyBlock.statements); }
 };
 if (fn.body && ts.isBlock(fn.body)) block(fn.body.statements); else expr(fn.body);
 liveMemo.set(fn, out);
 return out;
}
const bindsName = (b: ts.BindingName, name: string): boolean => ts.isIdentifier(b) ? b.text === name : b.elements.some((e) => ts.isBindingElement(e) && bindsName(e.name, name));
/** What an identifier can hold at `at`: the nearest parameter, function or const in scope; a top-level `targets` name is the target. */
function lookup(name: string, at: ts.Node, targets: Set<string>, depth: number): Value[] {
 for (let p = at.parent; p; p = p.parent) {
  if (ts.isFunctionLike(p)) { const index = p.parameters.findIndex((q) => bindsName(q.name, name)); if (index >= 0) return ts.isIdentifier(p.parameters[index]!.name) ? [{ fn: p, index }] : []; }
  if (ts.isSourceFile(p) && targets.has(name)) return ['target'];
  if (!ts.isBlock(p) && !ts.isSourceFile(p)) continue;
  for (const s of p.statements) {
   if (ts.isFunctionDeclaration(s) && s.name?.text === name) return [s];
   if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) if (bindsName(d.name, name))
    return s.declarationList.flags & ts.NodeFlags.Const && ts.isIdentifier(d.name) && d.initializer ? values(d.initializer, targets, depth + 1) : [];
  }
 }
 return [];
}
/** What an expression can evaluate to: functions, object tables, a parameter, or the target; anything else is opaque ([]). */
function values(e: ts.Expression, targets: Set<string>, depth = 0): Value[] {
 if (depth > 16) return [];
 e = strip(e);
 if (ts.isIdentifier(e)) return lookup(e.text, e, targets, depth);
 if (ts.isArrowFunction(e) || ts.isFunctionExpression(e) || ts.isObjectLiteralExpression(e)) return [e];
 if (ts.isConditionalExpression(e)) return [...values(e.whenTrue, targets, depth + 1), ...values(e.whenFalse, targets, depth + 1)];
 if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return [...values(e.left, targets, depth + 1), ...values(e.right, targets, depth + 1)];
 if (!ts.isPropertyAccessExpression(e) && !ts.isElementAccessExpression(e)) return [];
 const key = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : undefined;
 return values(e.expression, targets, depth + 1).flatMap((v): Value[] => {
  // a member every function or object has (`bind`, `toString`, …) is not the route's code, so calling it drives nothing
  if (v === 'target') return key !== undefined && (key in Function.prototype || key in Object.prototype) ? [] : ['target'];
  if (!isNode(v) || !ts.isObjectLiteralExpression(v)) return [];
  return v.properties.flatMap((m): Value[] => {
   const named = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteralLike(m.name)) ? m.name.text : undefined;
   if (key !== undefined && named !== key) return [];
   if (ts.isPropertyAssignment(m)) return values(m.initializer, targets, depth + 1);
   if (ts.isShorthandPropertyAssignment(m)) return values(m.name, targets, depth + 1);
   return ts.isMethodDeclaration(m) ? [m] : [];
  });
 });
}
/** Whether a call reachable from `roots` invokes a `targets` binding (or a member of one). */
function reaches(roots: ts.FunctionLikeDeclaration[], targets: Set<string>): boolean {
 const reached = new Set<ts.Node>(roots), runs = new Map<ts.Node, Set<number>>();
 for (let grew = true; grew;) {
  grew = false;
  const reach = (v: Value) => { if (isFn(v) && !reached.has(v)) { reached.add(v); grew = true; } };
  for (const fn of [...reached] as ts.FunctionLikeDeclaration[]) for (const call of liveCalls(fn)) for (const v of values(call.expression, targets)) {
   if (v === 'target') return true;
   if (!isNode(v)) { const s = runs.get(v.fn) ?? new Set(); if (!s.has(v.index)) { runs.set(v.fn, s.add(v.index)); grew = true; } continue; }
   reach(v);
   for (const i of runs.get(v) ?? []) if (call.arguments[i]) values(call.arguments[i]!, targets).forEach(reach);
  }
 }
 return false;
}
const chain = (e: ts.Expression): string[] | undefined => ts.isIdentifier(e) ? [e.text] : ts.isPropertyAccessExpression(e) ? chain(e.expression)?.concat(e.name.text) : undefined;
/** The callbacks of the vitest tests that run: registered at the top level or in a describe, with no modifier but concurrent or
 * sequential, a name, a parameterless callback and at most a numeric timeout. A file with an `only` registration gives none. */
function enabledTests(sf: ts.SourceFile): ts.FunctionLikeDeclaration[] {
 const vitest = new Map<string, string>();
 for (const s of sf.statements) if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text === 'vitest' && s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings))
  for (const e of s.importClause.namedBindings.elements) vitest.set(e.name.text, (e.propertyName ?? e.name).text);
 const kind = (names?: string[]) => names && ['it', 'test', 'describe'].includes(vitest.get(names[0]!) ?? '') ? vitest.get(names[0]!) : undefined;
 let only = false;
 visit(sf, (n) => { if (ts.isCallExpression(n)) { const names = chain(n.expression); if (kind(names) && names!.includes('only')) only = true; } });
 const tests: ts.FunctionLikeDeclaration[] = [];
 const walk = (ss: readonly ts.Statement[]) => {
  for (const s of ss) {
   const c = ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) ? s.expression : undefined, names = c && chain(c.expression), k = kind(names);
   const [, fn, ...rest] = c?.arguments ?? [];
   if (c && k && names!.slice(1).every((m) => m === 'concurrent' || m === 'sequential') && fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !fn.parameters.length && rest.length <= 1 && rest.every(ts.isNumericLiteral)) {
    if (k !== 'describe') tests.push(fn);
    else if (ts.isBlock(fn.body)) walk(fn.body.statements);
   }
   if (ends(s)) return;
  }
 };
 walk(sf.statements);
 return only ? [] : tests;
}
/** The local names a source binds at its top level to the module at `target`: a static import or a const `await import('…')` of a relative path; `only` narrows to one named export. */
function bindingsOf(root: string, rel: string, sf: ts.SourceFile, target: string, only?: string): Set<string> {
 const names = new Set<string>();
 const hits = (spec?: string) => spec !== undefined && spec.startsWith('.') && resolve(root, rel, '..', spec) === join(root, target);
 const addPattern = (name: ts.BindingName) => { if (ts.isIdentifier(name)) names.add(name.text); else for (const e of name.elements) if (ts.isBindingElement(e)) addPattern(e.name); };
 for (const s of sf.statements) {
  if (ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier) && hits(s.moduleSpecifier.text)) {
   const c = s.importClause;
   if (!c || c.isTypeOnly) continue;
   if (only === undefined && c.name) names.add(c.name.text);
   const nb = c.namedBindings;
   if (nb && ts.isNamespaceImport(nb) && only === undefined) names.add(nb.name.text);
   if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly && (only === undefined || (e.propertyName ?? e.name).text === only)) names.add(e.name.text);
  }
  if (only === undefined && ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const) for (const d of s.declarationList.declarations) {
   let e = d.initializer;
   while (e && (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
   if (e && ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword && e.arguments[0] && ts.isStringLiteralLike(e.arguments[0]) && hits(e.arguments[0].text)) addPattern(d.name);
  }
 }
 return names;
}

/** Why a route's evidence does not show it driven, empty when it does. `tracked` is injectable for a synthetic tree. */
function evidenceProblems(root: string, route: string, ev: Evidence, tracked: (rel: string) => boolean = (rel) => gitTracked(root, rel)): string[] {
 const bad = (why: string) => [`${route}: ${why}`];
 if (!tracked(ev.test) || !existsSync(join(root, ev.test))) return bad(`${ev.test} is not a tracked file`);
 const sf = parseTs(root, ev.test);
 if (ev.kind === 'smoke') {
  if (ev.test !== SMOKE) return bad(`smoke evidence must be ${SMOKE}`);
  let named = false;
  visit(sf, (n) => { if (ts.isStringLiteralLike(n) && n.text === route) named = true; });
  return named ? [] : bad(`${ev.test} holds no string literal ${route} outside comments`);
 }
 if (ev.kind !== 'unit' && ev.kind !== 'component') return bad(`unknown evidence kind ${ev.kind}`);
 if (!ev.test.endsWith('.test.ts')) return bad(`${ev.test} is not a test file`);
 if (!ev.module || !existsSync(join(root, ev.module))) return bad(`module ${ev.module} does not exist`);
 if (!ev.module.startsWith(`deploy/client/routes${route}/`)) return bad(`${ev.module} is not under the route`);
 let drivers: Set<string>;
 if (ev.via) {
  if (!tracked(ev.via.file) || !existsSync(join(root, ev.via.file))) return bad(`${ev.via.file} is not a tracked file`);
  const harness = parseTs(root, ev.via.file);
  const mod = bindingsOf(root, ev.via.file, harness, ev.module);
  const entry: ts.FunctionLikeDeclaration[] = [];
  for (const s of harness.statements) {
   if (!(ts.canHaveModifiers(s) ? ts.getModifiers(s) : undefined)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
   if (ts.isFunctionDeclaration(s) && s.name?.text === ev.via.export) entry.push(s);
   if (ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.Const) for (const d of s.declarationList.declarations) if (ts.isIdentifier(d.name) && d.name.text === ev.via.export && d.initializer) entry.push(...values(d.initializer, mod).filter(isFn));
  }
  if (!reaches(entry, mod)) return bad(`${ev.via.file} does not import ${ev.module} and use it in its exported ${ev.via.export}: no reachable call there invokes a handler of it`);
  drivers = bindingsOf(root, ev.test, sf, ev.via.file, ev.via.export);
 } else drivers = bindingsOf(root, ev.test, sf, ev.module);
 if (!drivers.size) return bad(`${ev.test} does not import ${ev.via ? `${ev.via.export} from ${ev.via.file}` : ev.module}`);
 return reaches(enabledTests(sf), drivers) ? [] : bad(`no enabled test in ${ev.test} reaches a call of ${[...drivers].join(', ')}`);
}

describe('hosted forms are declared, with a reason the suite checks', () => {
 const app = join(import.meta.dirname, '..', '..', '..');
 const found: string[] = hostedForms(app);
 const declaredRoutes = Object.keys(declared.HOSTED_FORMS ?? {});
 test('discovery finds the hosted sign-in, sign-out and case-list forms', () => {
  expect(found).toEqual(expect.arrayContaining(SMOKE_ROUTES));
 });
 test('discovery finds exactly the hosted sign-in, operator sign-in, sign-out, case-list, notes, chronology filter and intake forms', () => {
  expect(found).toEqual(['/cases', '/cases/[caseId]/notes', '/cases/[caseId]/views/[resultsVersion]/chronology', '/client/intake/[caseId]', '/sign-in', '/sign-in/operator', '/sign-out']);
 });
 test('every hosted form is declared and every declaration names a form discovery finds', () => {
  expect(declaredRoutes.sort()).toEqual(found);
  expect(Object.keys(declared.HOSTED_FORM_EVIDENCE).sort()).toEqual(found);
  for (const route of declaredRoutes) expect(declared.HOSTED_FORMS[route].length).toBeGreaterThan(20);
 });
 test('the hosted smoke run drives each declared route', () => {
  for (const route of SMOKE_ROUTES) {
   expect(declared.HOSTED_FORMS[route], `${route} is declared`).toBeTruthy();
   expect(declared.HOSTED_FORM_EVIDENCE[route], `${route} stays smoke-bound, not relabelled`).toEqual({ kind: 'smoke', test: SMOKE });
   expect(evidenceProblems(app, route, declared.HOSTED_FORM_EVIDENCE[route])).toEqual([]);
  }
 });
 test('the other declared routes are driven by tracked unit or component tests, labelled as that and never as browser or workerd proof', () => {
  const others = declaredRoutes.filter((r) => !SMOKE_ROUTES.includes(r));
  expect(others).toHaveLength(4);
  for (const route of others) {
   const ev: Evidence = declared.HOSTED_FORM_EVIDENCE[route];
   expect(['unit', 'component'], `${route} is labelled ${ev.kind}`).toContain(ev.kind);
   expect(declared.HOSTED_FORMS[route], `${route}: the reason names its ${ev.kind} evidence`).toMatch(new RegExp(`\\b${ev.kind}\\b`));
   expect(declared.HOSTED_FORMS[route], `${route}: a unit or component reason does not cite test:hosted or workerd as its proof`).not.toMatch(/test:hosted|on workerd/);
   expect(evidenceProblems(app, route, ev)).toEqual([]);
  }
 });
 test('discovery reads a form from a page and from exported actions, and ignores a page with neither', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-hosted-'));
  const put2 = (rel: string, text: string) => { const f = join(dir, 'deploy', 'client', 'routes', rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };
  put2('a/+page.svelte', '<form method="POST"></form>');
  put2('b/+page.svelte', '<p>b</p>');
  put2('b/+page.server.ts', 'export const actions = {};');
  put2('c/+page.svelte', '<p>c</p>');
  put2('c/+server.ts', 'export const GET = () => new Response();');
  put2('d/[id]/+page.svelte', '<form action="/x"></form>');
  try { expect(hostedForms(dir)).toEqual(['/a', '/b', '/d/[id]']); } finally { rmSync(dir, { recursive: true, force: true }); }
 });
});

describe('hosted form evidence is refused when its driving setup is gone', () => {
 const app = join(import.meta.dirname, '..', '..', '..');
 const real = (route: string): Evidence => declared.HOSTED_FORM_EVIDENCE[route];
 const UNIT_AND_COMPONENT = Object.keys(declared.HOSTED_FORM_EVIDENCE ?? {}).filter((r) => !SMOKE_ROUTES.includes(r)).sort();
 const always = () => true;
 // a copy of the files one real entry cites, so a mutation never touches the checkout
 const copyOf = (route: string) => {
  const ev = real(route), dir = mkdtempSync(join(root, 'evidence-'));
  for (const rel of [ev.test, ev.via?.file, ev.module]) if (rel) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); copyFileSync(join(app, rel), join(dir, rel)); }
  return { ev, dir, set: (rel: string, text: string) => writeFileSync(join(dir, rel), text), read: (rel: string) => readFileSync(join(dir, rel), 'utf8') };
 };
 test('the git check sees a tracked file and refuses an untracked path', () => {
  expect(gitTracked(app, 'tests/hosted-smoke/intake/harness.ts')).toBe(true);
  expect(gitTracked(app, 'tests/hosted-smoke/intake/not-a-file.test.ts')).toBe(false);
 });
 test.each(UNIT_AND_COMPONENT)('%s: a copy of the real evidence passes, and loses it when the file that drives it is reduced to a comment naming the route', (route) => {
  const { ev, dir, set } = copyOf(route);
  expect(evidenceProblems(dir, route, ev, always)).toEqual([]);
  set(ev.via?.file ?? ev.test, `// ${ev.module}\n// ${route}\n`);
  expect(evidenceProblems(dir, route, ev, always)).not.toEqual([]);
 });
 test.each(UNIT_AND_COMPONENT)('%s: the cited evidence is refused once its import of the route module is gone', (route) => {
  const { ev, dir, set, read } = copyOf(route);
  const file = ev.via?.file ?? ev.test, cut = ev.module!.split('/').slice(-1)[0];
  set(file, read(file).replaceAll(cut, 'other.ts'));
  expect(evidenceProblems(dir, route, ev, always)).not.toEqual([]);
 });
 test.each(UNIT_AND_COMPONENT)('%s: the cited evidence is refused once every test returns before its body', (route) => {
  const { ev, dir, set, read } = copyOf(route);
  const registration = /\bit\('(?:[^'\\]|\\.)*', async \(\) => \{/g;
  expect(read(ev.test).match(registration)?.length, `${ev.test} registers its tests as it('…', async () => {`).toBeGreaterThan(0);
  set(ev.test, read(ev.test).replace(registration, '$& return;'));
  expect(evidenceProblems(dir, route, ev, always)).not.toEqual([]);
 });
 test('the intake harness is refused when its dispatch keeps the route imports but calls no handler', () => {
  const route = '/client/intake/[caseId]', { ev, dir, set, read } = copyOf(route), file = ev.via!.file;
  const cut = read(file).replace(/export async function dispatch[\s\S]*$/, 'export async function dispatch(): Promise<Response> { void list; void one; return new Response(null, { status: 405 }); }\n');
  expect(cut).toContain('void list');
  set(file, cut);
  expect(evidenceProblems(dir, route, ev, always).join('\n')).toMatch(/does not import .*submissions\/\+server\.ts and use it in its exported dispatch/);
 });
 test('the intake harness reduced to only the route comment is refused, whatever the test around it still does', () => {
  const route = '/client/intake/[caseId]', { ev, dir, set } = copyOf(route);
  set(ev.via!.file, '// deploy/client/routes/client/intake\n');
  expect(evidenceProblems(dir, route, ev, always).join('\n')).toMatch(/does not import .*submissions\/\+server\.ts and use it in its exported dispatch/);
 });

 // synthetic trees for the shapes a real file cannot be mutated into without breaking its own tests
 const ROUTE = '/r', MODULE = 'deploy/client/routes/r/+page.server.ts', T = 'tests/r.test.ts', H = 'tests/harness.ts';
 const put3 = (files: Record<string, string>) => { const dir = mkdtempSync(join(root, 'synthetic-')); for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); } return dir; };
 const MOD = { [MODULE]: 'export const load = () => 1;' };
 const DIRECT: Evidence = { kind: 'unit', test: T, module: MODULE };
 const VIA: Evidence = { kind: 'component', test: T, module: MODULE, via: { file: H, export: 'dispatch' } };
 const HARNESS = "import * as r from '../deploy/client/routes/r/+page.server.ts';\nexport const compose = () => 0;\nexport async function dispatch() { return r.load(); }\n";
 const TABLE_HARNESS = (guard: string, tail: string) => `import * as r from '../deploy/client/routes/r/+page.server.ts';\nexport async function dispatch(method: string) {\n const handlers: Record<string, (() => unknown) | undefined> = method === 'GET' ? { GET: r.load } : { PUT: r.load };\n const h = handlers[method];\n ${guard}\n ${tail}\n}\n`;
 const viaTest = (body: string) => `import { describe, it } from 'vitest';\nimport { compose, dispatch } from './harness.ts';\n${body}`;
 const directTest = (body: string, head = "import { it } from 'vitest';\nimport { load } from '../deploy/client/routes/r/+page.server.ts';\n") => head + body;
 const cases: [string, Evidence, Record<string, string>, boolean][] = [
  ['a static import called inside a test', DIRECT, { ...MOD, [T]: directTest("it('x', () => load());") }, true],
  ['an awaited dynamic import called through its namespace', DIRECT, { ...MOD, [T]: "import { it } from 'vitest';\nconst r = await import('../deploy/client/routes/r/+page.server.ts');\nit('x', () => r.load!());" }, true],
  ['a call reached through a top-level helper', DIRECT, { ...MOD, [T]: directTest("const go = () => load();\nit('x', () => { go(); });") }, true],
  ['a harness export that uses the route, called from a test', VIA, { ...MOD, [H]: HARNESS, [T]: viaTest("it('x', async () => { await dispatch(); });") }, true],
  ['a test file reduced to a comment naming the module', DIRECT, { ...MOD, [T]: `// ${MODULE}\n// load()\n` }, false],
  ['the call only in a comment', DIRECT, { ...MOD, [T]: directTest("// load();\nit('x', () => 1);") }, false],
  ['the import removed while the call remains', DIRECT, { ...MOD, [T]: "import { it } from 'vitest';\nit('x', () => load());" }, false],
  ['an import of another module', DIRECT, { ...MOD, [T]: "import { it } from 'vitest';\nimport { load } from '../deploy/client/routes/other/+page.server.ts';\nit('x', () => load());" }, false],
  ['the import never called', DIRECT, { ...MOD, [T]: directTest("it('x', () => 1);") }, false],
  ['a call outside every test', DIRECT, { ...MOD, [T]: directTest('load();') }, false],
  ['a call in a skipped test', DIRECT, { ...MOD, [T]: directTest("it.skip('x', () => load());") }, false],
  ['a call in a todo test', DIRECT, { ...MOD, [T]: directTest("test.todo('x', () => load());", "import { test } from 'vitest';\nimport { load } from '../deploy/client/routes/r/+page.server.ts';\n") }, false],
  ['a call under a skipped describe', DIRECT, { ...MOD, [T]: directTest("describe.skip('d', () => { it('x', () => load()); });", "import { describe, it } from 'vitest';\nimport { load } from '../deploy/client/routes/r/+page.server.ts';\n") }, false],
  ['a helper that is never called from a test', DIRECT, { ...MOD, [T]: directTest("const go = () => load();\nit('x', () => 1);") }, false],
  ['a harness reduced to a comment', VIA, { ...MOD, [H]: `// ${MODULE}\n`, [T]: viaTest("it('x', async () => { await dispatch(); });") }, false],
  ['a harness that imports the route but whose dispatch does not use it', VIA, { ...MOD, [H]: "import * as r from '../deploy/client/routes/r/+page.server.ts';\nexport const keep = r;\nexport async function dispatch() { return 1; }\n", [T]: viaTest("it('x', async () => { await dispatch(); });") }, false],
  ['a harness with no dispatch export', VIA, { ...MOD, [H]: "import * as r from '../deploy/client/routes/r/+page.server.ts';\nexport const compose = () => r.load();\n", [T]: viaTest("it('x', () => 1);") }, false],
  ['a test that calls only another harness export', VIA, { ...MOD, [H]: HARNESS, [T]: viaTest("it('x', () => { compose(); });") }, false],
  ['a test that never calls the harness dispatch', VIA, { ...MOD, [H]: HARNESS, [T]: viaTest("it('x', () => 1);") }, false],
  // only a call on a reachable path from an enabled vitest test callback counts: a call behind any condition does not, nor
  // does one after a statement that may end the function (an opaque or named condition, a loop, a local function that may
  // throw), and an unsupported shape is refused
  ['a call through a helper that runs its callback', DIRECT, { ...MOD, [T]: directTest("const outcome = async (f: () => unknown) => { try { return { value: await f() }; } catch (e) { return { thrown: e }; } };\nit('x', async () => { await outcome(() => load()); });") }, true],
  ['a call after an early return behind an opaque condition', DIRECT, { ...MOD, [T]: directTest("it('x', () => { if (Date.now() < 0) return; load(); });") }, false],
  ['a call after a return behind a named constant', DIRECT, { ...MOD, [T]: directTest("const off = true;\nit('x', () => { if (off) return; load(); });") }, false],
  ['a call after a throw behind a named constant', DIRECT, { ...MOD, [T]: directTest("const off = true;\nit('x', () => { if (off) throw new Error('off'); load(); });") }, false],
  ['a call after a try block that may return', DIRECT, { ...MOD, [T]: directTest("const off = true;\nit('x', () => { try { if (off) return; } finally { void 0; } load(); });") }, false],
  ['a call after a literal infinite loop', DIRECT, { ...MOD, [T]: directTest("it('x', () => { while (true) { void 0; } load(); });") }, false],
  ['a call after a short circuit into a throwing function', DIRECT, { ...MOD, [T]: directTest("const off = true;\nit('x', () => { off && (() => { throw new Error('off'); })(); load(); });") }, false],
  ['a call after a local helper that may throw', DIRECT, { ...MOD, [T]: directTest("const stop = () => { throw new Error('stop'); };\nit('x', () => { stop(); load(); });") }, false],
  ['a call after a local helper whose body is an infinite loop', DIRECT, { ...MOD, [T]: directTest("const stop = () => { while (true) {} };\nit('x', () => { stop(); load(); });") }, false],
  ['a call chosen only by a dead nullish operand: the first value is never nullish', DIRECT, { ...MOD, [T]: directTest("it('x', () => { const noop = () => 1; const h = noop ?? load; h(); });") }, false],
  ['a call chosen only by the dead arm of a literal conditional', DIRECT, { ...MOD, [T]: directTest("it('x', () => { const h = true ? () => 1 : load; h(); });") }, false],
  ['a call after an unconditional return', DIRECT, { ...MOD, [T]: directTest("it('x', () => { return; load(); });") }, false],
  ['a call after a return behind a literal true condition', DIRECT, { ...MOD, [T]: directTest("it('x', () => { if (true) return; load(); });") }, false],
  ['a call only in a nested function the test never calls', DIRECT, { ...MOD, [T]: directTest("it('x', () => { const later = () => load(); });") }, false],
  ['a call only in a callback a helper never runs', DIRECT, { ...MOD, [T]: directTest("const keep = (f: () => unknown) => f;\nit('x', () => { keep(() => load()); });") }, false],
  ['a called helper that only registers a skipped test', DIRECT, { ...MOD, [T]: directTest("const go = () => { it.skip('y', () => load()); };\nit('x', () => { go(); });") }, false],
  ['a call in a test disabled by runIf(false)', DIRECT, { ...MOD, [T]: directTest("it.runIf(false)('x', () => load());") }, false],
  ['a call in a test skipped by its options', DIRECT, { ...MOD, [T]: directTest("it('x', { skip: true }, () => load());") }, false],
  ['a call in a test that takes its context, which can skip it', DIRECT, { ...MOD, [T]: directTest("it('x', (ctx) => { ctx.skip(); load(); });") }, false],
  ['a call behind a condition', DIRECT, { ...MOD, [T]: directTest("it('x', () => { if (Date.now() < 0) load(); });") }, false],
  ['a call in a test while another test in the file is only', DIRECT, { ...MOD, [T]: directTest("it('x', () => load());\nit.only('y', () => 1);") }, false],
  ['a call only of a member every function has', DIRECT, { ...MOD, [T]: directTest("it('x', () => { load.bind(null); load.toString(); });") }, false],
  ['a call in a test registered by a local it, not vitest', DIRECT, { ...MOD, [T]: "import { load } from '../deploy/client/routes/r/+page.server.ts';\nconst it = (_n: string, _f: () => unknown) => {};\nit('x', () => load());" }, false],
  ['a harness dispatch that calls its route handler through a handler table', VIA, { ...MOD, [H]: TABLE_HARNESS('', 'return h!();'), [T]: viaTest("it('x', async () => { await dispatch('GET'); });") }, true],
  ['a harness dispatch that calls its table handler or a pure fallback, unconditionally', VIA, { ...MOD, [H]: TABLE_HARNESS("const methodNotAllowed = async () => new Response(null, { status: 405 });", 'return (h ?? methodNotAllowed)();'), [T]: viaTest("it('x', async () => { await dispatch('GET'); });") }, true],
  ['a harness dispatch that calls only the fallback of an opaque choice', VIA, { ...MOD, [H]: "import * as r from '../deploy/client/routes/r/+page.server.ts';\nconst methodNotAllowed = async () => new Response(null, { status: 405 });\nexport async function dispatch(h?: () => unknown) { void r; return (h ?? methodNotAllowed)(); }\n", [T]: viaTest("it('x', async () => { await dispatch(); });") }, false],
  ['a harness dispatch whose handler call follows an opaque early return', VIA, { ...MOD, [H]: TABLE_HARNESS('if (!h) return new Response(null, { status: 405 });', 'return h();'), [T]: viaTest("it('x', async () => { await dispatch('GET'); });") }, false],
  ['a harness dispatch that only mentions the route and answers 405', VIA, { ...MOD, [H]: "import * as r from '../deploy/client/routes/r/+page.server.ts';\nexport async function dispatch() { void r; return new Response(null, { status: 405 }); }\n", [T]: viaTest("it('x', async () => { await dispatch(); });") }, false],
  ['a harness dispatch that builds the handler table but never calls a handler', VIA, { ...MOD, [H]: TABLE_HARNESS('', 'return new Response(null, { status: h ? 200 : 405 });'), [T]: viaTest("it('x', async () => { await dispatch('GET'); });") }, false],
  ['a harness dispatch that calls the route only after its return', VIA, { ...MOD, [H]: "import * as r from '../deploy/client/routes/r/+page.server.ts';\nexport async function dispatch() { return new Response(null, { status: 405 }); r.load(); }\n", [T]: viaTest("it('x', async () => { await dispatch(); });") }, false],
 ];
 test.each(cases)('%s', (_name, ev, files, ok) => {
  const problems = evidenceProblems(put3(files), ROUTE, ev, always);
  if (ok) expect(problems).toEqual([]); else expect(problems).not.toEqual([]);
 });
 test('a harness is not a test: citing it as the test is refused even when it drives the route', () => {
  const dir = put3({ ...MOD, [H]: HARNESS });
  expect(evidenceProblems(dir, ROUTE, { kind: 'unit', test: H, module: MODULE }, always).join()).toMatch(/is not a test file/);
 });
 test('an untracked file is refused, and so is a module outside the route', () => {
  const dir = put3({ ...MOD, [T]: directTest("it('x', () => load());") });
  expect(evidenceProblems(dir, ROUTE, DIRECT, () => false).join()).toMatch(/not a tracked file/);
  expect(evidenceProblems(dir, '/elsewhere', DIRECT, always).join()).toMatch(/not under the route/);
 });
 test('smoke evidence names the route in code, not in a comment, and only in the pinned smoke run', () => {
  const smoke = { kind: 'smoke', test: SMOKE };
  expect(evidenceProblems(put3({ [SMOKE]: "check(await form('/sign-in', {}));" }), '/sign-in', smoke, always)).toEqual([]);
  expect(evidenceProblems(put3({ [SMOKE]: "// '/sign-in'\n" }), '/sign-in', smoke, always)).not.toEqual([]);
  expect(evidenceProblems(put3({ [SMOKE]: "check(await form('/sign-out', {}));" }), '/sign-in', smoke, always)).not.toEqual([]);
  expect(evidenceProblems(put3({ 'tests/other.ts': "form('/sign-in');" }), '/sign-in', { kind: 'smoke', test: 'tests/other.ts' }, always).join()).toMatch(/must be/);
 });
});
