// CC-05 register entries cover only the intended difference (GRS-15, CC-05 r2): synthetic wrong app values that the
// earlier, broader entries accepted are unregistered now, and the timeline adapters compare titles, link labels and
// printed content against the unescaped v5 value. Synthetic values only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { covering, type Entry } from '../../scripts/parity/lib/compare.mjs';
// @ts-expect-error the v5 spec is plain JavaScript without a declaration file
import * as spec from '../../scripts/parity/adapters/v5/specs/timeline.mjs';

type Page = { main: string; heading: string };
const { eventValues, fromMain, printValues, unescapeOnce } = spec as {
	eventValues: (phases: unknown[], o?: { unescape?: boolean }) => Record<string, string>;
	fromMain: (text: string, page: Page) => string | null;
	printValues: (print: { prints: number; text: string }, page: Page, o?: { unescape?: boolean }) => { prints: string; content: string };
	unescapeOnce: (s: string) => string;
};

const entries = (JSON.parse(readFileSync(new URL('../../docs/reference/parity/register/CC-05.json', import.meta.url), 'utf8')) as { entries: Entry[] }).entries;
const byId = (id: string) => entries.find((e) => e.id === id)!;
const cover = (view: string, path: string, kind: string, v5: string, app: string) => covering(entries, view, { path, kind, v5, app })?.id ?? null;

describe('CC-05 register: no entry masks a wrong app value', () => {
	it('leaves a wrong or missing timeline title unregistered, and covers only the record that v5 showed an entity', () => {
		expect(cover('timeline', 'sweep.timeline_events.p0.e0.title', 'value', 'Alpha & Beta letter', 'An unrelated title')).toBeNull();
		expect(cover('timeline', 'sweep.timeline_events.p0.e0.title', 'value', 'Alpha &amp; Beta letter', 'An unrelated title')).toBeNull();
		expect(cover('timeline', 'sweep.timeline_events.p0.e0.title', 'v5-only', 'Alpha &amp; Beta letter', '<absent>')).toBeNull();
		expect(cover('timeline', 'sweep.timeline_events.p0.e0.escaped', 'value', 'twice', 'once')).toBe('IDR-167');
		expect(cover('timeline', 'sweep.timeline_events.p0.e0.escaped', 'value', 'once', 'twice')).toBeNull();
	});

	it('leaves a spurious app-only link and a dropped v5 link unregistered', () => {
		expect(cover('timeline', "control.link:Spurious link's label ↗", 'app-only', '<absent>', '1')).toBeNull();
		expect(cover('timeline', 'control.link:Alpha &amp; Beta ↗', 'v5-only', '1', '<absent>')).toBeNull();
	});

	it('leaves a print capture still holding the app shell, and any printed-content difference, unregistered', () => {
		expect(cover('timeline', 'export.print_pdf.print.text', 'value', 'Skip to content Shell Chronology & Timeline Phase one Event A', 'Skip to content ClearCase Timeline (nothing)')).toBeNull();
		expect(cover('timeline', 'sweep.timeline_print.content', 'value', 'Phase one Event A Event B', 'Phase one')).toBeNull();
		expect(cover('timeline', 'export.print_pdf.print.text', 'value', 'Skip to content Shell Chronology & Timeline Phase one Event A', 'Timeline Phase one Event A')).toBe('IDR-168');
		expect(byId('IDR-168').type).toBe('known-gap');
	});

	it('pins the Defence table and CSV columns to v5 order with refs last', () => {
		for (const [id, path] of [['IDR-157', 'table.table_1.columns'], ['IDR-169', 'export.export_csv.columns']] as const) {
			const v5 = byId(id).when!.v5 as string;
			const cols = v5.split(' | ');
			expect(cover('vdm_matrix_tab', path, 'value', v5, `${v5} | refs`)).toBe(id);
			expect(cover('vdm_matrix_tab', path, 'value', v5, [cols[1], cols[0], ...cols.slice(2), 'refs'].join(' | '))).toBeNull();
			expect(cover('vdm_matrix_tab', path, 'value', v5, ['refs', ...cols].join(' | '))).toBeNull();
		}
	});

	it('names an owner on the known gaps', () => {
		expect(entries.filter((e) => e.type === 'known-gap').map((e) => [e.id, e.owner])).toEqual([['IDR-168', 'GRS-15']]);
	});
});

describe('timeline adapters compare against the unescaped v5 value', () => {
	it('unescapes once, never twice', () => {
		expect(unescapeOnce('A &amp; B &#39;x&#39; &lt;y&gt; &quot;z&quot; &#x41; &amp;amp;')).toBe('A & B \'x\' <y> "z" A &amp;');
	});

	it('gives the v5 side unescaped titles and records which labels showed an entity', () => {
		const ev = (title: string) => ({ label: '2090', title: 'Phase', empty: false, events: [{ date: '2090-01-01', kind: 'Letter', ref: 'OD-001', title, note: '', link: 'link' }] });
		expect(eventValues([ev('Alpha &amp; Beta')], { unescape: true })).toMatchObject({ 'p0.e0.title': 'Alpha & Beta', 'p0.e0.escaped': 'twice' });
		expect(eventValues([ev('Alpha & Beta')])).toMatchObject({ 'p0.e0.title': 'Alpha & Beta', 'p0.e0.escaped': 'once' });
		// an app that escaped twice would differ on the title itself
		expect(eventValues([ev('Alpha &amp; Beta')])['p0.e0.title']).toBe('Alpha &amp; Beta');
	});

	it('reads a print capture from the page main on, after the heading', () => {
		const page = { main: 'Timeline Sub Phase one Event A', heading: 'Timeline' };
		expect(fromMain('Skip to content Shell Timeline\nTimeline Sub\nPhase one Event A', page)).toBe('Timeline Sub Phase one Event A');
		expect(printValues({ prints: 1, text: 'Shell Timeline\nTimeline Sub\nPhase one Event &amp; A' }, { ...page, main: 'Timeline Sub Phase one Event &amp; A' }, { unescape: true })).toEqual({ prints: '1', content: 'Sub Phase one Event & A' });
		expect(printValues({ prints: 1, text: 'Shell only' }, page).content).toBe('(main not in the print capture)');
	});
});
