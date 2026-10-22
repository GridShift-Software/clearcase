import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import SupplementalAnalysis from '../../src/lib/views/analysis/SupplementalAnalysis.svelte';

describe('GRS-194 anchors and organogram rendering', () => {
	it('escapes source text and links only existing document refs, including supplied page targets', () => {
		const body = render(SupplementalAnalysis, { props: {
			resultsVersion: 'sha256:' + 'a'.repeat(64), known: ['OD-001'],
			anchors: [{ ref: 'OD-001', issue: '<script>bad()</script>', why: 'Reason', quote: '<img src=x onerror=bad()>', page: 2 }, { ref: 'ZZ-404', issue: 'Unknown source', why: 'Review' }],
			graph: { nodes: [{ id: 'a', label: '<img src=x>', refs: ['OD-001'] }, { id: 'b', label: 'Other node' }], edges: [{ from: 'a', to: 'b', label: 'Supplies' }, { from: 'a', to: 'missing', label: 'Unresolved' }] },
		} }).body;
		expect(body).toContain('Evidence anchors');
		expect(body).toContain('/doc/OD-001?page=2');
		expect(body).toContain('cite-broken');
		expect(body).not.toContain('/doc/ZZ-404');
		expect(body).not.toMatch(/<(script|img)\b/);
		expect(body).toContain('&lt;script>');
		expect(body).toContain('Supplies');
		expect(body).toContain('Unresolved');
		expect(body).toContain('missing or duplicate node');
		expect(body.match(/data-edge=/g)).toHaveLength(2);
	});
	it('adds no visible section to a results version without these datasets', () => {
		const body = render(SupplementalAnalysis, { props: { resultsVersion: 'v5', known: [], anchors: null, graph: null } }).body;
		expect(body).not.toContain('<section');
	});
});
