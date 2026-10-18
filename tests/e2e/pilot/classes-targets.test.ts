// The UI class suite's discovery (GRS-59) on a synthetic source tree: what it finds as a CSV producer, a leave guard, and
// what it refuses to leave unrecognised.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
// @ts-expect-error plain .mjs
import { csvExports, hasLeaveGuard } from '../classes/targets.mjs';

const root = mkdtempSync(join(tmpdir(), 'cc-targets-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text: string) => { const f = join(root, 'src', rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text); };

describe('csvExports', () => {
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
 test('imports of non-code files and packages are not consumers to refuse', () => {
  const dir = build({
   'routes/direct/+page.svelte': "<script>import Maker from '$lib/Maker.svelte'; import raw from '$lib/x.css?raw'; import { page } from '$app/state'; import z from 'zod'; import d from './data.json';</script><Maker />",
   'routes/direct/data.json': '{}',
   'lib/Maker.svelte': MAKER,
  });
  expect(csvExports(dir)).toEqual({ pages: ['/direct'], servers: [], unrecognised: [], declaredButCsv: [] });
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
