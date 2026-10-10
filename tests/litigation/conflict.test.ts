// Conflict Check (GRS-18): v5's matcher on the checklist's literal example people and entities
// (docs/reference/view-checklist.md, Conflict Check), the select's options, and the generic input hint
// (S-conflict_tab-1, corrected).
import { describe, expect, it } from 'vitest';
import { QUERY_PLACEHOLDER, conflictOptions, matchConflict, matchCountText, noMatchText, pickedQuery } from '../../src/lib/views/litigation/conflict.ts';
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

describe('conflictOptions and pickedQuery', () => {
	it('lists entities, then people, in data order, with v5 labels', () => {
		expect(conflictOptions([...entities, { name: 'X', role: '' }], [...people, { name: 'P', email: '', org: '' }])).toEqual([
			{ value: 'Org A Ltd', label: 'Org A Ltd — supplier' },
			{ value: 'X', label: 'X — entity' },
			{ value: 'Ann Lee <ann@x.test>', label: 'Ann Lee · ann@x.test (Org A)' },
			{ value: 'P', label: 'P' },
		]);
	});
	it('searches a picked person by name only', () => {
		expect(pickedQuery('Ann Lee <ann@x.test>')).toBe('Ann Lee');
		expect(pickedQuery('Org A Ltd')).toBe('Org A Ltd');
		expect(pickedQuery('')).toBe('');
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
