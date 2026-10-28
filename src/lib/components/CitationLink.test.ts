import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import CitationLink from './CitationLink.svelte';

const RV = 'sha256:' + 'd'.repeat(64);
const html = (props: Record<string, unknown>) => render(CitationLink, { props: { resultsVersion: RV, ref: 'SX-001', ...props } }).body;

describe('CitationLink title', () => {
	it('sets the title on the link only when one is given', () => {
		const titled = html({ title: 'SX-001 Invented letter.pdf' });
		expect(titled).toMatch(/<a class="cite" href="[^"]+" title="SX-001 Invented letter\.pdf">SX-001<\/a>/);
		for (const untitled of [html({}), html({ title: null })]) {
			expect(untitled).toMatch(/<a class="cite" href="[^"]+">SX-001<\/a>/);
			expect(untitled).not.toContain('title=');
		}
	});

	it('keeps imported text in the attribute, escaped, never as markup', () => {
		const out = html({ title: '"><img src=x onerror=alert(1)> & <b>bold</b>' });
		expect(out).not.toMatch(/<img|<b>/);
		expect(out).toContain('title="&quot;>&lt;img src=x onerror=alert(1)> &amp; &lt;b>bold&lt;/b>"');
	});

	it("keeps the broken ref's own title", () => {
		const broken = html({ exists: false, title: 'SX-001 Invented letter.pdf' });
		expect(broken).toMatch(/<span class="cite-broken" title="not in this results version">SX-001<\/span>/);
		expect(broken).not.toContain('Invented letter');
	});
});

describe('CitationLink route base', () => {
	it('links to the document route under the base the layout sets, and under /v without one', () => {
		const enc = encodeURIComponent(RV);
		expect(html({ page: 3 })).toContain(`href="/v/${enc}/doc/SX-001?page=3"`);
		const hosted = render(CitationLink, { props: { resultsVersion: RV, ref: 'SX-001', page: 3 }, context: new Map([['clearcase:base', () => '/cases/c1/v']]) }).body;
		expect(hosted).toContain(`href="/cases/c1/v/${enc}/doc/SX-001?page=3"`);
	});
});
