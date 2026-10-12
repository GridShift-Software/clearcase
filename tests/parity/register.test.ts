// The committed register: valid, no self-approval, every unimplemented view registered with its owner, and the
// pilot's own views never blanket-registered.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadRegister, REGISTER, REPO, registryKeys, registryOwners, validateRegister, viewIds } from '../../scripts/parity/lib/register.mjs';
import { VIEWS } from '../../src/lib/components/view-registry';

const owners = Object.fromEntries(VIEWS.map((v) => [v.id, v.linear]));
const keys = Object.fromEntries(VIEWS.map((v) => [v.id, v.owner]));
/**
 * A register folder's problems: every file as the runner loads it (the main file, then each fragment with its owner's
 * id range), plus the main file's own rules once more. Never the merged entries as if they were the main file: a
 * fragment's ids lie in its owner's range, which the main file may not use.
 */
const registerProblems = (file = REGISTER) => [...loadRegister(file, { owners, keys }).problems, ...validateRegister(JSON.parse(readFileSync(file, 'utf8')), { owners })];
// the main file and its owners' fragments, as the runner loads them
const loaded = loadRegister(undefined, { owners, keys });
const doc: { version: number; entries: any[] } = { version: 1, entries: loaded.entries };
const adapters = readdirSync(join(REPO, 'scripts', 'parity', 'adapters', 'app')).filter((f) => f.endsWith('.mjs') && !f.startsWith('_')).map((f) => f.replace(/\.mjs$/, ''));
const good = { id: 'IDR-999', view: 'chronology', field: 'text.subtitle', type: 'improvement', reason: 'A synthetic reason long enough.', productVisible: false, author: 'worker', approvedBy: null, approvedOn: null };
const check = (e: object) => validateRegister({ version: 1, entries: [{ ...good, ...e }] }, { owners });

describe('committed register', () => {
	test('validates against its schema and rules, fragments included', () => {
		expect(loaded.problems).toEqual([]);
		expect(registerProblems()).toEqual([]);
	});
	test("an owner's id in its own fragment passes; the same id in the main file fails, and so does a fragment id outside its owner's range (synthetic register)", () => {
		const dir = mkdtempSync(join(tmpdir(), 'parity-register-ranges-'));
		try {
			mkdirSync(join(dir, 'register'));
			const main = join(dir, 'intentional-differences.json');
			writeFileSync(main, JSON.stringify({ version: 1, entries: [good] }));
			writeFileSync(join(dir, 'register', 'CC-05.json'), JSON.stringify({ version: 1, entries: [{ ...good, id: 'IDR-150' }] }));
			expect(registerProblems(main)).toEqual([]);
			writeFileSync(join(dir, 'register', 'CC-05.json'), JSON.stringify({ version: 1, entries: [] }));
			writeFileSync(main, JSON.stringify({ version: 1, entries: [good, { ...good, id: 'IDR-150' }] }));
			expect(registerProblems(main).join('\n')).toMatch(/IDR-150: in CC-05's id range; it belongs in register\/CC-05\.json/);
			writeFileSync(main, JSON.stringify({ version: 1, entries: [good] }));
			writeFileSync(join(dir, 'register', 'CC-05.json'), JSON.stringify({ version: 1, entries: [{ ...good, id: 'IDR-120' }] }));
			expect(registerProblems(main).join('\n')).toMatch(/register\/CC-05\.json: IDR-120: outside CC-05's id range/);
		} finally { rmSync(dir, { recursive: true, force: true }); }
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
	test.each([
		['case-folded', 'WORKER'],
		['trailing space', 'worker '],
		['trailing non-breaking space', 'worker\u00a0'],
		['inner non-breaking space', 'wor\u00a0ker'],
		['zero-width space', 'wor\u200bker'],
		['compatibility form (NFKC)', '\uff57orker'],
	])('the approver must not be the author, %s', (_, approver) => {
		expect(check({ approvedBy: approver, approvedOn: '2026-10-09' }).join()).toMatch(/approver must not be the author/);
	});
	test.each([['?'], ['**'], ['*?'], ['?*'], [['*']], [['?']], [['text.*', '*']]])('a whole-view waiver other than exactly "*" is refused: %j', (field) => {
		expect(check({ view: 'people', field, type: 'not-yet-implemented', owner: 'GRS-1' }).join()).toMatch(/would match the whole view; a whole-view entry uses exactly "\*"/);
	});
	test('a narrow glob is not mistaken for a whole-view waiver', () => {
		expect(check({ field: ['text.*', 'control.button:*', 'table.table_1.row.*.date'] })).toEqual([]);
	});
	test('a different approver passes', () => expect(check({ approvedBy: 'coordinator', approvedOn: '2026-10-09' })).toEqual([]));
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

describe('runner', () => {
	test('owners and planning keys come from the generated view registry', async () => {
		expect(await registryOwners()).toEqual(owners);
		expect(await registryKeys()).toEqual(keys);
	});
	test('a whole-view entry with the wrong owner is a register error: exit 2 before anything starts', () => {
		const dir = mkdtempSync(join(tmpdir(), 'parity-register-'));
		try {
			const bad = structuredClone(doc);
			const e = bad.entries.find((x: any) => x.field === '*' && x.type === 'not-yet-implemented');
			e.owner = 'GRS-999';
			writeFileSync(join(dir, 'register.json'), JSON.stringify(bad));
			const r = spawnSync(process.versions.bun ? process.execPath : 'bun', [join(REPO, 'scripts', 'parity', 'run.mjs'), '--view', e.view, '--fixture-config', join(dir, 'absent.json'), '--out', join(dir, 'out'), '--register', join(dir, 'register.json')], { encoding: 'utf8', timeout: 30_000 });
			expect(r.status).toBe(2);
			expect(r.stderr).toMatch(new RegExp(`register invalid:[\\s\\S]*${e.id}: owner GRS-999 is not the view's owner ${owners[e.view]}`));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe('suite', () => {
	test('the default vitest run includes the parity suite', async () => {
		const { default: root } = await import('../../vitest.config');
		expect(root.test?.include).toContain('tests/parity/**/*.test.ts');
	});
});
