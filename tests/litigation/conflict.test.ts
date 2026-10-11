// Conflict Check (GRS-18): v5's matcher on the checklist's literal example people and entities
// (docs/reference/view-checklist.md, Conflict Check), the select's options, and the generic input hint
// (S-conflict_tab-1, corrected).
import { describe, expect, it } from 'vitest';
import { EMPTY_QUERY, QUERY_PLACEHOLDER, conflictOptions, fold, matchConflict, matchCountText, noMatchText } from '../../src/lib/views/litigation/conflict.ts';
import { conflictScope } from '../../src/lib/views/litigation/notes.ts';

const people = [{ name: 'Ann Lee', email: 'ann@x.test', org: 'Org A' }];
const entities = [{ name: 'Org A Ltd', role: 'supplier', note: '' }];

describe('matchConflict (checklist examples)', () => {
	it("q='org a' gives the correspondent first, then the entity", () => {
		expect(matchConflict('org a', people, entities)).toEqual({ query: 'org a', hits: [
			{ kind: 'Correspondent', match: 'Ann Lee (ann@x.test)', detail: 'Org A' },
			{ kind: 'Entity', match: 'Org A Ltd', detail: 'supplier' },
		] });
	});
	it("trims and lower-cases: ' ANN ' is 'ann', one correspondent", () => {
		const r = matchConflict(' ANN ', people, entities)!;
		expect(r.query).toBe('ann');
		expect(r.hits.map((h) => h.kind)).toEqual(['Correspondent']);
	});
	it("matches across field boundaries: 'lee ann' (S-conflict_tab-2, copied)", () => {
		expect(matchConflict('lee ann', people, entities)!.hits).toHaveLength(1);
	});
	it("'zzz' matches nothing and keeps v5's wording", () => {
		const r = matchConflict('zzz', people, entities)!;
		expect(r.hits).toEqual([]);
		expect(noMatchText(r.query)).toBe('No conflict match found for "zzz"');
		expect(matchCountText(2)).toBe('2 potential match(es) — review before acting');
	});
	it('clears on an empty or blank query', () => {
		expect(matchConflict('', people, entities)).toBeNull();
		expect(matchConflict('   ', people, entities)).toBeNull();
	});
	it("prints a missing e-mail or org as v5 does (S-conflict_tab-4, copied)", () => {
		expect(matchConflict('bob', [{ name: 'Bob', email: '' }], [])!.hits).toEqual([{ kind: 'Correspondent', match: 'Bob ()', detail: 'undefined' }]);
		expect(matchConflict('undefined', [{ name: 'Bob' }], [])!.hits).toHaveLength(1);
	});
});

describe('conflictOptions (index-coded, GRS-18 r2 D21)', () => {
	it('lists entities, then people, in data order, with v5 labels; a pick searches the name', () => {
		expect(conflictOptions([...entities, { name: 'X', role: '' }], [...people, { name: 'P', email: '', org: '' }])).toEqual([
			{ value: '0', label: 'Org A Ltd — supplier', query: 'Org A Ltd' },
			{ value: '1', label: 'X — entity', query: 'X' },
			{ value: '2', label: 'Ann Lee · ann@x.test (Org A)', query: 'Ann Lee' },
			{ value: '3', label: 'P', query: 'P' },
		]);
	});
	it('an entity named with a trailing <…> and a person whose e-mail holds > are searched in full', () => {
		const ents = [{ name: 'Acme <Holdings>', role: 'x' }], ppl = [{ name: 'Bo Ng', email: 'b>o@x.test', org: '' }];
		const [e, p] = conflictOptions(ents, ppl);
		expect(e!.query).toBe('Acme <Holdings>');
		expect(matchConflict(e!.query, ppl, ents)!.hits.map((h) => h.kind)).toEqual(['Entity']);
		expect(matchConflict(p!.query, ppl, ents)!.hits.map((h) => h.kind)).toEqual(['Correspondent']);
	});
});

describe('matching folds case, width and diacritics (GRS-18 r2, D21)', () => {
	const ppl = [{ name: 'Zoë Strauß', email: 'zoe@x.test', org: 'İnci Ltd' }];
	it.each([
		['an NFD query against an NFC name', 'Zoe\u0308'],
		['no diacritics', 'zoe strauss'],
		['ss against ß', 'strauss'],
		['a dotted capital I against plain i', 'inci'],
		['full-width letters', 'ＺＯＥ'],
	])('%s matches', (_n, q) => {
		expect(matchConflict(q, ppl, [])!.hits).toHaveLength(1);
	});
	it('fold is idempotent and keeps plain text', () => {
		expect(fold('Org A')).toBe('org a');
		expect(fold(fold('İß'))).toBe(fold('İß'));
	});
	it('an empty query has its own message', () => {
		expect(matchConflict(' \u0301 ', ppl, [])).toBeNull();
		expect(EMPTY_QUERY).toMatch(/Enter a name/);
	});
});

describe('scope and input hint', () => {
	it('the input hint is generic: no e-mail address, no digits, nothing imported', () => {
		expect(QUERY_PLACEHOLDER).not.toMatch(/@/);
		expect(QUERY_PLACEHOLDER).not.toMatch(/\d/);
		for (const v of [...Object.values(people[0]!), ...Object.values(entities[0]!)].filter(Boolean)) expect(QUERY_PLACEHOLDER.toLowerCase()).not.toContain(v.toLowerCase());
	});
	it('the scope disclosure counts what was searched and says a result is not a clearance', () => {
		expect(conflictScope(42, 22)).toBe("Searches only this matter's 42 people and 22 entities from the imported results package. A match, or no match, is not a conflict clearance.");
		expect(conflictScope(1, 1)).toMatch(/1 person and 1 entity/);
	});
});
