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
		expect(cover('timeline', 'export.print_pdf.print.text', 'value', 'Skip to content Shell Chronology & Timeline Phase one Event A', 'Chronology & Timeline Phase one Event A')).toBe('IDR-168');
		// with the analysis additions off (GRS-48) the app prints v5's heading, so the navigation label in its place is unregistered
		expect(cover('timeline', 'export.print_pdf.print.text', 'value', 'Skip to content Shell Chronology & Timeline Phase one Event A', 'Timeline Phase one Event A')).toBeNull();
		expect(byId('IDR-168').type).toBe('known-gap');
	});

	it('pins the Defence table and CSV columns to v5\'s, leaving a refs column anywhere unregistered while the analysis additions are off (GRS-48)', () => {
		for (const [path, v5] of [['table.table_1.columns', 'dcs_point | dcs_case | ess_supporting_evidence | documents | ess_rebuttal'], ['export.export_csv.columns', 'dcs_point | dcs_case | ess_evidence | documents | rebuttal']] as const) {
			const cols = v5.split(' | ');
			expect(cover('vdm_matrix_tab', path, 'value', v5, `${v5} | refs`)).toBeNull();
			expect(cover('vdm_matrix_tab', path, 'value', v5, [cols[1], cols[0], ...cols.slice(2), 'refs'].join(' | '))).toBeNull();
			expect(cover('vdm_matrix_tab', path, 'value', v5, ['refs', ...cols].join(' | '))).toBeNull();
		}
		expect(cover('vdm_matrix_tab', 'table.table_1.col.refs', 'app-only', '<absent>', 'Refs')).toBeNull();
		for (const path of ['table.table_1.row.r0.refs', 'export.export_csv.row.r0.refs']) expect(cover('vdm_matrix_tab', path, 'app-only', '<absent>', 'OD-001 – OD-002')).toBeNull();
	});

	it('leaves a navigation-label heading unregistered on the three views that keep v5\'s heading while the analysis additions are off (GRS-48)', () => {
		expect(cover('timeline', 'title', 'value', 'Chronology & Timeline', 'Timeline')).toBeNull();
		expect(cover('vdm_matrix_tab', 'title', 'value', 'Defence & Rebuttal Matrix', 'Defence & Rebuttal')).toBeNull();
		expect(cover('info_required_tab', 'title', 'value', 'Information & Documents Required', 'Info Required')).toBeNull();
	});

	it('names an owner on the known gaps', () => {
		// CC-05's own harness-capture gap, plus the GRS-67 source-defect dispositions, each with the owner that would close it
		expect(entries.filter((e) => e.type === 'known-gap' && !e.owner)).toEqual([]);
		expect(entries.find((e) => e.id === 'IDR-168')).toMatchObject({ type: 'known-gap', owner: 'GRS-15' });
		// v5's missing refs and its Timeline heading return while CLEARCASE_ANALYSIS_ADDITIONS is off (GRS-48)
		for (const source of ['S-vdm_matrix_tab-1', 'S-timeline-4']) {
			expect(entries.filter((e) => e.source === source)).toMatchObject([{ field: [], type: 'known-gap', owner: 'GRS-15' }]);
			expect(entries.find((e) => e.source === source)!.reason).toContain('CLEARCASE_ANALYSIS_ADDITIONS');
		}
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
