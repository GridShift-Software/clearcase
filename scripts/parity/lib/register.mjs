// The intentional-differences register (docs/reference/parity/intentional-differences.json, then the per-owner
// fragments in docs/reference/parity/register/CC-NN.json by file name): schema validation plus the rules a schema
// cannot state. Problems are returned, never thrown, so the runner can exit 2 with all of them.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { Validator } from '@cfworker/json-schema';
import { notCommitted } from '../../../tests/e2e/pilot/lib/fresh-build.ts';
import { globRe } from './compare.mjs';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');
export const REGISTER = join(REPO, 'docs', 'reference', 'parity', 'intentional-differences.json');
export const SCHEMA = join(REPO, 'docs', 'reference', 'parity', 'intentional-differences.schema.json');

/**
 * Each M2 owner's fragment (register/<planning key>.json) and the id ranges it may allocate new entries from (CC-06 has
 * a second one, added when its first ran short of numbers never used). The main file may use none of them. A fragment also keeps the legacy ids moved into it from the main file (LEGACY).
 */
export const RANGES = Object.freeze({ 'CC-04': [[100, 149]], 'CC-05': [[150, 199]], 'CC-06': [[200, 249], [450, 474]], 'CC-07': [[250, 299]], 'CC-08': [[300, 349]], 'CC-09': [[350, 399]], 'CC-10': [[400, 449]] });
/** Removed ids remain unavailable so prior reports and approvals cannot acquire a new meaning. */
export const RETIRED = new Set([100, 106, 116, 124, 134, 150, 155, 157, 158, 159, 160, 162, 163, 165, 166, 169, 206, 208, 216, 218, 222, 236, 267, 302, 311, 314, 317, 320, 323, 324, 350, 358, 359, 360, 362, 363, 364].map((n) => `IDR-${n}`));
/** An owner's ranges in words: `IDR-200–IDR-249, IDR-450–IDR-474`. */
export const rangeText = (key) => RANGES[key].map(([lo, hi]) => `IDR-${lo}–IDR-${hi}`).join(', ');
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
const rangeOwner = (id) => Object.keys(RANGES).find((k) => RANGES[k].some(([lo, hi]) => idNumber(id) >= lo && idNumber(id) <= hi));

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
		if (RETIRED.has(e.id)) problems.push(`${at}: retired id`);
		if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
		ids.add(e.id);
		if (fragment && !LEGACY[fragment].includes(e.id) && rangeOwner(e.id) !== fragment) problems.push(`${at}: outside ${fragment}'s id range ${rangeText(fragment)}`);
		if (!fragment && rangeOwner(e.id)) problems.push(`${at}: in ${rangeOwner(e.id)}'s id range; it belongs in register/${rangeOwner(e.id)}.json`);
		if (fragment && keys && e.field === '*' && keys[e.view] && keys[e.view] !== fragment) problems.push(`${at}: whole view ${e.view} belongs to ${keys[e.view]}, not ${fragment}`);
		if (!views.includes(e.view)) problems.push(`${at}: unknown view ${JSON.stringify(e.view)}`);
		if (e.approvedBy && identityKey(e.approvedBy) === identityKey(e.author)) problems.push(`${at}: approver must not be the author`);
		if (!!e.approvedBy !== !!e.approvedOn) problems.push(`${at}: approvedBy and approvedOn go together`);
		// a whole-view entry is exactly the string '*' (it alone gets the owner check below); any other glob that would
		// match the whole-view path '*' ('?', '**', ['*'], …) is refused rather than standing in for it unchecked
		for (const f of [e.field].flat()) if (typeof f === 'string' && (Array.isArray(e.field) || f !== '*') && globRe(f).test('*')) problems.push(`${at}: field ${JSON.stringify(e.field)} would match the whole view; a whole-view entry uses exactly "*"`);
		// a disposition (field []) records how a v5 source defect stands where no compared path differs: it covers nothing
		if (isDisposition(e) && (e.type === 'improvement' || e.type === 'not-yet-implemented' || !/^S-/.test(e.source ?? '') || e.when)) problems.push(`${at}: a disposition (field []) needs a defect-fix, known-gap or data-correction-deferred-to-pipeline type, an S-… source and no when`);
		if (e.type === 'not-yet-implemented' && e.field === '*' && owners && owners[e.view] && e.owner !== owners[e.view]) problems.push(`${at}: owner ${e.owner} is not the view's owner ${owners[e.view]}`);
		// no case values: a field glob names structure, so long digit runs or e-mail-like text do not belong in it
		if (/\d{4,}|@/.test(JSON.stringify(e.field)) || /\d{4,}|@/.test(JSON.stringify(e.when ?? {}))) problems.push(`${at}: field or condition looks like a case value (digit run or @)`);
	}
	return problems;
}

/** The files loadRegister reads for `file`: the file, then each `<its folder>/register/*.json` in file-name order. */
export function registerFiles(file = REGISTER) {
	const dir = join(dirname(file), 'register');
	return [file, ...(existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).sort().map((n) => join(dir, n)) : [])];
}

/**
 * Load the main file, then each fragment in `<its folder>/register/*.json` in file-name order, into one entry list.
 * `files` maps each entry id to its file, relative to the repository; `read` lists every file read (registerFiles) and
 * `bytes` holds the bytes each was parsed from, by path, for the committed-input check. A fragment's problems are
 * prefixed with its name.
 */
export function loadRegister(file = REGISTER, opts = {}) {
	const read = registerFiles(file);
	const ids = new Set();
	const out = { entries: [], problems: [], files: {}, read, bytes: {} };
	for (const [path, fragment] of read.map((p, i) => [p, i === 0 ? null : basename(p, '.json')])) {
		let doc;
		try { out.bytes[path] = readFileSync(path); doc = JSON.parse(out.bytes[path].toString('utf8')); } catch (e) { out.problems.push(`cannot read ${path}: ${e.message}`); continue; }
		const problems = validateRegister(doc, { ...opts, fragment, ids });
		out.problems.push(...(fragment ? problems.map((p) => `register/${fragment}.json: ${p}`) : problems));
		for (const e of Array.isArray(doc?.entries) ? doc.entries : []) { out.entries.push(e); out.files[e.id] ??= relative(REPO, path); }
	}
	return out;
}

/** An entry with field [] is a source-defect disposition: it covers no difference, so it is never unused either. */
export const isDisposition = (e) => Array.isArray(e.field) && e.field.length === 0;

/** The ids of entries for a view that ran (`ran`: view ids) that covered no difference (`used`: a Set of ids). */
export const unusedEntries = (entries, ran, used) => entries.filter((e) => ran.includes(e.view) && !isDisposition(e) && !used.has(e.id)).map((e) => e.id);

/**
 * Why a parity run is not release evidence whatever its build (the scorecard's evidence is false with these in its
 * note). A waiver counts only when the reviewed commit holds it: a --register FILE outside docs/reference/parity/, and
 * any register file the run read (`loaded`, loadRegister's `read`; else the files it would read now for --register or
 * the default register: the main file and every fragment) that is not a committed review input inside that folder
 * (fresh-build.ts uncommittedInputs: untracked, ignored, modified or hidden from git as given or resolved, or bytes
 * other than HEAD's blob; `bytes`, by path, are the bytes the run read, else the file is read now). An ignored .local/
 * register inside the folder, a symlink to a committed file elsewhere, or an edit a stale index hides could waive
 * anything. The same holds for `modules`, the adapters, v5 specs and slot plug-ins the runner loads by listing a folder
 * under scripts/parity/adapters (lib/modules.mjs; their bytes as imported go in `bytes` too). A run
 * that compares less than the gate is not evidence either: --no-sweeps, --no-exports, PARITY_MAX_COMBOS (`maxCombos`),
 * and --app-v5-html (v5 against a copy of itself: self-parity, the mutation control). Paths compare by realpath.
 */
export function runNonEvidence({ register, appV5Html, loaded, bytes = {}, modules = [], noSweeps = false, noExports = false, maxCombos } = {}) {
	const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
	const dir = real(dirname(REGISTER));
	const out = [];
	if (register !== undefined && !real(register).startsWith(dir + sep)) out.push(`--register ${real(register)} is not under ${dir}${sep}`);
	out.push(...notCommitted('register files the run read', REPO, loaded ?? registerFiles(register === undefined ? REGISTER : resolve(register)), { within: 'docs/reference/parity', read: bytes }));
	out.push(...notCommitted('parity modules loaded by file name', REPO, modules, { within: 'scripts/parity/adapters', read: bytes }));
	if (appV5Html) out.push('--app-v5-html compares v5 with a copy of itself (self-parity)');
	if (noSweeps) out.push('--no-sweeps skips the interaction sweeps');
	if (noExports) out.push('--no-exports skips the export capture');
	if (maxCombos !== undefined) out.push(`PARITY_MAX_COMBOS=${maxCombos} compares only some chronology UI combinations`);
	return out;
}
