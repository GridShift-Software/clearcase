// Shared contracts for M2 view owners: the generated 42-entry registry, routes, titles, citations, formatting, CSV.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { citationResolver, citedRefs, narrativeHtml } from './cite.ts';
import { csvCell, toCSV, userCell } from './csv.ts';
import { dateBasis, fmtR, money } from './format.ts';
import { caseName, pageTitle } from './titles.ts';
import { CATEGORIES, VIEWS, blockedBy, grouped, isAvailable, viewAt, viewById, viewHref } from './views.ts';

const root = path.join(import.meta.dirname, '..', '..', '..');
const inventory = JSON.parse(readFileSync(path.join(root, 'docs', 'plan', 'view-coverage.json'), 'utf8')) as { views: { id: string; label: string; group: string; owner: string }[] };
const RV = 'sha256:' + 'ab'.repeat(32);

/**
 * An M2 view's registry entry: under its owner's category, unavailable until its owner's gate (blocked by that ticket)
 * or available once the owner has flipped it, so the check holds before and after each owner's gate.
 */
function expectOwnerView(v: (typeof VIEWS)[number]) {
	expect(v.category).not.toBeNull();
	expect(CATEGORIES[v.category!].owner).toBe(v.owner);
	expect(v.route).toBe(`/${v.category}/${v.id}`);
	expect([`unavailable-until:${v.linear}`, 'available']).toContain(v.status);
	expect(isAvailable(v)).toBe(v.status === 'available');
	expect(blockedBy(v)).toBe(v.status === 'available' ? null : v.linear);
}

describe('view registry', () => {
	it('an M2 view flipped to available after its gate (synthetic) still passes; another owner\'s ticket or status does not', () => {
		const v = VIEWS.find((x) => x.id === 'timeline')!;
		expectOwnerView({ ...v, status: `unavailable-until:${v.linear}` });
		expectOwnerView({ ...v, status: 'available' });
		expect(() => expectOwnerView({ ...v, status: 'unavailable-until:GRS-99' } as typeof v)).toThrow();
		expect(() => expectOwnerView({ ...v, status: 'retired' } as unknown as typeof v)).toThrow();
	});
	it('has the 42 inventory entries in order, with their labels, groups and owners', () => {
		expect(VIEWS.map((v) => [v.id, v.label, v.group, v.owner])).toEqual(inventory.views.map((v) => [v.id, v.label, v.group, v.owner]));
		expect(VIEWS).toHaveLength(42);
	});
	it('routes every non-pilot view under its owner category and marks it unavailable until the owner passes', () => {
		const pilot = VIEWS.filter((v) => v.owner === 'CC-03');
		expect(pilot.map((v) => [v.id, v.route, v.status])).toEqual([['overview', '/overview', 'available'], ['chronology', '/chronology', 'available']]);
		for (const v of VIEWS.filter((x) => x.owner !== 'CC-03')) {
			expectOwnerView(v);
			expect(viewAt(v.category!, v.id)).toBe(v);
		}
		expect(new Set(VIEWS.map((v) => v.route)).size).toBe(42);
		expect(Object.keys(CATEGORIES).sort()).toEqual(['analysis', 'bundles', 'evidence', 'litigation', 'quantum', 'registers', 'system']);
		expect(viewAt('evidence', 'matter')).toBeUndefined();
		expect(viewHref(RV, viewById('search')!)).toBe(`/v/${encodeURIComponent(RV)}/evidence/search`);
		expect(grouped().map((g) => g.group)).toEqual(['Matter', 'Evidence', 'Case management', 'Analysis', 'Litigation strategy', 'Registers', 'System']);
	});
	it('is generated from the inventory (no drift)', () => {
		expect(() => execFileSync(process.execPath, [path.join(root, 'scripts', 'pilot', 'generate-view-registry.ts'), '--check'], { stdio: 'pipe' })).not.toThrow();
	});
});

describe('titles, citations and formatting', () => {
	it('builds case-, section- and document-aware titles', () => {
		expect(pageTitle({ section: 'Chronology', caseName: 'Case A' })).toBe('Chronology · Case A · ClearCase');
		expect(pageTitle({ section: 'Document', caseName: 'Case A', document: 'OD-001 Agreement' })).toBe('OD-001 Agreement · Document · Case A · ClearCase');
		expect(pageTitle({ section: 'People', caseName: 'Case A', status: 'not yet available' })).toBe('People (not yet available) · Case A · ClearCase');
		expect(caseName({ caseLabel: null, caseId: 'case-a' })).toBe('case-a');
	});
	it('links only citations that exist in the version, through renderNarrative, with safe app routes', () => {
		const text = 'See [[OD-001]] and [[OD-002#p3]]; [[ZZ-9]] is gone. <script>x()</script> [a](javascript:alert(1))';
		expect(citedRefs([text])).toEqual(['OD-001', 'OD-002', 'ZZ-9']);
		const html = narrativeHtml(text, RV, ['OD-001', 'OD-002']);
		const rv = encodeURIComponent(RV);
		expect(html).toContain(`href="/v/${rv}/doc/OD-001"`);
		expect(html).toContain(`href="/v/${rv}/doc/OD-002?page=3"`);
		expect(html).toContain('cite-broken');
		expect(html).not.toMatch(/<script|href="javascript:|<a [^>]*href="(?!\/v\/)/);
		expect(html).toContain('&lt;script&gt;'); // shown as text
		expect(citationResolver(RV, new Set(['A-1']))('B-2', null)).toBeNull();
	});
	it('formats money like v5 and states the date basis without inferring one', () => {
		expect([fmtR(1234567.5), fmtR(-5), fmtR('0'), money(''), money('abc')]).toEqual(['R 1 234 567.50', '-R 5.00', 'R 0.00', '', '']);
		expect(dateBasis({ date: '', dateType: null, dateSource: null })).toMatch(/^undated/);
		expect(dateBasis({ date: '2001-01-01', dateType: null, dateSource: null })).toMatch(/^basis unknown/);
		expect(dateBasis({ date: '2001-01-01', dateType: 'issued', dateSource: 'header' })).toBe('type issued, source header');
	});
	it('quotes CSV cells with quotes, commas, CR or LF, and neutralises formulas only in user-entered cells', () => {
		expect(toCSV([['a', 'b,c', 'd"e'], ['x\ry', ['p', 'q'], null]])).toBe('a,"b,c","d""e"\r\n"x\ry",p; q,');
		expect(csvCell('=SUM(A1)')).toBe('=SUM(A1)'); // imported values unchanged
		expect(userCell('=SUM(A1)')).toBe("'=SUM(A1)");
	});
});
