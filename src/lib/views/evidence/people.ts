export interface Person { name: string; email: string; org: string; sent: number | string; received: number | string; total: number | string; role: string }
export interface Entity { name: string; role: string; note: string }

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' || typeof v === 'string' ? v : '');

export const people = (data: unknown): Person[] | null => (Array.isArray(data) ? data.map((x: Record<string, unknown>) => ({ name: str(x?.name), email: str(x?.email), org: str(x?.org), sent: num(x?.sent), received: num(x?.received), total: num(x?.total), role: str(x?.role) })) : null);
export const entities = (data: unknown): Entity[] | null => (Array.isArray(data) ? data.map((x: Record<string, unknown>) => ({ name: str(x?.name), role: str(x?.role), note: str(x?.note) })) : null);

export const looksAutomated = (email: string) => /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|notifications?|notify|alerts?|bounces?|auto[-_.]?(reply|mailer)?|system|daemon)([+._-][^@]*)?@/i.test(email.trim());

export const anyRole = (ps: readonly Person[]) => ps.some((p) => p.role.trim() !== '');
