// Conflict Check (conflict_tab): screens a query against this matter's people and entities only, exactly as v5 does
// (view-checklist "Conflict Check"). Copied as recorded: substring over space-joined fields, so matches can span field
// boundaries and short queries match widely (S-conflict_tab-2); no Enter handler (S-conflict_tab-3, in the page); the
// match and haystack concatenate e-mail and org unguarded (S-conflict_tab-4). Matching folds case, width and diacritics
// (GRS-18 r2, D21). Browser-safe.

export interface ConflictPerson { name: string; email: string; org: string }
export interface ConflictEntity { name: string; role: string; note: string }
export interface ConflictHit { kind: 'Correspondent' | 'Entity'; match: string; detail: string }
export interface ConflictResult { query: string; hits: ConflictHit[] }

/** v5 string concatenation of a field: a missing value prints as 'undefined' (S-conflict_tab-4, copied). */
const cat = (v: unknown) => String(v);
const has = (v: unknown) => !!v; // JavaScript truthiness, as v5's `p.email?` and `e.role||` tests

/**
 * The select's options: entities, then people, in data order, no sort, no de-duplication. A value is the option's
 * index (GRS-18 r2, D21): the query a pick runs is the party's name, never parsed back out of the option text, so a
 * name or e-mail containing `<` or `>` is searched as it is (v5 stripped any trailing `<…>`).
 */
export function conflictOptions(entities: readonly Readonly<Record<string, unknown>>[], people: readonly Readonly<Record<string, unknown>>[]): { value: string; label: string; query: string }[] {
	return [
		...entities.map((e) => ({ label: `${cat(e.name)} — ${has(e.role) ? cat(e.role) : 'entity'}`, query: cat(e.name) })),
		...people.map((p) => ({ label: cat(p.name) + (has(p.email) ? ` · ${cat(p.email)}` : '') + (has(p.org) ? ` (${cat(p.org)})` : ''), query: cat(p.name) })),
	].map((o, i) => ({ value: String(i), ...o }));
}

/**
 * The form both sides are compared in (GRS-18 r2, D21; an improvement on v5's toLowerCase only): compatibility
 * decomposition (full-width letters become plain ones), diacritics removed (a dotted capital I becomes I), lower case,
 * and ß as ss. A missed conflict matters more than a wider match.
 */
export const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');

/** v5 runConflict: null for an empty query (the page says what to enter), else the hits, people first, then entities. */
export function matchConflict(input: string, people: readonly Readonly<Record<string, unknown>>[], entities: readonly Readonly<Record<string, unknown>>[]): ConflictResult | null {
	const shown = (input || '').trim().toLowerCase();
	const q = fold(shown).trim();
	if (!q) return null;
	const hits: ConflictHit[] = [];
	for (const p of people) if (fold(`${cat(p.name)} ${cat(p.email)} ${cat(p.org)}`).includes(q)) hits.push({ kind: 'Correspondent', match: `${cat(p.name)} (${cat(p.email)})`, detail: cat(p.org) });
	for (const e of entities) if (fold(`${cat(e.name)} ${cat(e.role)} ${cat(e.note)}`).includes(q)) hits.push({ kind: 'Entity', match: cat(e.name), detail: cat(e.role) });
	return { query: shown, hits };
}

/** What the page says when Check runs with nothing to search for (GRS-18 r2, D21: v5 cleared the result silently). */
export const EMPTY_QUERY = 'Enter a name, firm or e-mail address, or pick a party from the list, then press Check.';

/** v5's result wording: the no-match line (shown with neutral styling in the app) and the match count line. */
export const noMatchText = (q: string) => `No conflict match found for "${q}"`;
export const matchCountText = (n: number) => `${n} potential match(es) — review before acting`;

/** A generic input hint with no personal data (S-conflict_tab-1, corrected: v5 showed a real company and e-mail). */
export const QUERY_PLACEHOLDER = 'e.g. a person, a firm or part of an e-mail address';
