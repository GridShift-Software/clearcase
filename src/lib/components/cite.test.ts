// The refs a page looks up for its narrative are the refs the renderer links: padded tokens included (CC-05 lane 03).
// Invented refs and texts only.
import { describe, expect, it } from 'vitest';
import { renderNarrative } from '../case-package/render.ts';
import { citedRefs, narrativeHtml } from './cite.ts';

const RV = 'sha256:' + 'c'.repeat(64);
const rv = encodeURIComponent(RV);
/** What a page does: look up the cited refs, keep those that exist, render with them. */
const page = (text: string, existing: readonly string[]) => narrativeHtml(text, RV, citedRefs([text]).filter((r) => existing.includes(r)));

describe('citedRefs', () => {
	it('links a padded token, with or without a page, when the ref exists', () => {
		const html = page('See [[ OD-001 ]] and [[  OD-002#p3\t]].', ['OD-001', 'OD-002']);
		expect(citedRefs(['See [[ OD-001 ]] and [[  OD-002#p3\t]].'])).toEqual(['OD-001', 'OD-002']);
		expect(html).toContain(`<a class="cite" href="/v/${rv}/doc/OD-001">OD-001</a>`);
		expect(html).toContain(`<a class="cite" href="/v/${rv}/doc/OD-002?page=3">OD-002 p.3</a>`);
		expect(html).not.toContain('cite-broken');
	});

	it('links a padded token on its own, with no unpadded token for the same ref on the page', () => {
		expect(page('Only [[ SX-0042 ]] here.', ['SX-0042'])).toContain(`href="/v/${rv}/doc/SX-0042"`);
	});

	it('treats an empty or blank padded token as no ref', () => {
		expect(citedRefs(['[[ ]] and [[]] and [[\t ]]'])).toEqual([]);
		expect(page('[[   ]]', ['OD-001'])).toBe('<p>[[   ]]</p>');
	});

	it('looks up exactly the refs renderNarrative asks its resolver for', () => {
		const texts = [
			'[[OD-001]] [[ OD-002 ]] [[OD-003#p2]] [[ OD-004#p9 ]]',
			'[[ od-001 ]] [[OD-1 x]] [[ OD-005#p0 ]] [[OD-006#p]] [[ ]] [[ZZ-9]]',
			'Line one [[ AB-12 ]]\r\nline two [[CD-34\r]] and [[ EF-56\n]]',
			'Para one [[ GH-7 ]].\n\nPara two [[ IJ-8 ]] [[ KL-9#p12345 ]] [[MN-1#p123456]]',
			'[[ [[OP-2]] ]] [[QR-3]]] [[[ST-4]]',
		];
		for (const text of texts) {
			const asked = new Set<string>();
			renderNarrative(text, { resolveCitationHref: (ref) => { asked.add(ref); return null; } });
			expect(citedRefs([text]), JSON.stringify(text)).toEqual([...asked].sort());
		}
	});
});
