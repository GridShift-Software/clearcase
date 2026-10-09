// The intentional-differences register (docs/reference/parity/intentional-differences.json, then the per-owner
// fragments in docs/reference/parity/register/CC-NN.json by file name): schema validation plus the rules a schema
// cannot state. Problems are returned, never thrown, so the runner can exit 2 with all of them.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Validator } from '@cfworker/json-schema';
import { globRe } from './compare.mjs';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');
export const REGISTER = join(REPO, 'docs', 'reference', 'parity', 'intentional-differences.json');
export const SCHEMA = join(REPO, 'docs', 'reference', 'parity', 'intentional-differences.schema.json');

/**
 * Each M2 owner's fragment (register/<planning key>.json) and the ids it may allocate for new entries. The main file
 * may use none of them. A fragment also keeps the legacy ids moved into it from the main file (LEGACY).
 */
export const RANGES = Object.freeze({ 'CC-04': [100, 149], 'CC-05': [150, 199], 'CC-06': [200, 249], 'CC-07': [250, 299], 'CC-08': [300, 349], 'CC-09': [350, 399], 'CC-10': [400, 449] });
export const LEGACY = Object.freeze({
	'CC-04': ['IDR-004', 'IDR-005', 'IDR-006', 'IDR-007', 'IDR-008', 'IDR-009', 'IDR-010'],
	'CC-05': ['IDR-001', 'IDR-002', 'IDR-018', 'IDR-019', 'IDR-020', 'IDR-021', 'IDR-022'],
	'CC-06': ['IDR-003', 'IDR-011', 'IDR-026', 'IDR-027', 'IDR-028', 'IDR-033'],
	'CC-07': ['IDR-012', 'IDR-013', 'IDR-014', 'IDR-034', 'IDR-035', 'IDR-036', 'IDR-037', 'IDR-050', 'IDR-067'],
	'CC-08': ['IDR-023', 'IDR-024', 'IDR-025', 'IDR-029', 'IDR-030', 'IDR-031', 'IDR-032'],
	'CC-09': ['IDR-015', 'IDR-016', 'IDR-017'],
	'CC-10': ['IDR-038', 'IDR-039', 'IDR-040', 'IDR-051', 'IDR-068'],
});
const idNumber = (id) => Number(/^IDR-([0-9]+)$/.exec(String(id))?.[1] ?? NaN);
const rangeOwner = (id) => Object.keys(RANGES).find((k) => idNumber(id) >= RANGES[k][0] && idNumber(id) <= RANGES[k][1]);

/** The 42 v5 navigation ids, from GRS-9's committed summary. */
export const viewIds = () => JSON.parse(readFileSync(join(REPO, 'docs', 'reference', 'v5-summary.json'), 'utf8')).nav.items.map((i) => i.id);

/** The view registry's owners (view id -> owning Linear id), from the generated src/lib/components/view-registry.ts. */
export async function registryOwners(root = REPO) {
	const { VIEWS } = await import(join(root, 'src', 'lib', 'components', 'view-registry.ts'));
	return Object.fromEntries(VIEWS.map((v) => [v.id, v.linear]));
}

/** The view registry's planning keys (view id -> owning CC key), which name the register fragments. */
export async function registryKeys(root = REPO) {
	const { VIEWS } = await import(join(root, 'src', 'lib', 'components', 'view-registry.ts'));
	return Object.fromEntries(VIEWS.map((v) => [v.id, v.owner]));
}

/**
 * One person's identity for the self-approval rule: NFKC, case-folded, with zero-width characters and every space
 * (non-breaking ones included) removed, so `Worker`, `worker `, `wor\u00a0ker` and `wor\u200bker` are one identity.
 */
export const identityKey = (s) => String(s).normalize('NFKC').toUpperCase().toLowerCase().replace(/[\s\u200b-\u200d\u2060\ufeff\u00ad]/gu, '');

/**
 * Validate a parsed register file. `views`: allowed view ids; `owners`: view id -> owning Linear id (the generated view
 * registry), used to check not-yet-implemented entries name the view's real owner. `fragment`: the planning key of a
 * fragment (its ids must lie in that owner's range or be its legacy ids; `keys`, view id -> planning key, then checks
 * that a whole-view entry is for one of the owner's views), or null for the main file (which may use no owner's
 * range). `ids`: a Set shared across files, so a duplicate id is found across the main file and its fragments.
 */
export function validateRegister(doc, { views = viewIds(), owners = null, keys = null, fragment = null, ids = new Set() } = {}) {
	const problems = [];
	const v = new Validator(JSON.parse(readFileSync(SCHEMA, 'utf8')), '2020-12', false);
	const r = v.validate(doc);
	if (!r.valid) for (const e of r.errors) problems.push(`schema: ${e.instanceLocation} ${e.error}`);
	if (!Array.isArray(doc?.entries)) return problems;
	if (fragment !== null && !RANGES[fragment]) return [...problems, `fragment ${fragment} is not an M2 owner's (${Object.keys(RANGES).join(', ')})`];
	for (const e of doc.entries) {
		const at = `${e.id ?? '?'}`;
		if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
		ids.add(e.id);
		if (fragment && !LEGACY[fragment].includes(e.id) && rangeOwner(e.id) !== fragment) problems.push(`${at}: outside ${fragment}'s id range IDR-${RANGES[fragment][0]}–IDR-${RANGES[fragment][1]}`);
		if (!fragment && rangeOwner(e.id)) problems.push(`${at}: in ${rangeOwner(e.id)}'s id range; it belongs in register/${rangeOwner(e.id)}.json`);
		if (fragment && keys && e.field === '*' && keys[e.view] && keys[e.view] !== fragment) problems.push(`${at}: whole view ${e.view} belongs to ${keys[e.view]}, not ${fragment}`);
		if (!views.includes(e.view)) problems.push(`${at}: unknown view ${JSON.stringify(e.view)}`);
		if (e.approvedBy && identityKey(e.approvedBy) === identityKey(e.author)) problems.push(`${at}: approver must not be the author`);
		if (!!e.approvedBy !== !!e.approvedOn) problems.push(`${at}: approvedBy and approvedOn go together`);
		// a whole-view entry is exactly the string '*' (it alone gets the owner check below); any other glob that would
		// match the whole-view path '*' ('?', '**', ['*'], …) is refused rather than standing in for it unchecked
		for (const f of [e.field].flat()) if (typeof f === 'string' && (Array.isArray(e.field) || f !== '*') && globRe(f).test('*')) problems.push(`${at}: field ${JSON.stringify(e.field)} would match the whole view; a whole-view entry uses exactly "*"`);
		if (e.type === 'not-yet-implemented' && e.field === '*' && owners && owners[e.view] && e.owner !== owners[e.view]) problems.push(`${at}: owner ${e.owner} is not the view's owner ${owners[e.view]}`);
		// no case values: a field glob names structure, so long digit runs or e-mail-like text do not belong in it
		if (/\d{4,}|@/.test(JSON.stringify(e.field)) || /\d{4,}|@/.test(JSON.stringify(e.when ?? {}))) problems.push(`${at}: field or condition looks like a case value (digit run or @)`);
	}
	return problems;
}

/**
 * Load the main file, then each fragment in `<its folder>/register/*.json` in file-name order, into one entry list.
 * `files` maps each entry id to its file, relative to the repository. A fragment's problems are prefixed with its name.
 */
export function loadRegister(file = REGISTER, opts = {}) {
	const dir = join(dirname(file), 'register');
	const names = existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort() : [];
	const ids = new Set();
	const out = { entries: [], problems: [], files: {} };
	for (const [path, fragment] of [[file, null], ...names.map((n) => [join(dir, n), n.slice(0, -'.json'.length)])]) {
		let doc;
		try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { out.problems.push(`cannot read ${path}: ${e.message}`); continue; }
		const problems = validateRegister(doc, { ...opts, fragment, ids });
		out.problems.push(...(fragment ? problems.map((p) => `register/${fragment}.json: ${p}`) : problems));
		for (const e of Array.isArray(doc?.entries) ? doc.entries : []) { out.entries.push(e); out.files[e.id] ??= relative(REPO, path); }
	}
	return out;
}

/** The ids of entries for a view that ran (`ran`: view ids) that covered no difference (`used`: a Set of ids). */
export const unusedEntries = (entries, ran, used) => entries.filter((e) => ran.includes(e.view) && !used.has(e.id)).map((e) => e.id);
