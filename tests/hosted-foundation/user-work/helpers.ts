import { expect } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type * as C from '../../../src/lib/server/runtime/contracts.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { canonical, sha256Hex } from '../../../src/lib/user-work/hosted/validate.ts';
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

/** An explicitly historical pre-atomic note row and ledger, with the original schema/digests. */
export async function historicalNote(db: DatabaseSync, actor: C.IdentityState, request: C.CreateScope & { target: C.NoteTarget; body: string }) {
 if (actor.kind !== 'verified') throw new Error('synthetic historical actor must be verified');
 const at = '2026-10-25T00:00:00.000Z', version = id('row-version', `historical-${request.operationId}`), revision = id('case-revision', `historical-${request.operationId}`);
 const note: C.HostedNote = { id: `historical-${request.operationId}`, target: request.target, body: request.body, createdAt: at, status: 'here', candidates: [], intact: true };
 const event: C.AuditEvent = { eventId: `uw:${await sha256Hex(canonical([CLIENT, request.caseId, request.operationId]))}`, actor: { kind: 'verified', principal: actor.principal, sessionId: actor.sessionId }, action: 'user-work.note-add', object: { kind: 'case', id: request.caseId, caseId: request.caseId }, version, outcome: 'succeeded', at };
 const digest = await sha256Hex(canonical({ kind: 'note-add', caseId: request.caseId, payload: { target: request.target, body: request.body }, principal: [actor.principal.issuer, actor.principal.subject, actor.principal.kind] }));
 const anchor = request.target.kind === 'document' ? request.target.anchor : null;
 db.prepare('INSERT INTO uw_note (case_id,note_id,target_kind,anchor_results_version,anchor_ref,anchor_sha256,target_json,body,body_sha256,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
   .run(request.caseId, note.id, request.target.kind, anchor?.resultsVersion ?? null, anchor?.refAtCreation ?? null, anchor?.sha256 ?? null, JSON.stringify(request.target), request.body, await sha256Hex(request.body), at, version);
 db.prepare('INSERT INTO uw_case (case_id,revision,updated_at) VALUES (?,?,?)').run(request.caseId, revision, at);
 db.prepare('INSERT INTO uw_operation (case_id,operation_id,request_sha256,result_json,prior_revision,revision,event_json,created_at,audited_at) VALUES (?,?,?,?,?,?,?,?,NULL)')
   .run(request.caseId, request.operationId, digest, JSON.stringify({ kind: 'written', value: note, version, caseRevision: revision }), 'revision-0', revision, JSON.stringify(event), at);
}
