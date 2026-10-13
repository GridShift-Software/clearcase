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
