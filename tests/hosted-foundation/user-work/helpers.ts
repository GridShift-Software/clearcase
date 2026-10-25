import { expect } from 'vitest';
import { createD1UserWork } from '../../../src/lib/user-work/hosted/index.ts';
import { auditLog, authority, bind, CASE, caseReader, CLIENT, d1, database, LIMITS, RV1, SHA_A } from './world.ts';
export { CASE, RV1 };
export function fixture() {
 const db = database(); bind(db);
 const auth = authority(); auth.grant('editor', CASE, 'editor');
 const audit = auditLog();
 const reader = caseReader({ published: RV1, versions: { [RV1]: [{ ref: 'D-001', sha256: SHA_A }] } });
 const make = (subject = 'editor') => createD1UserWork({ db: d1(db), config: { clientId: CLIENT, limits: LIMITS }, identity: auth.identity(subject), audit: audit.sink, store: reader.reader, now: () => new Date('2026-10-25T00:00:00.000Z') });
 return { db, auth, audit, reader, make };
}
export function written(r: any) { expect(r.kind).toBe('written'); return r; }
