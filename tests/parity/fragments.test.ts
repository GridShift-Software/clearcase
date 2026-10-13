// The register's per-owner fragments (docs/reference/parity/register/CC-NN.json): loaded after the main file in
// file-name order, ids unique across all files, each owner's new ids in its own range (its moved legacy ids kept), a
// whole-view entry only for the owner's own views and with the view's real owner, and --strict-register counting
// fragment entries like any other. Synthetic registers in a temp folder; the committed fragments are checked too,
// against the tree: a fragment holds any subset of its owner's legacy ids plus new ids in its range (owners delete
// whole-view entries as adapters land), and an overview slot's unfilled-state entries are present exactly while the
// slot is unfilled (filledSlots, tests/e2e/pilot/lib/implemented.mjs).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { classify, diff, runFailures, scorecard } from '../../scripts/parity/lib/compare.mjs';
import { LEGACY, loadRegister, RANGES, REGISTER, REPO, unusedEntries } from '../../scripts/parity/lib/register.mjs';
import * as snap from '../../scripts/parity/lib/snapshot.mjs';
import { OVERVIEW_SLOTS } from '../../src/lib/components/overview-slots';
import { VIEWS } from '../../src/lib/components/view-registry';
import { filledSlots } from '../e2e/pilot/lib/implemented.mjs';
import { base } from './fixtures';

const owners = Object.fromEntries(VIEWS.map((v) => [v.id, v.linear]));
const keys = Object.fromEntries(VIEWS.map((v) => [v.id, v.owner]));
const registry = Object.fromEntries(VIEWS.map((v) => [v.id, v]));
const entry = (id: string, more: object = {}) => ({ id, view: 'chronology', field: 'text.subtitle', type: 'improvement', reason: 'A synthetic reason long enough.', productVisible: false, author: 'worker', approvedBy: null, approvedOn: null, ...more });
const whole = (id: string, view: string, owner = owners[view]) => entry(id, { view, field: '*', type: 'not-yet-implemented', owner });

const root = mkdtempSync(join(tmpdir(), 'parity-fragments-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** A register folder: the main file plus fragments by name. Returns the main file's path. */
function register(main: object[], fragments: Record<string, object[]> = {}) {
	const dir = join(root, `r${n++}`);
	mkdirSync(join(dir, 'register'), { recursive: true });
	writeFileSync(join(dir, 'main.json'), JSON.stringify({ version: 1, entries: main }));
	for (const [name, entries] of Object.entries(fragments)) writeFileSync(join(dir, 'register', `${name}.json`), JSON.stringify({ version: 1, entries }));
	return join(dir, 'main.json');
}
const load = (file: string) => loadRegister(file, { owners, keys });

describe('loading', () => {
	test('the main file first, then fragments by file name, each entry with its file', () => {
		const file = register([entry('IDR-090')], { 'CC-05': [entry('IDR-150')], 'CC-04': [entry('IDR-100'), whole('IDR-101', 'people')] });
		const r = load(file);
		expect(r.problems).toEqual([]);
		expect(r.entries.map((e) => e.id)).toEqual(['IDR-090', 'IDR-100', 'IDR-101', 'IDR-150']);
		expect(r.files['IDR-090']).toMatch(/main\.json$/);
		expect(r.files['IDR-101']).toMatch(/register\/CC-04\.json$/);
		expect(r.files['IDR-150']).toMatch(/register\/CC-05\.json$/);
	});
	test('a main file without a register folder loads alone', () => {
		const dir = join(root, 'alone');
		mkdirSync(dir);
		writeFileSync(join(dir, 'main.json'), JSON.stringify({ version: 1, entries: [entry('IDR-090')] }));
		expect(load(join(dir, 'main.json'))).toMatchObject({ problems: [], entries: [{ id: 'IDR-090' }] });
	});
	test('a fragment that does not parse or fails the schema is a problem named by its file', () => {
		const file = register([], { 'CC-06': [entry('IDR-200', { type: 'other' })] });
		writeFileSync(join(file, '..', 'register', 'CC-07.json'), '{');
		const p = load(file).problems.join('\n');
		expect(p).toMatch(/register\/CC-06\.json: schema/);
		expect(p).toMatch(/cannot read .*CC-07\.json/);
	});
});

describe('rules across files', () => {
	test('an id is unique across the main file and every fragment', () => {
		expect(load(register([entry('IDR-090')], { 'CC-04': [entry('IDR-100')], 'CC-05': [entry('IDR-100')] })).problems).toContain('register/CC-05.json: IDR-100: duplicate id');
		expect(load(register([entry('IDR-090')], { 'CC-04': [entry('IDR-100'), entry('IDR-100')] })).problems).toEqual(['register/CC-04.json: IDR-100: duplicate id']);
		expect(load(register([entry('IDR-004')], { 'CC-04': [whole('IDR-004', 'people')] })).problems).toEqual(['register/CC-04.json: IDR-004: duplicate id']);
	});
	test("an id outside the fragment owner's range is refused; its moved legacy ids are kept", () => {
		expect(load(register([], { 'CC-04': [entry('IDR-150')] })).problems).toEqual(["register/CC-04.json: IDR-150: outside CC-04's id range IDR-100–IDR-149"]);
		expect(load(register([], { 'CC-04': [entry('IDR-099')] })).problems.join()).toMatch(/outside CC-04's id range/);
		expect(load(register([], { 'CC-04': [entry('IDR-450')] })).problems.join()).toMatch(/outside CC-04's id range/);
		expect(load(register([], { 'CC-05': [whole('IDR-004', 'people')] })).problems.join()).toMatch(/IDR-004: outside CC-05's id range/);
		expect(load(register([], { 'CC-04': [whole('IDR-004', 'people'), entry('IDR-149')] })).problems).toEqual([]);
		expect(load(register([], { 'CC-10': [entry('IDR-400'), entry('IDR-449')] })).problems).toEqual([]);
	});
	test("the main file may not use an owner's range", () => {
		expect(load(register([entry('IDR-120')])).problems).toEqual(["IDR-120: in CC-04's id range; it belongs in register/CC-04.json"]);
		expect(load(register([entry('IDR-450'), entry('IDR-073')])).problems).toEqual([]);
	});
	test('a fragment must be named after an M2 owner', () => {
		expect(load(register([], { 'CC-11': [entry('IDR-100')] })).problems.join()).toMatch(/fragment CC-11 is not an M2 owner's/);
		expect(load(register([], { notes: [] })).problems.join()).toMatch(/fragment notes is not an M2 owner's/);
	});
	test("the whole-view owner check holds in a fragment, and a whole view must be the fragment owner's", () => {
		expect(load(register([], { 'CC-04': [whole('IDR-100', 'people', 'GRS-999')] })).problems).toEqual(["register/CC-04.json: IDR-100: owner GRS-999 is not the view's owner GRS-14"]);
		expect(load(register([], { 'CC-04': [whole('IDR-100', 'timeline')] })).problems).toEqual(['register/CC-04.json: IDR-100: whole view timeline belongs to CC-05, not CC-04']);
		expect(load(register([], { 'CC-05': [whole('IDR-150', 'timeline')] })).problems).toEqual([]);
	});
	test('every single-file rule still applies inside a fragment', () => {
		const p = load(register([], { 'CC-04': [entry('IDR-100', { approvedBy: 'Worker', approvedOn: '2026-10-09' }), entry('IDR-101', { field: 'table.t.row.SY-12345.date' }), entry('IDR-102', { field: '**' }), entry('IDR-103', { view: 'nope' })] })).problems.join('\n');
		for (const re of [/IDR-100: approver must not be the author/, /IDR-101: .*case value/, /IDR-102: .*would match the whole view/, /IDR-103: unknown view/]) expect(p).toMatch(re);
	});
});

describe('strict register over fragments', () => {
	test('a whole-view entry in a fragment covers the view, and an unused fragment entry fails a strict run', () => {
		const { entries, problems } = load(register([entry('IDR-090')], { 'CC-04': [whole('IDR-100', 'people'), entry('IDR-101', { view: 'people', field: 'text.subtitle' })] }));
		expect(problems).toEqual([]);
		const r = classify('people', diff({ ...base('v5'), view: 'people' }, snap.appWithoutAdapter('people', { ...registry, people: { ...registry.people!, status: `unavailable-until:${registry.people!.linear}` } })), entries, {});
		expect(r.registered).toMatchObject([{ register: 'IDR-100' }]);
		const unused = unusedEntries(entries, ['people'], new Set(r.registered.map((d: any) => d.register)));
		expect(unused).toEqual(['IDR-101']);
		const sc = { ...scorecard({ people: { ...r, v5Status: 'ok', appStatus: 'not-implemented' } }), isolation: { offline: true, v5NonFileRequests: 0, v5BrowserInternalRequests: 0, appNonLoopbackRequests: 0, canaryHits: 0, canaryBrowserServiceHits: 0, fixtureUnchanged: true } };
		expect(runFailures(sc, { views: 1, unused: unused.length, strict: true }).join()).toMatch(/1 unused register entry \(--strict-register\)/);
		expect(runFailures(sc, { views: 1, unused: unused.length, strict: false })).toEqual([]);
	});
});

/** The ids a fragment may hold that break the subset-plus-range rule. */
const foreignIds = (key: string, ids: string[]) => ids.filter((id) => !LEGACY[key].includes(id) && !(Number(id.slice(4)) >= RANGES[key][0] && Number(id.slice(4)) <= RANGES[key][1]));
/** Each slot owner's unfilled-state entries and the slots they stand for. */
const UNFILLED_ENTRIES: Record<string, { ids: string[]; slots: string[] }> = { 'CC-07': { ids: ['IDR-050', 'IDR-067'], slots: ['deadlines', 'unbilled-time'] }, 'CC-10': { ids: ['IDR-051', 'IDR-068'], slots: ['rescan-freshness'] } };
/**
 * What is wrong with the unfilled-state entries, given each fragment's ids and the filled slots: while none of the
 * owner's slots is filled they must all be present; once one is filled they must all be gone (the owner registers
 * what still differs under new ids in its range).
 */
function unfilledProblems(idsOf: Record<string, string[]>, filled: Set<string>) {
	const out: string[] = [];
	for (const [key, { ids, slots }] of Object.entries(UNFILLED_ENTRIES)) {
		const any = slots.filter((s) => filled.has(s));
		for (const id of ids) {
			const has = (idsOf[key] ?? []).includes(id);
			if (any.length && has) out.push(`${key}: ${id} must be deleted: slot ${any.join(', ')} is filled`);
			if (!any.length && !has) out.push(`${key}: ${id} must stay while ${slots.join(', ')} is unfilled`);
		}
	}
	return out;
}

describe('fragment rules that follow the tree (synthetic)', () => {
	test("a fragment may hold any subset of its owner's legacy ids plus new ids in its range, nothing else", () => {
		expect(foreignIds('CC-07', ['IDR-012', 'IDR-250', 'IDR-299'])).toEqual([]);
		expect(foreignIds('CC-07', [])).toEqual([]);
		expect(foreignIds('CC-07', ['IDR-004', 'IDR-300', 'IDR-249', 'IDR-051'])).toEqual(['IDR-004', 'IDR-300', 'IDR-249', 'IDR-051']);
	});
	test('unfilled-state entries: required while the slot is unfilled, refused once a synthetic tree fills it', () => {
		const tree = mkdtempSync(join(root, 'tree-'));
		const none = filledSlots(tree, OVERVIEW_SLOTS);
		expect(none.size).toBe(0);
		expect(unfilledProblems({ 'CC-07': ['IDR-050', 'IDR-067'], 'CC-10': ['IDR-051', 'IDR-068'] }, none)).toEqual([]);
		expect(unfilledProblems({ 'CC-07': ['IDR-050'], 'CC-10': ['IDR-051', 'IDR-068'] }, none)).toEqual(['CC-07: IDR-067 must stay while deadlines, unbilled-time is unfilled']);
		mkdirSync(join(tree, 'src', 'lib', 'views', 'registers'), { recursive: true });
		writeFileSync(join(tree, 'src', 'lib', 'views', 'registers', 'overview-widgets.ts'), "export const widgets = [{ slot: 'deadlines', component: null }];\n");
		const filled = filledSlots(tree, OVERVIEW_SLOTS);
		expect([...filled]).toEqual(['deadlines']);
		expect(unfilledProblems({ 'CC-07': ['IDR-050', 'IDR-067', 'IDR-250'], 'CC-10': ['IDR-051', 'IDR-068'] }, filled)).toEqual(['CC-07: IDR-050 must be deleted: slot deadlines is filled', 'CC-07: IDR-067 must be deleted: slot deadlines is filled']);
		expect(unfilledProblems({ 'CC-07': ['IDR-250'], 'CC-10': ['IDR-051', 'IDR-068'] }, filled)).toEqual([]);
	});
});

describe('the committed fragments', () => {
	const dir = join(REGISTER, '..', 'register');
	const names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
	const { entries, files, problems } = loadRegister(undefined, { owners, keys });
	test('one per M2 owner, CC-04 to CC-10, and the whole register validates', () => {
		expect(names).toEqual(Object.keys(RANGES).map((k) => `${k}.json`));
		expect(problems).toEqual([]);
	});
	const idsOf = Object.fromEntries(names.map((name) => [name.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, name), 'utf8')).entries.map((e: any) => e.id)]));
	test("each holds a subset of its owner's legacy entries plus new ids in its range, each for the owner's own views or owned by it (its overview slots)", () => {
		for (const name of names) {
			const key = name.replace(/\.json$/, '');
			const linear = VIEWS.find((v) => v.owner === key)!.linear;
			const doc = JSON.parse(readFileSync(join(dir, name), 'utf8'));
			expect(foreignIds(key, idsOf[key]), key).toEqual([]);
			for (const e of doc.entries) expect(keys[e.view] === key || e.owner === linear, e.id).toBe(true);
		}
	});
	test("the overview slots' unfilled-state entries are present exactly while their slot is unfilled in this tree, and sit with their slot owners", () => {
		expect(unfilledProblems(idsOf, filledSlots(REPO, OVERVIEW_SLOTS))).toEqual([]);
		for (const [key, { ids }] of Object.entries(UNFILLED_ENTRIES)) for (const id of ids) if (files[id]) expect(files[id], id).toBe(`docs/reference/parity/register/${key}.json`);
	});
	test("the main file holds no entry for an M2 owner's view or owned by an M2 ticket, and every entry has a file", () => {
		const main = JSON.parse(readFileSync(REGISTER, 'utf8'));
		const m2 = new Set(VIEWS.filter((v) => v.owner in RANGES).map((v) => v.linear));
		for (const e of main.entries) expect(Object.keys(RANGES), e.id).not.toContain(keys[e.view]);
		for (const e of main.entries) expect(m2.has(e.owner), e.id).toBe(false);
		for (const e of entries) expect(files[e.id], e.id).toMatch(/^docs\/reference\/parity\/(intentional-differences|register\/CC-[0-9]{2})\.json$/);
	});
});
