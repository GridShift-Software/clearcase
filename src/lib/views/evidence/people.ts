// People and Entities (v5 people L526-531, entity_ledger_tab L533-538): imported correspondents and bodies, shown in
// data order with their raw values. Browser-safe and pure.
// BA-07: names, organisations and roles are inferred by processing, never reviewed. The views say so, show a role only
// under an "inferred, unverified" heading, and mark an address that looks automated; they never label anyone a
// verified attorney (or anything else) and never change the raw values.
export interface Person { name: string; email: string; org: string; sent: number | string; received: number | string; total: number | string; role: string }
export interface Entity { name: string; role: string; note: string }

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? v : '');

export const people = (data: unknown): Person[] | null => (Array.isArray(data) ? data.map((x: Record<string, unknown>) => ({ name: str(x?.name), email: str(x?.email), org: str(x?.org), sent: num(x?.sent), received: num(x?.received), total: num(x?.total), role: str(x?.role) })) : null);
export const entities = (data: unknown): Entity[] | null => (Array.isArray(data) ? data.map((x: Record<string, unknown>) => ({ name: str(x?.name), role: str(x?.role), note: str(x?.note) })) : null);

/** An address whose local part names a machine sender (no-reply, mailer-daemon, notifications, …). A hint, not a finding. */
export const looksAutomated = (email: string) => /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|notifications?|notify|alerts?|bounces?|auto[-_.]?(reply|mailer)?|system|daemon)([+._-][^@]*)?@/i.test(email.trim());

/** Whether any person carries an imported role (the Role column carries information only then). */
export const anyRole = (ps: readonly Person[]) => ps.some((p) => p.role.trim() !== '');
