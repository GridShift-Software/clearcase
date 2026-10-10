// Conflict Check (conflict_tab): screens a query against this matter's people and entities only, exactly as v5 does
// (view-checklist "Conflict Check"). Copied as recorded: substring over space-joined fields, so matches can span field
// boundaries and short queries match widely (S-conflict_tab-2); no Enter handler (S-conflict_tab-3, in the page); the
// match and haystack concatenate e-mail and org unguarded (S-conflict_tab-4). Browser-safe.

export interface ConflictPerson { name: string; email: string; org: string }
export interface ConflictEntity { name: string; role: string; note: string }
export interface ConflictHit { kind: 'Correspondent' | 'Entity'; match: string; detail: string }
export interface ConflictResult { query: string; hits: ConflictHit[] }

/** v5 string concatenation of a field: a missing value prints as 'undefined' (S-conflict_tab-4, copied). */
const cat = (v: unknown) => String(v);
const has = (v: unknown) => !!v; // JavaScript truthiness, as v5's `p.email?` and `e.role||` tests

/** The select's options: entities, then people, in data order, no sort, no de-duplication. */
export function conflictOptions(entities: readonly Readonly<Record<string, unknown>>[], people: readonly Readonly<Record<string, unknown>>[]): { value: string; label: string }[] {
	return [
		...entities.map((e) => ({ value: cat(e.name), label: `${cat(e.name)} — ${has(e.role) ? cat(e.role) : 'entity'}` })),
		...people.map((p) => ({
			value: cat(p.name) + (has(p.email) ? ` <${cat(p.email)}>` : ''),
			label: cat(p.name) + (has(p.email) ? ` · ${cat(p.email)}` : '') + (has(p.org) ? ` (${cat(p.org)})` : ''),
		})),
	];
}

/** v5 pickConflict: the picked value with a trailing ' <email>' removed, so a person is searched by name only. */
export const pickedQuery = (v: string) => (v || '').replace(/\s*<[^>]+>$/, '');

/** v5 runConflict: null for an empty query (results cleared), else the hits, people first, then entities. */
export function matchConflict(input: string, people: readonly Readonly<Record<string, unknown>>[], entities: readonly Readonly<Record<string, unknown>>[]): ConflictResult | null {
	const q = (input || '').trim().toLowerCase();
	if (!q) return null;
	const hits: ConflictHit[] = [];
	for (const p of people) if (`${cat(p.name)} ${cat(p.email)} ${cat(p.org)}`.toLowerCase().includes(q)) hits.push({ kind: 'Correspondent', match: `${cat(p.name)} (${cat(p.email)})`, detail: cat(p.org) });
	for (const e of entities) if (`${cat(e.name)} ${cat(e.role)} ${cat(e.note)}`.toLowerCase().includes(q)) hits.push({ kind: 'Entity', match: cat(e.name), detail: cat(e.role) });
	return { query: q, hits };
}

/** v5's result wording: the no-match line (shown with neutral styling in the app) and the match count line. */
export const noMatchText = (q: string) => `No conflict match found for "${q}"`;
export const matchCountText = (n: number) => `${n} potential match(es) — review before acting`;

/** A generic input hint with no personal data (S-conflict_tab-1, corrected: v5 showed a real company and e-mail). */
export const QUERY_PLACEHOLDER = 'e.g. a person, a firm or part of an e-mail address';
