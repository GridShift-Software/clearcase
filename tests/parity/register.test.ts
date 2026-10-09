// The committed register: valid, no self-approval, every unimplemented view registered with its owner, and the
// pilot's own views never blanket-registered.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REGISTER, REPO, validateRegister, viewIds } from '../../scripts/parity/lib/register.mjs';
import { VIEWS } from '../../src/lib/components/view-registry';

const doc = JSON.parse(readFileSync(REGISTER, 'utf8'));
const owners = Object.fromEntries(VIEWS.map((v) => [v.id, v.linear]));
const adapters = readdirSync(join(REPO, 'scripts', 'parity', 'adapters', 'app')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => f.replace(/\.mjs$/, ''));
const good = { id: 'IDR-999', view: 'chronology', field: 'text.subtitle', type: 'improvement', reason: 'A synthetic reason long enough.', productVisible: false, author: 'worker', approvedBy: null, approvedOn: null };
const check = (e: object) => validateRegister({ version: 1, entries: [{ ...good, ...e }] }, { owners });

describe('committed register', () => {
	test('validates against its schema and rules', () => {
		expect(validateRegister(doc, { owners })).toEqual([]);
	});
	test('the 42 views are the v5 navigation ids', () => {
		expect(viewIds()).toHaveLength(42);
	});
	test('every view without an app adapter has a whole-view not-yet-implemented entry naming its owner', () => {
		for (const v of VIEWS.filter((x) => !adapters.includes(x.id))) {
			const e = doc.entries.find((x: any) => x.view === v.id && x.field === '*' && x.type === 'not-yet-implemented');
			expect(e, v.id).toBeTruthy();
			expect(e.owner).toBe(v.linear);
		}
	});
	test('a view with an app adapter is never registered as a whole', () => {
		for (const v of adapters) expect(doc.entries.filter((x: any) => x.view === v && x.field === '*')).toEqual([]);
	});
	test('every available view has an app adapter', () => {
		for (const v of VIEWS.filter((x) => x.status === 'available')) expect(adapters).toContain(v.id);
	});
	test('no entry is approved by its author', () => {
		for (const e of doc.entries) expect(e.approvedBy === null || e.approvedBy !== e.author).toBe(true);
	});
});

describe('rules', () => {
	test('a well-formed proposed entry passes', () => expect(check({})).toEqual([]));
	test('the approver must not be the author', () => expect(check({ approvedBy: 'worker', approvedOn: '2026-10-09' }).join()).toMatch(/approver must not be the author/));
	test('approvedBy and approvedOn go together', () => expect(check({ approvedBy: 'coordinator' }).join()).toMatch(/go together/));
	test('a defect fix names its S- source defect', () => {
		expect(check({ type: 'defect-fix' }).join()).toMatch(/schema/);
		expect(check({ type: 'defect-fix', source: 'BA-14' }).join()).toMatch(/schema/);
		expect(check({ type: 'defect-fix', source: 'S-chronology-1' })).toEqual([]);
	});
	test('not-yet-implemented names an owner, and the view owner for a whole view', () => {
		expect(check({ type: 'not-yet-implemented', field: '*' }).join()).toMatch(/schema/);
		expect(check({ type: 'not-yet-implemented', field: '*', view: 'people', owner: 'GRS-99' }).join()).toMatch(/not the view's owner/);
		expect(check({ type: 'not-yet-implemented', field: '*', view: 'people', owner: 'GRS-14' })).toEqual([]);
	});
	test('unknown views, unknown types and duplicate ids are refused', () => {
		expect(check({ view: 'nope' }).join()).toMatch(/unknown view/);
		expect(check({ type: 'other' }).join()).toMatch(/schema/);
		expect(validateRegister({ version: 1, entries: [good, good] }).join()).toMatch(/duplicate id/);
	});
	test('fields and conditions that look like case values are refused', () => {
		expect(check({ field: 'table.t.row.SY-12345.date' }).join()).toMatch(/case value/);
		expect(check({ when: { v5: 'someone@example.org' } }).join()).toMatch(/case value/);
	});
});
