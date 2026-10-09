// The intentional-differences register (docs/reference/parity/intentional-differences.json): schema validation plus
// the rules a schema cannot state. Problems are returned, never thrown, so the runner can exit 2 with all of them.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Validator } from '@cfworker/json-schema';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');
export const REGISTER = join(REPO, 'docs', 'reference', 'parity', 'intentional-differences.json');
export const SCHEMA = join(REPO, 'docs', 'reference', 'parity', 'intentional-differences.schema.json');

/** The 42 v5 navigation ids, from GRS-9's committed summary. */
export const viewIds = () => JSON.parse(readFileSync(join(REPO, 'docs', 'reference', 'v5-summary.json'), 'utf8')).nav.items.map((i) => i.id);

/** The view registry's owners (view id -> owning Linear id), from the generated src/lib/components/view-registry.ts. */
export async function registryOwners(root = REPO) {
	const { VIEWS } = await import(join(root, 'src', 'lib', 'components', 'view-registry.ts'));
	return Object.fromEntries(VIEWS.map((v) => [v.id, v.linear]));
}

/**
 * One person's identity for the self-approval rule: NFKC, case-folded, with zero-width characters and every space
 * (non-breaking ones included) removed, so `Worker`, `worker `, `wor\u00a0ker` and `wor\u200bker` are one identity.
 */
export const identityKey = (s) => String(s).normalize('NFKC').toUpperCase().toLowerCase().replace(/[\s\u200b-\u200d\u2060\ufeff\u00ad]/gu, '');

/**
 * Validate a parsed register. `views`: allowed view ids; `owners`: view id -> owning Linear id (the generated view
 * registry), used to check not-yet-implemented entries name the view's real owner.
 */
export function validateRegister(doc, { views = viewIds(), owners = null } = {}) {
	const problems = [];
	const v = new Validator(JSON.parse(readFileSync(SCHEMA, 'utf8')), '2020-12', false);
	const r = v.validate(doc);
	if (!r.valid) for (const e of r.errors) problems.push(`schema: ${e.instanceLocation} ${e.error}`);
	if (!Array.isArray(doc?.entries)) return problems;
	const ids = new Set();
	for (const e of doc.entries) {
		const at = `${e.id ?? '?'}`;
		if (ids.has(e.id)) problems.push(`${at}: duplicate id`);
		ids.add(e.id);
		if (!views.includes(e.view)) problems.push(`${at}: unknown view ${JSON.stringify(e.view)}`);
		if (e.approvedBy && identityKey(e.approvedBy) === identityKey(e.author)) problems.push(`${at}: approver must not be the author`);
		if (!!e.approvedBy !== !!e.approvedOn) problems.push(`${at}: approvedBy and approvedOn go together`);
		if (e.type === 'not-yet-implemented' && e.field === '*' && owners && owners[e.view] && e.owner !== owners[e.view]) problems.push(`${at}: owner ${e.owner} is not the view's owner ${owners[e.view]}`);
		// no case values: a field glob names structure, so long digit runs or e-mail-like text do not belong in it
		if (/\d{4,}|@/.test(JSON.stringify(e.field)) || /\d{4,}|@/.test(JSON.stringify(e.when ?? {}))) problems.push(`${at}: field or condition looks like a case value (digit run or @)`);
	}
	return problems;
}

export function loadRegister(file = REGISTER, opts) {
	let doc;
	try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { entries: [], problems: [`cannot read ${file}: ${e.message}`] }; }
	return { entries: doc.entries ?? [], problems: validateRegister(doc, opts) };
}
