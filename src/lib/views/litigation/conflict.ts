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
const has = (v: unknown) => !!v;

export function conflictOptions(entities: readonly Readonly<Record<string, unknown>>[], people: readonly Readonly<Record<string, unknown>>[]): { value: string; kind: 'entity' | 'person'; label: string; query: string }[] {
	return [
		...entities.map((e) => ({ kind: 'entity' as const, label: `${cat(e.name)} — ${has(e.role) ? cat(e.role) : 'entity'}`, query: cat(e.name) })),
		...people.map((p) => ({ kind: 'person' as const, label: cat(p.name) + (has(p.email) ? ` · ${cat(p.email)}` : '') + (has(p.org) ? ` (${cat(p.org)})` : ''), query: cat(p.name) })),
	].map((o, i) => ({ value: String(i), ...o }));
}

export const fold = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss');

export function matchConflict(input: string, people: readonly Readonly<Record<string, unknown>>[], entities: readonly Readonly<Record<string, unknown>>[]): ConflictResult | null {
	const shown = (input || '').trim().toLowerCase();
	const q = fold(shown).trim();
	if (!q) return null;
	const hits: ConflictHit[] = [];
	for (const p of people) if (fold(`${cat(p.name)} ${cat(p.email)} ${cat(p.org)}`).includes(q)) hits.push({ kind: 'Correspondent', match: `${cat(p.name)} (${cat(p.email)})`, detail: cat(p.org) });
	for (const e of entities) if (fold(`${cat(e.name)} ${cat(e.role)} ${cat(e.note)}`).includes(q)) hits.push({ kind: 'Entity', match: cat(e.name), detail: cat(e.role) });
	return { query: shown, hits };
}

export const EMPTY_QUERY = 'Enter a name, firm or e-mail address, or pick a party from the list, then press Check.';

export const noMatchText = (q: string) => `No conflict match found for "${q}"`;
export const matchCountText = (n: number) => `${n} potential match(es) — review before acting`;

export const QUERY_PLACEHOLDER = 'e.g. a person, a firm or part of an e-mail address';
