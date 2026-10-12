// Legality & SIU Risk and Cause of Action (GRS-18): the likelihood chip rule, cleanName, the cause-of-action target
// (an unknown id is text, not a link: S-elements_tab-1, corrected), the columns from view-content, and authored text
// with a [[REF]] citation rendered through the narrative contract (the sample's lit tables hold none).
import { describe, expect, it } from 'vitest';
import { narrativeHtml } from '../../src/lib/components/cite.ts';
import { ELEMENT_COLUMNS, cleanName, elementColumns, elementTarget, likelihoodClass } from '../../src/lib/views/litigation/readonly.ts';

describe('likelihoodClass (v5 chip)', () => {
	it('is ok for /base/i, then danger for /material/i, else warn', () => {
		expect(likelihoodClass('Base case')).toBe('ok');
		expect(likelihoodClass('Material risk')).toBe('danger');
		expect(likelihoodClass('Possible')).toBe('warn');
		expect(likelihoodClass('Material, but base')).toBe('ok');
		expect(likelihoodClass('')).toBe('warn');
	});
});

describe('cleanName (v5)', () => {
	it('drops a leading (digits) and a trailing .pdf/.eml/.msg', () => {
		expect(cleanName('(12) Synthetic title.PDF')).toBe('Synthetic title');
		expect(cleanName('Synthetic.eml')).toBe('Synthetic');
		expect(cleanName(undefined)).toBe('');
	});
});

describe('elementTarget (S-elements_tab-1, corrected)', () => {
	it('names a registry view for a known id', () => {
		expect(elementTarget('filings_tab')?.route).toBe('/evidence/filings_tab');
		expect(elementTarget('chronology')?.id).toBe('chronology');
	});
	it('is null for an unknown, empty or non-text id (shown as text, not a link)', () => {
		expect(elementTarget('no_such_tab')).toBeNull();
		expect(elementTarget('')).toBeNull();
		expect(elementTarget(7)).toBeNull();
	});
});

describe('elementColumns', () => {
	it('uses the view-content list when it names all five columns', () => {
		const cols = ['Element', 'What X must prove', 'Evidence', 'Witness', 'Go to'];
		expect(elementColumns(cols)).toEqual(cols);
	});
	it('falls back to neutral headings when the list is absent or incomplete', () => {
		expect(elementColumns(null)).toEqual([...ELEMENT_COLUMNS]);
		expect(elementColumns(['Element'])).toEqual([...ELEMENT_COLUMNS]);
		expect(elementColumns(['a', 'b', 'c', 'd', ' '])).toEqual([...ELEMENT_COLUMNS]);
	});
});

describe('authored text with a citation (synthetic)', () => {
	it('links a [[REF]] that exists in the version and renders a missing one broken', () => {
		const html = narrativeHtml('See [[OD-001]] and [[OD-999#p2]].', 'sha256:' + '0'.repeat(64), ['OD-001']);
		expect(html).toContain('<a class="cite" href="/v/sha256%3A' + '0'.repeat(64) + '/doc/OD-001">');
		expect(html).toContain('<span class="cite-broken"');
		expect(html).not.toContain('OD-999"');
	});
});
