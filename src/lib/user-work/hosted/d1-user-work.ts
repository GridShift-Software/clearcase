// GRS-117: the hosted AsyncUserWork over one client's own D1 database (uw_* tables, migrations/0001_uw_user_work.sql).
//
// Every write is one guarded D1 batch: the first statement fails the batch unless the case's user-work revision is the
// one the write read and the database is bound to this deployment's client and schema version, so a competing writer
// can never be overwritten. The same batch records the operation in uw_operation with its request digest, result and
// audit event. Fresh note changes require AuditSink.atomic; every other fresh change commits its audit in that batch too
// whenever the sink offers AuditSink.atomic. Only a sink without it, and historical unaudited ledgers, keep
// append-and-replay recovery under the same operationId.
// A failed batch is never taken as success or failure on its own: the ledger and revision are read back to decide.
import type * as C from '../../server/runtime/contracts.ts';
import type { D1, D1Statement } from '../../server/runtime/hosted/bindings.ts';
import { contractError, isDenial } from '../../server/runtime/errors.ts';
import { id, sha256 } from '../../server/runtime/ids.ts';
import { viewSeeds } from '../../case-package/user-work.ts';
import {
  AnchorCheck, BUILTINS, NoteRowCheck, OverlayCheck, RegisterRowCheck, TargetCheck, body, builtin, canonical, cells, definition,
  fields, invalid, isBuiltin, isReserved, operationId, parsed, rowIdOf, sha256Hex, storeName, tableKey,
} from './validate.ts';

/** The uw_binding schema version this adapter reads and writes. Any other version refuses everything (no auto-upgrade). */
export const USER_WORK_SCHEMA_VERSION = 1;
export const USER_WORK_FORMAT = 'clearcase.user-work/1';
/** Hard ceilings for the required limits. They are conservative bounds the parent narrows, not measured D1 limits. */
export const USER_WORK_CEILINGS: D1UserWorkLimits = { maxStatementsPerBatch: 1000, maxSnapshotBytes: 2_000_000 };
const MAX_ATTEMPTS = 8;
const INITIAL_REVISION = id('case-revision', 'revision-0');

export interface D1UserWorkLimits {
  /** Most statements in one guarded batch; a larger write or restore is refused whole (`invalid`), never split. */
  maxStatementsPerBatch: number;
  /** Largest canonical snapshot (export) in UTF-8 bytes that snapshots.put and importAll accept. */
  maxSnapshotBytes: number;
}
/** Trusted deployment configuration: the one client this deployment serves, never a value from a request. */
export interface D1UserWorkConfig { clientId: C.ClientId; limits: D1UserWorkLimits }
/** Trusted parent hook: explicit administration/provisioning grants or an exact feature-definition catalogue.
 * Authentication, a case grant or a principal kind/role alone must never implement this authority.
 * The parent checks current authority for this actor and the complete normalized definition; throw on refusal.
 */
export interface UserWorkDefinitionAuthority {
  authorize(a: { clientId: C.ClientId; actor: C.IdentityState; definition: C.UserWorkTable }): Promise<void>;
}
export interface D1UserWorkOptions {
  /** The client's own D1 binding, or null when the deployment has none (every call then refuses). */
  db: D1 | null;
  config: D1UserWorkConfig;
  /** The request's identity service: revocation and case authorization are asked again on every operation. */
  identity: C.Identity;
  /** Absent/null refuses client-global definitions, including implicit restore definitions. Never derived from sign-in. */
  tableDefinitions?: UserWorkDefinitionAuthority | null;
  /** The request's audit sink; a write succeeds only after its event is acknowledged here. */
  audit: C.AuditSink;
  /** The request's case reader, for anchors, fingerprints, seeds and the published version. */
  store: C.CaseReader;
  now(): Date;
}
/** What a refused write did: nothing, possibly something (the response was lost), or a durable write awaiting audit. */
export type WorkOutcome = 'not-written' | 'unknown' | 'written-unaudited';
export type UserWorkFailure = C.ContractError<'storage-unavailable' | 'audit-unavailable'> & { readonly outcome: WorkOutcome };
export type D1UserWork = C.AsyncUserWork;

/** Checks trusted configuration; throws TypeError when it is unusable (there are no defaults). */
export function userWorkConfig(value: unknown): D1UserWorkConfig {
  const v = value as Partial<D1UserWorkConfig> | null;
  if (!v || typeof v !== 'object' || typeof v.clientId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(v.clientId)) throw new TypeError('user-work config needs the deployment clientId');
  const limits = v.limits as Partial<D1UserWorkLimits> | undefined;
  if (!limits || typeof limits !== 'object') throw new TypeError('user-work config needs limits');
  for (const key of Object.keys(USER_WORK_CEILINGS) as (keyof D1UserWorkLimits)[]) {
    const n = limits[key];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > USER_WORK_CEILINGS[key]) throw new TypeError(`user-work limit ${key} must be an integer from 1 to ${USER_WORK_CEILINGS[key]}`);
  }
  if (limits.maxStatementsPerBatch! < 8) throw new TypeError('user-work limit maxStatementsPerBatch must be at least 8');
  return Object.freeze({ clientId: v.clientId as C.ClientId, limits: Object.freeze({ maxStatementsPerBatch: limits.maxStatementsPerBatch!, maxSnapshotBytes: limits.maxSnapshotBytes! }) });
}

const failure = (code: 'storage-unavailable' | 'audit-unavailable', outcome: WorkOutcome, retryable: boolean): UserWorkFailure => Object.assign(contractError(code, retryable), { outcome });
const isConstraintFailure = (e: unknown) => e instanceof Error && /constraint|NOT NULL/i.test(e.message);
const token = () => id('row-version', crypto.randomUUID());
const nextRevision = () => id('case-revision', crypto.randomUUID());
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function caseOf(scope: C.Scope): C.CaseId { if (!scope || typeof scope.caseId !== 'string' || !CASE_ID.test(scope.caseId)) invalid(); return scope.caseId; }
function compare(expected: C.Expected, current: { version: string } | null | undefined): 'stale' | 'gone' | null {
  if (!expected || (expected.kind !== 'absent' && expected.kind !== 'match')) invalid();
  if (expected.kind === 'absent') return current ? 'stale' : null;
  return !current ? 'gone' : current.version !== expected.version ? 'stale' : null;
}
const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

type Ledger = { request_sha256: string; result_json: string; event_json: string; audited_at: string | null };
type Plan<T> = { kind: 'stale' | 'gone' } | { kind: 'written'; value: T; statements: D1Statement[]; collision?: () => Promise<Error | null>; beforeCommit?: () => Promise<void> };
/** `audited` is the time the change's own audit commits in its batch, or null when it is appended after the batch. */
type Step = { revision: C.CaseRevision; version: C.WorkVersion; next: C.CaseRevision; at: string; event: C.AuditEvent; audited: string | null };
type NoteDb = { note_id: string; target_json: string; body: string; body_sha256: string; created_at: string; version: string };
type RegisterDb = { row_id: string; store: string; anchor_json: string | null; fields_json: string; fields_sha256: string; created_at: string; updated_at: string; version: string };
type OverlayDb = { dataset_key: string; seed_id: string; base_seed_sha256: string; fields_json: string; version: string };

/** The current user-work revision of a case, for the composed CaseReader's stateRevision (which authorizes the read). */
export function d1WorkRevision(o: { db: D1 | null; config: D1UserWorkConfig }): (scope: C.Scope) => Promise<C.CaseRevision> {
  const config = userWorkConfig(o.config), gate = bindingGate(o.db, config);
  return async (scope) => { const caseId = caseOf(scope); const db = await gate(); return revisionOf(db, caseId); };
}
async function revisionOf(db: D1, caseId: C.CaseId): Promise<C.CaseRevision> {
  const row = await db.prepare('SELECT revision FROM uw_case WHERE case_id = ?').bind(caseId).first<{ revision: string }>().catch(() => { throw contractError('storage-unavailable', true); });
  return row ? id('case-revision', row.revision) : INITIAL_REVISION;
}
/** The binding gate: uw_binding must name this client and schema version. A success is kept for this factory only;
 * concurrent callers share one check, and a failed check is asked again by the next caller. */
function bindingGate(db: D1 | null, config: D1UserWorkConfig): () => Promise<D1> {
  let checked: Promise<D1> | null = null;
  return async () => {
    if (!db) throw contractError('storage-unavailable');
    checked ??= (async () => {
      const row = await db.prepare('SELECT client_id, schema_version FROM uw_binding WHERE singleton = 1').first<{ client_id: string; schema_version: number }>().catch(() => { throw contractError('storage-unavailable', true); });
      if (!row || row.client_id !== config.clientId || Number(row.schema_version) !== USER_WORK_SCHEMA_VERSION) throw contractError('storage-unavailable');
      return db;
    })().catch((e: unknown) => { checked = null; throw e; });
    return checked;
  };
}

export function createD1UserWork(options: D1UserWorkOptions): D1UserWork {
  const { identity, audit, store, now } = options;
  if (!identity || typeof identity.authorize !== 'function' || typeof identity.checkRevocation !== 'function') throw new TypeError('user work needs the request identity');
  if (!audit || typeof audit.append !== 'function') throw new TypeError('user work needs an AuditSink');
  if (!store || typeof now !== 'function') throw new TypeError('user work needs the case reader and a clock');
  if (options.tableDefinitions != null && typeof options.tableDefinitions.authorize !== 'function') throw new TypeError('user work needs a definition authorizer or null');
  const config = userWorkConfig(options.config), gate = bindingGate(options.db, config), limits = config.limits;
  const at = () => now().toISOString();
  const actor = (): C.IdentityState => identity.kind === 'verified' ? { kind: 'verified', principal: { issuer: identity.principal.issuer, subject: identity.principal.subject, kind: identity.principal.kind }, sessionId: identity.sessionId } : { kind: 'anonymous', principal: null, sessionId: null };
  const principalKey = () => identity.kind === 'verified' ? [identity.principal.issuer, identity.principal.subject, identity.principal.kind] : null;

  async function denied(caseId: C.CaseId | null, action: string) {
    try { await audit.append({ eventId: `uw-denied:${crypto.randomUUID()}`, actor: actor(), action, object: caseId ? { kind: 'case', id: caseId, caseId } : { kind: 'user-work', id: 'tables', caseId: null }, version: null, outcome: 'denied', at: at() }); } catch { /* the refusal stands */ }
  }
  async function standing() {
    if (identity.clientId !== config.clientId) throw contractError('wrong-client');
    await identity.checkRevocation();
  }
  /** One public boundary catches denials, including early and nested refusals, without double-appending. */
  async function boundary<T>(caseId: C.CaseId | null, action: string, fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) { if (isDenial(e)) await denied(caseId, action); throw e; }
  }
  async function authorizeDefinition(t: C.UserWorkTable) {
    await standing();
    if (identity.kind !== 'verified') throw contractError('unauthenticated');
    if (!options.tableDefinitions) throw contractError('forbidden');
    await options.tableDefinitions.authorize({ clientId: config.clientId, actor: actor(), definition: structuredClone(t) });
    // The injected authority may await storage; the request's session must still stand afterwards.
    await standing();
  }
  /** Revocation, then the case grant, on every operation. */
  async function authorize(scope: C.Scope, operation: 'read' | 'write-user-work', inlineBinding = false): Promise<{ db: D1; caseId: C.CaseId }> {
    const caseId = caseOf(scope);
    await standing();
    await identity.authorize({ caseId, operation });
    if (inlineBinding) {
      if (!options.db) throw contractError('storage-unavailable');
      return { db: options.db, caseId };
    }
    return { db: await gate(), caseId };
  }
  const read = async <T>(fn: () => Promise<T>): Promise<T> => { try { return await fn(); } catch (e) { if (e instanceof Error && 'code' in e) throw e; throw contractError('storage-unavailable', true); } };
  const ledger = (db: D1, caseId: C.CaseId, op: string) => db.prepare('SELECT request_sha256, result_json, event_json, audited_at FROM uw_operation WHERE case_id = ? AND operation_id = ?').bind(caseId, op).first<Ledger>();

  /** Appends a recorded event and marks it acknowledged; the mark is bookkeeping, so its failure is not a refusal. */
  async function acknowledge(db: D1, eventJson: string, mark: D1Statement[]) {
    try { await audit.append(JSON.parse(eventJson) as C.AuditEvent); }
    catch (e) { throw failure('audit-unavailable', 'written-unaudited', !(e instanceof Error && 'retryable' in e && e.retryable === false)); }
    try { await db.batch([...mark, db.prepare('UPDATE uw_table_definition SET audited_at = ? WHERE event_json = ? AND audited_at IS NULL').bind(at(), eventJson)]); } catch { /* a replay appends the identical event again */ }
  }
  async function finish<T>(db: D1, caseId: C.CaseId, op: string, row: Ledger, request: string): Promise<C.Written<T>> {
    if (row.request_sha256 !== request) invalid(); // a reused operation id with another request or principal
    if (row.audited_at === null) await acknowledge(db, row.event_json, [db.prepare('UPDATE uw_operation SET audited_at = ? WHERE case_id = ? AND operation_id = ? AND audited_at IS NULL').bind(at(), caseId, op)]);
    return JSON.parse(row.result_json) as C.Written<T>;
  }
  const guardStatement = (db: D1, caseId: C.CaseId, revision: C.CaseRevision) => db.prepare(`INSERT INTO uw_batch_guard (token) SELECT NULL WHERE NOT (
      COALESCE((SELECT revision FROM uw_case WHERE case_id = ?), 'revision-0') = ?
      AND EXISTS (SELECT 1 FROM uw_binding WHERE singleton = 1 AND client_id = ? AND schema_version = ?))`).bind(caseId, revision, config.clientId, USER_WORK_SCHEMA_VERSION);

  async function change<T>(scope: C.Scope & { operationId: string }, kind: string, payload: unknown, expectedRevision: C.CaseRevision | undefined, plan: (db: D1, caseId: C.CaseId, s: Step) => Promise<Plan<T>>): Promise<C.Written<T>> {
    const { db, caseId } = await authorize(scope, 'write-user-work', true);
    const op = operationId(scope.operationId);
    const request = await sha256Hex(canonical({ kind, caseId, payload, principal: principalKey() }));
    const eventId = `uw:${await sha256Hex(canonical([config.clientId, caseId, op]))}`;
    const atomicNote = kind === 'note-add' || kind === 'note-delete';
    // A note change refuses a sink without atomic audit; any other change audits in its batch whenever the sink can.
    const atomic = atomicNote || typeof audit.atomic === 'function';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // The binding gate and both reads come after the authorization above, and nothing is decided until all three
      // answer: one round trip, not three. A missing or foreign binding refuses; the batch's guard checks it again.
      const [, prior, revision] = await Promise.all([gate(), read(() => ledger(db, caseId, op)), revisionOf(db, caseId)]);
      if (prior) {
        // Historical context is irrelevant to replay, but today's session and case grant are not.
        await authorize(scope, 'write-user-work');
        const result = await finish<T>(db, caseId, op, prior, request);
        await authorize(scope, 'write-user-work');
        return result;
      }
      if (expectedRevision !== undefined && revision !== expectedRevision) return { kind: 'stale' };
      const version = token(), when = at();
      const event: C.AuditEvent = { eventId, actor: actor(), action: `user-work.${kind}`, object: { kind: 'case', id: caseId, caseId }, version, outcome: 'succeeded', at: when };
      const step: Step = { revision, version, next: nextRevision(), at: when, event, audited: atomic ? when : null };
      const planned = await plan(db, caseId, step);
      if (planned.kind !== 'written') return { kind: planned.kind };
      const result: C.Written<T> = { kind: 'written', value: planned.value, version: step.version, caseRevision: step.next };
      let auditStatements: readonly D1Statement[] = [];
      if (atomic) {
        if (!audit.atomic) throw failure('audit-unavailable', 'not-written', false);
        try {
          auditStatements = await audit.atomic({ db, event });
          if (!Array.isArray(auditStatements) || !auditStatements.length) throw contractError('audit-unavailable');
        } catch (e) {
          throw failure('audit-unavailable', 'not-written', !(e instanceof Error && 'retryable' in e && e.retryable === false));
        }
      }
      const row: Ledger = { request_sha256: request, result_json: JSON.stringify(result), event_json: JSON.stringify(event), audited_at: step.audited };
      const statements = [
        guardStatement(db, caseId, revision),
        db.prepare('INSERT INTO uw_operation (case_id, operation_id, request_sha256, result_json, prior_revision, revision, event_json, created_at, audited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(caseId, op, request, row.result_json, revision, step.next, row.event_json, step.at, row.audited_at),
        db.prepare('INSERT INTO uw_case (case_id, revision, updated_at) VALUES (?, ?, ?) ON CONFLICT (case_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at').bind(caseId, step.next, step.at),
        ...planned.statements,
        ...auditStatements,
      ];
      if (statements.length > limits.maxStatementsPerBatch) invalid();
      if (planned.beforeCommit) await planned.beforeCommit();
      else if (atomicNote) await authorize(scope, 'write-user-work');
      try { await db.batch(statements); }
      catch (e) {
        // Decide from durable state, never from the error: the batch may have committed before its response was lost.
        let after: Ledger | null, current: C.CaseRevision;
        try { after = await ledger(db, caseId, op); current = await revisionOf(db, caseId); } catch { throw failure('storage-unavailable', 'unknown', true); }
        if (after) {
          await authorize(scope, 'write-user-work');
          const result = await finish<T>(db, caseId, op, after, request);
          await authorize(scope, 'write-user-work');
          return result;
        }
        if (current !== revision) { if (expectedRevision !== undefined) return { kind: 'stale' }; continue; }
        if (isConstraintFailure(e) && planned.collision) { const refusal = await read(planned.collision); if (refusal) throw refusal; }
        if (atomic && e instanceof Error && /native_audit/i.test(e.message)) throw failure('audit-unavailable', 'not-written', true);
        throw failure('storage-unavailable', 'not-written', true);
      }
      const completed = await finish<T>(db, caseId, op, row, request);
      if (atomicNote) await authorize(scope, 'write-user-work');
      return completed;
    }
    throw failure('storage-unavailable', 'not-written', true);
  }

  // Stored rows -------------------------------------------------------------------------------------------------------
  async function noteOf(n: NoteDb): Promise<C.Versioned<C.HostedNote>> {
    return { id: n.note_id, body: n.body, createdAt: n.created_at, target: JSON.parse(n.target_json) as C.NoteTarget, status: 'here', candidates: [], intact: await sha256Hex(n.body) === n.body_sha256, version: id('row-version', n.version) };
  }
  async function registerOf(r: RegisterDb): Promise<C.Versioned<C.WorkRegisterRow>> {
    return { rowId: r.row_id, store: r.store, anchor: r.anchor_json ? JSON.parse(r.anchor_json) as C.Anchor : null, fields: JSON.parse(r.fields_json) as C.Fields, createdAt: r.created_at, updatedAt: r.updated_at, intact: await sha256Hex(r.fields_json) === r.fields_sha256, version: id('row-version', r.version) };
  }
  const overlayOf = (caseId: C.CaseId, o: OverlayDb): C.Versioned<C.SeedOverlay> => ({ caseId, datasetKey: o.dataset_key, seedId: o.seed_id, baseSeedSha256: o.base_seed_sha256, fields: JSON.parse(o.fields_json) as Record<string, unknown>, version: id('row-version', o.version) });
  const notesOf = (db: D1, caseId: C.CaseId) => read(async () => Promise.all((await db.prepare('SELECT note_id, target_json, body, body_sha256, created_at, version FROM uw_note WHERE case_id = ? ORDER BY rowid').bind(caseId).all<NoteDb>()).results.map(noteOf)));
  const overlaysOf = (db: D1, caseId: C.CaseId) => read(async () => (await db.prepare('SELECT dataset_key, seed_id, base_seed_sha256, fields_json, version FROM uw_seed_overlay WHERE case_id = ? ORDER BY rowid').bind(caseId).all<OverlayDb>()).results.map((o) => overlayOf(caseId, o)));
  const registerRowsOf = (db: D1, caseId: C.CaseId, name: string | null) => read(async () => Promise.all((await (name === null
    ? db.prepare('SELECT row_id, store, anchor_json, fields_json, fields_sha256, created_at, updated_at, version FROM uw_register_row WHERE case_id = ? ORDER BY rowid').bind(caseId)
    : db.prepare('SELECT row_id, store, anchor_json, fields_json, fields_sha256, created_at, updated_at, version FROM uw_register_row WHERE case_id = ? AND store = ? ORDER BY rowid').bind(caseId, name)).all<RegisterDb>()).results.map(registerOf)));
  const definitions = (db: D1) => read(async () => (await db.prepare('SELECT definition_json FROM uw_table_definition ORDER BY rowid').all<{ definition_json: string }>()).results.map((r) => JSON.parse(r.definition_json) as C.UserWorkTable));
  /** Definitions read by this request, by name. A definition is never changed or removed once stored, so a later
   * read in the same request (the table read before a write) reuses it. A missing definition is never kept. */
  const knownDefinitions = new Map<string, { owner: string; definition_json: string }>();
  function ownedOf(name: string, row: { owner: string; definition_json: string } | null | undefined, owner?: string) {
    if (typeof name !== 'string') invalid();
    if (isReserved(name)) throw contractError('table-built-in');
    if (!row) invalid();
    knownDefinitions.set(name, row!);
    if (owner !== undefined && row!.owner !== owner) throw contractError('table-conflict');
    return JSON.parse(row!.definition_json) as C.UserWorkTable;
  }
  async function owned(db: D1, name: string, owner?: string) {
    if (typeof name !== 'string') invalid();
    if (isReserved(name)) throw contractError('table-built-in');
    const row = knownDefinitions.get(name) ?? await read(() => db.prepare('SELECT owner, definition_json FROM uw_table_definition WHERE name = ?').bind(name).first<{ owner: string; definition_json: string }>());
    return ownedOf(name, row, owner);
  }
  const tableRow = (db: D1, table: string, key: string) => read(() => db.prepare('SELECT case_id, version FROM uw_table_row WHERE table_name = ? AND row_key = ?').bind(table, key).first<{ case_id: string; version: string }>());
  /** After a constraint failure: a key another case holds is a collision, never an overwrite. */
  const collisionOf = (db: D1, caseId: C.CaseId, table: string, keys: readonly string[]) => async () => {
    for (const key of keys) { const row = await tableRow(db, table, key); if (row && row.case_id !== caseId) return contractError('restore-key-collision'); }
    return null;
  };
  function putTableStatement(db: D1, caseId: C.CaseId, table: string, key: string, row: Record<string, C.TableCell>, version: C.WorkVersion, exists: boolean) {
    // An existing key is updated only within its own case; a new key is a plain INSERT, so another case's key fails it.
    return exists
      ? db.prepare('UPDATE uw_table_row SET cells_json = ?, version = ? WHERE table_name = ? AND row_key = ? AND case_id = ?').bind(JSON.stringify(row), version, table, key, caseId)
      : db.prepare('INSERT INTO uw_table_row (table_name, row_key, case_id, cells_json, version) VALUES (?, ?, ?, ?, ?)').bind(table, key, caseId, JSON.stringify(row), version);
  }
  async function noteInsert(db: D1, caseId: C.CaseId, note: C.HostedNote, version: C.WorkVersion) {
    const anchor = note.target.kind === 'document' ? note.target.anchor : null;
    return db.prepare('INSERT INTO uw_note (case_id, note_id, target_kind, anchor_results_version, anchor_ref, anchor_sha256, target_json, body, body_sha256, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(caseId, note.id, note.target.kind, anchor?.resultsVersion ?? (note.target.kind === 'analysis' ? note.target.resultsVersion : null), anchor?.refAtCreation ?? null, anchor?.sha256 ?? null, canonical(note.target), note.body, await sha256Hex(note.body), note.createdAt, version);
  }
  async function registerUpsert(db: D1, caseId: C.CaseId, r: C.WorkRegisterRow, version: C.WorkVersion, exists: boolean) {
    const json = JSON.stringify(r.fields), digest = await sha256Hex(json), anchor = r.anchor ? canonical(r.anchor) : null;
    return exists
      ? db.prepare('UPDATE uw_register_row SET anchor_json = ?, fields_json = ?, fields_sha256 = ?, updated_at = ?, version = ? WHERE case_id = ? AND store = ? AND row_id = ?').bind(anchor, json, digest, r.updatedAt, version, caseId, r.store, r.rowId)
      : db.prepare('INSERT INTO uw_register_row (case_id, store, row_id, anchor_json, fields_json, fields_sha256, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(caseId, r.store, r.rowId, anchor, json, digest, r.createdAt, r.updatedAt, version);
  }
  function overlayUpsert(db: D1, caseId: C.CaseId, o: C.SeedOverlay, version: C.WorkVersion, when: string, exists: boolean) {
    return exists
      ? db.prepare('UPDATE uw_seed_overlay SET base_seed_sha256 = ?, fields_json = ?, version = ?, updated_at = ? WHERE case_id = ? AND dataset_key = ? AND seed_id = ?').bind(o.baseSeedSha256, JSON.stringify(o.fields), version, when, caseId, o.datasetKey, o.seedId)
      : db.prepare('INSERT INTO uw_seed_overlay (case_id, dataset_key, seed_id, base_seed_sha256, fields_json, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(caseId, o.datasetKey, o.seedId, o.baseSeedSha256, JSON.stringify(o.fields), version, when);
  }
  /** One export of a case at a single revision: the revision is read before and after, and a change between retries. */
  async function exportOf(db: D1, caseId: C.CaseId): Promise<C.UserWorkExport> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const before = await revisionOf(db, caseId), out = await exportOnce(db, caseId);
      if (await revisionOf(db, caseId) === before) return out;
    }
    throw contractError('storage-unavailable', true);
  }
  async function exportOnce(db: D1, caseId: C.CaseId): Promise<C.UserWorkExport> {
    const [notes, overlays, rows, defs] = [await notesOf(db, caseId), await overlaysOf(db, caseId), await registerRowsOf(db, caseId, null), await definitions(db)];
    const strip = <T extends { version: C.WorkVersion }>(v: T) => { const { version: _, ...payload } = v; return payload; };
    const tableRows = await read(async () => (await db.prepare('SELECT table_name, cells_json FROM uw_table_row WHERE case_id = ? ORDER BY rowid').bind(caseId).all<{ table_name: string; cells_json: string }>()).results);
    return { format: USER_WORK_FORMAT, exportedAt: at(), tables: [
      { ...builtin('note'), rows: notes.map((n) => ({ case_id: caseId, id: n.id, payload: canonical(strip(n)) })) },
      { ...builtin('seed_overlay'), rows: overlays.map((o) => ({ case_id: caseId, id: JSON.stringify([o.datasetKey, o.seedId]), payload: canonical(strip(o)) })) },
      { ...builtin('register_row'), rows: rows.map((r) => ({ case_id: caseId, id: JSON.stringify([r.store, r.rowId]), payload: canonical(strip(r)) })) },
      ...defs.map((t) => ({ ...t, rows: tableRows.filter((r) => r.table_name === t.name).map((r) => JSON.parse(r.cells_json) as Record<string, C.TableCell>) })),
    ] };
  }
  const withoutTime = (e: C.UserWorkExport) => { const { exportedAt: _, ...rest } = e; return canonical(rest); };
  const sizeOf = (e: unknown) => new TextEncoder().encode(canonical(e)).length;

  const work: D1UserWork = {
    async anchorFor(a) {
      // The binding gate runs beside the row read, after the case grant; a failure of either refuses.
      const { caseId } = await authorize(a, 'read', true);
      const [row] = await Promise.all([store.documentRow({ caseId, resultsVersion: a.resultsVersion, ref: a.ref }), gate()]);
      if (!row) throw contractError('not-found');
      return { caseId, resultsVersion: a.resultsVersion, refAtCreation: a.ref, sha256: row.state.original ? sha256(row.state.original.sha256) : null };
    },
    async resolve(a) {
      const { caseId } = await authorize(a.into, 'read');
      if (!AnchorCheck.Check(a.anchor)) invalid();
      if (a.anchor.caseId !== caseId) throw contractError('forbidden');
      // A ref is never an identity across versions: only the same version keeps it, otherwise the content digest decides.
      if (a.anchor.resultsVersion === a.into.resultsVersion) return { status: 'here', refs: [a.anchor.refAtCreation] };
      if (!a.anchor.sha256) return { status: 'unanchored', refs: [] };
      const refs = (await store.fingerprints({ caseId, resultsVersion: a.into.resultsVersion })).filter((f) => f.sha256 === a.anchor.sha256).map((f) => f.ref).sort();
      return { status: refs.length === 0 ? 'missing' : refs.length === 1 ? 'exact' : 'ambiguous', refs };
    },
    async notesFor(a) {
      const { db, caseId } = await authorize(a, 'read', true);
      if (a.target !== null && !TargetCheck.Check(a.target)) invalid();
      if (a.target?.kind === 'document' && a.target.anchor.caseId !== caseId) throw contractError('forbidden');
      const document = a.target?.kind === 'document' ? a.target.anchor : null;
      // The binding and rows share one read, including the empty case. A missing/wrong binding never looks like zero notes.
      const rows = await read(() => db.prepare(`SELECT n.note_id, n.target_json, n.body, n.body_sha256, n.created_at, n.version
        FROM uw_binding b LEFT JOIN uw_note n ON n.case_id = ?${document ? " AND n.target_kind = 'document' AND n.anchor_results_version = ? AND n.anchor_ref = ?" : ''}
        WHERE b.singleton = 1 AND b.client_id = ? AND b.schema_version = ? ORDER BY n.rowid`)
        .bind(caseId, ...(document ? [document.resultsVersion, document.refAtCreation] : []), config.clientId, USER_WORK_SCHEMA_VERSION).all<NoteDb>());
      if (!rows.results.length) throw contractError('storage-unavailable');
      const notes = await Promise.all(rows.results.filter(n => n.note_id !== null).map(noteOf));
      return a.target === null ? notes : notes.filter((n) => sameJson(n.target, a.target));
    },
    async summary(a) {
      const notes = await work.notesFor({ caseId: a.caseId, target: null });
      const result: C.HostedNoteSummary = { total: notes.length, here: 0, exact: 0, ambiguous: 0, missing: 0, unanchored: 0, byRef: [], detached: [] };
      for (const note of notes) {
        const match = note.target.kind === 'document' && a.resultsVersion ? await work.resolve({ anchor: note.target.anchor, into: { caseId: a.caseId, resultsVersion: a.resultsVersion } }) : { status: note.target.kind === 'case' ? 'here' as const : 'unanchored' as const, refs: [] as string[] };
        result[match.status]++;
        for (const ref of match.refs) { const old = result.byRef.find((r) => r.ref === ref); if (old) old.n++; else result.byRef.push({ ref, n: 1, status: match.status }); }
        if (!match.refs.length && note.target.kind !== 'case') { const { version: _, ...plain } = note; result.detached.push({ ...plain, status: match.status, candidates: match.refs }); }
      }
      return result;
    },
    async addNote(a) {
      const caseId = caseOf(a);
      if (!a.expected || a.expected.kind !== 'absent') invalid();
      if (!TargetCheck.Check(a.target)) invalid();
      const text = body(a.body), target = structuredClone(a.target) as C.NoteTarget;
      if (target.kind === 'document' && target.anchor.caseId !== caseId) throw contractError('forbidden');
      const result = await change<C.HostedNote>(a, 'note-add', { target, body: a.body }, undefined, async (db, _, s) => {
        // Only a genuinely new operation needs the old results context to remain visible.
        if (target.kind === 'document') {
          const row = await store.documentRow({ caseId, resultsVersion: target.anchor.resultsVersion, ref: target.anchor.refAtCreation });
          const digest = row?.state.original ? row.state.original.sha256 : null;
          if (!row || digest !== target.anchor.sha256) invalid();
        }
        if (target.kind === 'analysis') await store.documentRows({ caseId, resultsVersion: target.resultsVersion });
        const note: C.HostedNote = { id: crypto.randomUUID(), body: text, createdAt: s.at, target, status: 'here', candidates: [], intact: true };
        return { kind: 'written', value: note, statements: [await noteInsert(db, caseId, note, s.version)], beforeCommit: async () => { await authorize(a, 'write-user-work'); } };
      });
      // change() rechecks current authority before commit and before releasing either a fresh result or a replay.
      return result;
    },
    async deleteNote(a) {
      if (!a.expected || a.expected.kind !== 'match') invalid();
      const noteId = rowIdOf(a.id);
      return change<boolean>(a, 'note-delete', { id: noteId, expected: a.expected }, undefined, async (db, caseId) => {
        const current = await read(() => db.prepare('SELECT version FROM uw_note WHERE case_id = ? AND note_id = ?').bind(caseId, noteId).first<{ version: string }>());
        const conflict = compare(a.expected, current); if (conflict) return { kind: conflict };
        return { kind: 'written', value: true, statements: [db.prepare('DELETE FROM uw_note WHERE case_id = ? AND note_id = ? AND version = ?').bind(caseId, noteId, current!.version)] };
      });
    },
    async seedRows(a) {
      const { caseId } = await authorize(a, 'read');
      return (await store.seeds({ caseId, resultsVersion: a.resultsVersion })).filter((s) => a.datasetKey === undefined || s.datasetKey === a.datasetKey);
    },
    async overlays(a) {
      const { db, caseId } = await authorize(a, 'read');
      return (await overlaysOf(db, caseId)).filter((o) => a.datasetKey === undefined || o.datasetKey === a.datasetKey);
    },
    async seedViews(a) {
      const seeds = await work.seedRows(a), overlays = await work.overlays(a);
      return viewSeeds(seeds, overlays).map((view) => {
        const seedId = 'seed' in view ? view.seed.seedId : view.overlay.seedId, datasetKey = 'seed' in view ? view.seed.datasetKey : view.overlay.datasetKey;
        return { ...view, version: overlays.find((o) => o.seedId === seedId && o.datasetKey === datasetKey)?.version ?? id('row-version', `seed:${'seed' in view ? view.seed.seedSha256 : 'absent'}`) };
      });
    },
    async putSeedOverlay(a) {
      const caseId = caseOf(a);
      if (!OverlayCheck.Check(a.overlay)) invalid();
      if (a.overlay.caseId !== caseId) throw contractError('forbidden');
      const overlay: C.SeedOverlay = { ...structuredClone(a.overlay), fields: fields(a.overlay.fields) };
      return change<void>(a, 'overlay-put', { overlay, expected: a.expected }, undefined, async (db, _, s) => {
        const current = await read(() => db.prepare('SELECT version FROM uw_seed_overlay WHERE case_id = ? AND dataset_key = ? AND seed_id = ?').bind(caseId, overlay.datasetKey, overlay.seedId).first<{ version: string }>());
        const conflict = compare(a.expected, current); if (conflict) return { kind: conflict };
        return { kind: 'written', value: undefined, statements: [overlayUpsert(db, caseId, overlay, s.version, s.at, !!current)] };
      });
    },
    async listRows(a) {
      storeName(a.store);
      const { db, caseId } = await authorize(a, 'read', true);
      // The binding and rows share one read, as in notesFor: a missing or foreign binding never looks like an empty store.
      const rows = await read(async () => (await db.prepare(`SELECT r.row_id, r.store, r.anchor_json, r.fields_json, r.fields_sha256, r.created_at, r.updated_at, r.version
        FROM uw_binding b LEFT JOIN uw_register_row r ON r.case_id = ? AND r.store = ?
        WHERE b.singleton = 1 AND b.client_id = ? AND b.schema_version = ? ORDER BY r.rowid`)
        .bind(caseId, a.store, config.clientId, USER_WORK_SCHEMA_VERSION).all<RegisterDb>()).results);
      if (!rows.length) throw contractError('storage-unavailable');
      return read(() => Promise.all(rows.filter((r) => r.row_id !== null).map(registerOf)));
    },
    async readViewWork(a) {
      const caseId = caseOf(a), name = a.store, datasetKey = a.datasetKey;
      storeName(name);
      if (datasetKey !== undefined) storeName(datasetKey);
      await standing();
      await identity.authorize({ caseId, operation: 'read' });
      const db = options.db;
      if (!db) throw contractError('storage-unavailable');
      // Binding and both stores are one atomic read, including on a fresh request. Do not call gate() first:
      // an absent or foreign binding yields no row, rather than an apparently empty register.
      return read(async () => {
        const snapshot = await db.prepare(`SELECT
          (SELECT json_group_array(json(item)) FROM (
            SELECT json_object('row_id',row_id,'store',store,'anchor_json',anchor_json,'fields_json',fields_json,
              'fields_sha256',fields_sha256,'created_at',created_at,'updated_at',updated_at,'version',version) AS item
            FROM uw_register_row WHERE case_id = ? AND store = ? ORDER BY rowid
          )) AS rows_json,
          (SELECT json_group_array(json(item)) FROM (
            SELECT json_object('dataset_key',dataset_key,'seed_id',seed_id,'base_seed_sha256',base_seed_sha256,
              'fields_json',fields_json,'version',version) AS item
            FROM uw_seed_overlay WHERE case_id = ? AND dataset_key = ? ORDER BY rowid
          )) AS overlays_json
          FROM uw_binding WHERE singleton = 1 AND client_id = ? AND schema_version = ?`)
          .bind(caseId, name, caseId, datasetKey ?? null, config.clientId, USER_WORK_SCHEMA_VERSION)
          .first<{ rows_json: string; overlays_json: string }>();
        if (!snapshot) throw contractError('storage-unavailable');
        return {
          rows: await Promise.all((JSON.parse(snapshot.rows_json) as RegisterDb[]).map(registerOf)),
          overlays: (JSON.parse(snapshot.overlays_json) as OverlayDb[]).map((o) => overlayOf(caseId, o)),
        };
      });
    },
    async putRow(a) {
      const caseId = caseOf(a);
      storeName(a.store);
      const rowId = a.rowId === null ? null : rowIdOf(a.rowId), values = fields(a.fields);
      if (a.anchor !== null && !AnchorCheck.Check(a.anchor)) invalid();
      if (a.anchor && a.anchor.caseId !== caseId) throw contractError('forbidden');
      return change<C.AddResult>(a, 'row-put', { store: a.store, rowId, fields: values, anchor: a.anchor, expected: a.expected }, undefined, async (db, _, s) => {
        const key = rowId ?? crypto.randomUUID();
        const old = await read(() => db.prepare('SELECT created_at, version FROM uw_register_row WHERE case_id = ? AND store = ? AND row_id = ?').bind(caseId, a.store, key).first<{ created_at: string; version: string }>());
        const conflict = compare(a.expected, old); if (conflict) return { kind: conflict };
        const row: C.WorkRegisterRow = { rowId: key, store: a.store, anchor: structuredClone(a.anchor), fields: values, createdAt: old?.created_at ?? s.at, updatedAt: s.at, intact: true };
        return { kind: 'written', value: { rowId: key, repeated: false }, statements: [await registerUpsert(db, caseId, row, s.version, !!old)] };
      });
    },
    async deleteRow(a) {
      storeName(a.store);
      if (!a.expected || a.expected.kind !== 'match') invalid();
      const rowId = rowIdOf(a.rowId);
      return change<boolean>(a, 'row-delete', { store: a.store, rowId, expected: a.expected }, undefined, async (db, caseId) => {
        const current = await read(() => db.prepare('SELECT version FROM uw_register_row WHERE case_id = ? AND store = ? AND row_id = ?').bind(caseId, a.store, rowId).first<{ version: string }>());
        const conflict = compare(a.expected, current); if (conflict) return { kind: conflict };
        return { kind: 'written', value: true, statements: [db.prepare('DELETE FROM uw_register_row WHERE case_id = ? AND store = ? AND row_id = ? AND version = ?').bind(caseId, a.store, rowId, current!.version)] };
      });
    },
    async tables() {
      await standing();
      const db = await gate();
      return [...BUILTINS.map(builtin), ...await definitions(db)];
    },
    async defineTable(a) {
      if (identity.kind !== 'verified') throw contractError('unauthenticated');
      await standing();
      const db = await gate(), t = definition(a?.definition), json = canonical(t);
      await authorizeDefinition(t);
      const event: C.AuditEvent = { eventId: `uw-table:${await sha256Hex(canonical([config.clientId, json]))}`, actor: actor(), action: 'user-work.table-define', object: { kind: 'user-work-table', id: t.name, caseId: null }, version: null, outcome: 'succeeded', at: at() };
      const lookup = () => db.prepare('SELECT definition_json, event_json, audited_at FROM uw_table_definition WHERE name = ?').bind(t.name).first<{ definition_json: string; event_json: string; audited_at: string | null }>();
      let row = await read(lookup);
      if (!row) {
        await authorizeDefinition(t);
        try { await db.prepare('INSERT INTO uw_table_definition (name, owner, definition_json, event_json, created_at, audited_at) VALUES (?, ?, ?, ?, ?, NULL)').bind(t.name, t.owner, json, JSON.stringify(event), event.at).run(); }
        catch { /* decided by the read-back below */ }
        try { row = await lookup(); } catch { throw failure('storage-unavailable', 'unknown', true); }
        if (!row) throw failure('storage-unavailable', 'not-written', true);
      }
      if (row.definition_json !== json) throw contractError('table-conflict');
      if (row.audited_at === null) await acknowledge(db, row.event_json, []);
      await authorizeDefinition(t);
    },
    async registerStores(a) {
      const { db, caseId } = await authorize(a, 'read');
      return read(async () => (await db.prepare('SELECT DISTINCT store FROM uw_register_row WHERE case_id = ? ORDER BY store').bind(caseId).all<{ store: string }>()).results.map((r) => r.store));
    },
    async listTableRows(a) {
      const { db, caseId } = await authorize(a, 'read', true);
      // Binding, definition and rows are one read. No binding row refuses as storage; then the name and definition
      // are checked as owned() checks them, and only an owned table's rows are returned.
      const rows = await read(async () => (await db.prepare(`SELECT d.owner, d.definition_json, r.cells_json, r.version
        FROM uw_binding b LEFT JOIN uw_table_definition d ON d.name = ?
        LEFT JOIN uw_table_row r ON d.name IS NOT NULL AND r.case_id = ? AND r.table_name = d.name
        WHERE b.singleton = 1 AND b.client_id = ? AND b.schema_version = ? ORDER BY r.row_key`)
        .bind(typeof a.table === 'string' ? a.table : null, caseId, config.clientId, USER_WORK_SCHEMA_VERSION)
        .all<{ owner: string | null; definition_json: string | null; cells_json: string | null; version: string | null }>()).results);
      if (!rows.length) throw contractError('storage-unavailable');
      const first = rows[0]!;
      ownedOf(a.table, first.definition_json === null ? null : { owner: first.owner!, definition_json: first.definition_json });
      return rows.filter((r) => r.cells_json !== null)
        .map((r) => ({ cells: JSON.parse(r.cells_json!) as Record<string, C.TableCell>, version: id('row-version', r.version!) }));
    },
    async putTableRow(a) {
      // A rejection is observed here at once; the commit below still waits for it and fails with its reason.
      a.commitAfter?.catch(() => undefined);
      const caseId = caseOf(a);
      return change<void>(a, 'table-row-put', { table: a.table, owner: a.owner, row: a.row, expected: a.expected }, undefined, async (db, _, s) => {
        const t = await owned(db, a.table, a.owner), row = cells(t, a.row, caseId), key = tableKey(t, row), current = await tableRow(db, t.name, key);
        if (current && current.case_id !== caseId) throw contractError('restore-key-collision');
        const conflict = compare(a.expected, current); if (conflict) return { kind: conflict };
        const commitAfter = a.commitAfter;
        return { kind: 'written', value: undefined, statements: [putTableStatement(db, caseId, t.name, key, row, s.version, !!current)], collision: collisionOf(db, caseId, t.name, [key]),
          ...(commitAfter ? { beforeCommit: async () => { await commitAfter; } } : {}) };
      });
    },
    async putTableRows(a) {
      const caseId = caseOf(a);
      if (!Array.isArray(a.rows)) invalid();
      return change<void>(a, 'table-rows-put', { table: a.table, owner: a.owner, rows: a.rows, expectedRevision: a.expectedRevision }, a.expectedRevision, async (db, _, s) => {
        const t = await owned(db, a.table, a.owner), seen = new Set<string>(), statements: D1Statement[] = [];
        for (const input of a.rows) {
          const row = cells(t, input, caseId), key = tableKey(t, row);
          if (seen.has(key)) throw contractError('restore-key'); seen.add(key);
          const current = await tableRow(db, t.name, key);
          if (current && current.case_id !== caseId) throw contractError('restore-key-collision');
          statements.push(putTableStatement(db, caseId, t.name, key, row, s.version, !!current));
        }
        return { kind: 'written', value: undefined, statements, collision: collisionOf(db, caseId, t.name, [...seen]) };
      });
    },
    async deleteTableRow(a) {
      const caseId = caseOf(a);
      if (!a.expected || a.expected.kind !== 'match') invalid();
      return change<boolean>(a, 'table-row-delete', { table: a.table, owner: a.owner, key: a.key, expected: a.expected }, undefined, async (db) => {
        const t = await owned(db, a.table, a.owner), key = tableKey(t, cells(t, a.key, caseId, true)), current = await tableRow(db, t.name, key);
        const conflict = compare(a.expected, current && current.case_id === caseId ? current : null); if (conflict) return { kind: conflict };
        return { kind: 'written', value: true, statements: [db.prepare('DELETE FROM uw_table_row WHERE table_name = ? AND row_key = ? AND case_id = ? AND version = ?').bind(t.name, key, caseId, current!.version)] };
      });
    },
    async exportAll(a) {
      const { db, caseId } = await authorize(a, 'read');
      return exportOf(db, caseId);
    },
    async importAll(a) {
      const caseId = caseOf(a);
      if (!a.snapshot || a.snapshot.format !== USER_WORK_FORMAT || !Array.isArray(a.snapshot.tables)) invalid();
      if (sizeOf(a.snapshot) > limits.maxSnapshotBytes) invalid();
      if (typeof a.preRestore !== 'string') invalid();
      const result = await change<C.ImportResult>(a, 'restore', { snapshot: a.snapshot, preRestore: a.preRestore, expectedRevision: a.expectedRevision }, a.expectedRevision, async (db, _, s) => {
        // The pre-restore snapshot must hold exactly this case at the revision being replaced, with its audit acknowledged.
        const receipt = await read(() => db.prepare('SELECT case_id, revision, audited_at FROM uw_snapshot WHERE snapshot_id = ?').bind(a.preRestore).first<{ case_id: string; revision: string; audited_at: string | null }>());
        if (!receipt || receipt.case_id !== caseId || receipt.revision !== s.revision || receipt.audited_at === null) throw contractError('snapshot-failed');
        const known = new Map((await definitions(db)).map((t) => [t.name, t]));
        const statements: D1Statement[] = ['uw_note', 'uw_seed_overlay', 'uw_register_row', 'uw_table_row'].map((table) => db.prepare(`DELETE FROM ${table} WHERE case_id = ?`).bind(caseId));
        const names = new Set<string>(), restored: C.TableRestoreReport[] = [], keys = new Map<string, string[]>(), newDefinitions: C.UserWorkTable[] = [];
        for (const table of a.snapshot.tables) {
          if (!table || typeof table.name !== 'string' || !Array.isArray(table.rows) || names.has(table.name)) invalid();
          names.add(table.name);
          if (table.scope !== 'case' || table.kind !== 'user-work' || isReserved(table.name) && !isBuiltin(table.name)) throw contractError('restore-state');
          let t = isBuiltin(table.name) ? builtin(table.name) : known.get(table.name);
          if (!t) {
            const types = ['TEXT', 'INTEGER', 'REAL', 'BLOB'];
            if (!Array.isArray(table.columns) || !table.columns.every((c) => types.includes(c.type))) invalid();
            t = definition({ name: table.name, owner: table.owner, description: table.description, scope: table.scope, columns: table.columns.map((c) => ({ name: c.name, type: c.type as 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB', notNull: c.notNull })), primaryKey: table.columns.filter((c) => c.pk).sort((x, y) => x.pk - y.pk).map((c) => c.name) });
            await authorizeDefinition(t);
            newDefinitions.push(t);
            known.set(t.name, t);
            statements.push(db.prepare('INSERT INTO uw_table_definition (name, owner, definition_json, event_json, created_at, audited_at) VALUES (?, ?, ?, ?, ?, ?)')
              .bind(t.name, t.owner, canonical(t), JSON.stringify(s.event), s.at, s.audited)); // acknowledged with the restore's own event
          }
          const { rows, ...metadata } = table;
          if (!sameJson(t, metadata)) throw contractError('table-conflict');
          const seen = new Set<string>();
          for (const row of rows) {
            const normalized = cells(t, row, caseId), key = tableKey(t, normalized);
            if (seen.has(key)) throw contractError('restore-key'); seen.add(key);
            if (!isBuiltin(t.name)) {
              const other = await read(() => db.prepare('SELECT case_id FROM uw_table_row WHERE table_name = ? AND row_key = ? AND case_id != ?').bind(t!.name, key, caseId).first<{ case_id: string }>());
              if (other) throw contractError('restore-key-collision');
              statements.push(putTableStatement(db, caseId, t.name, key, normalized, s.version, false));
              continue;
            }
            if (typeof row.payload !== 'string' || typeof row.id !== 'string') invalid();
            const rowId = row.id as string, canonicalKey = (expected: string) => { if (rowId !== expected) throw contractError('restore-key'); };
            if (t.name === 'note') {
              const note = parsed<C.HostedNote>(NoteRowCheck, row.payload);
              if (body(note.body) !== note.body) invalid();
              canonicalKey(note.id); rowIdOf(note.id);
              if (note.target.kind === 'document' && note.target.anchor.caseId !== caseId) throw contractError('restore-key-collision');
              statements.push(await noteInsert(db, caseId, note, s.version));
            } else if (t.name === 'seed_overlay') {
              const overlay = parsed<C.SeedOverlay>(OverlayCheck, row.payload);
              if (overlay.caseId !== caseId) throw contractError('restore-key-collision');
              canonicalKey(JSON.stringify([overlay.datasetKey, overlay.seedId]));
              statements.push(overlayUpsert(db, caseId, { ...overlay, fields: fields(overlay.fields) }, s.version, s.at, false));
            } else {
              const r = parsed<C.WorkRegisterRow>(RegisterRowCheck, row.payload);
              storeName(r.store); rowIdOf(r.rowId);
              canonicalKey(JSON.stringify([r.store, r.rowId]));
              if (r.anchor && r.anchor.caseId !== caseId) throw contractError('restore-key-collision');
              statements.push(await registerUpsert(db, caseId, { ...r, fields: fields(r.fields) }, s.version, false));
            }
          }
          if (!isBuiltin(t.name)) keys.set(t.name, [...seen]);
          restored.push({ name: table.name, scope: 'case', action: 'replaced-for-cases', rows: rows.length, deleted: 0, cases: [caseId] });
        }
        const collision = async () => { for (const [name, list] of keys) { const refusal = await collisionOf(db, caseId, name, list)(); if (refusal) return refusal; } return null; };
        return { kind: 'written', value: { tables: names.size, rows: restored.reduce((n, t) => n + t.rows, 0), cases: [caseId], restored }, statements, collision,
          beforeCommit: async () => { for (const t of newDefinitions) await authorizeDefinition(t); await authorize(a, 'write-user-work'); },
        };
      });
      await authorize(a, 'write-user-work');
      return result;
    },
    snapshots: {
      async put(a) {
        const { db, caseId } = await authorize(a, 'write-user-work');
        if (!a.snapshot || a.snapshot.format !== USER_WORK_FORMAT || sizeOf(a.snapshot) > limits.maxSnapshotBytes) invalid();
        const revision = await revisionOf(db, caseId);
        // The receipt binds content and revision: the snapshot must equal the case's current work at that revision.
        if (revision !== a.revision || withoutTime(await exportOf(db, caseId)) !== withoutTime(a.snapshot)) throw contractError('snapshot-failed');
        const snapshotId = id('snapshot', crypto.randomUUID()), json = canonical(a.snapshot), when = at();
        const event: C.AuditEvent = { eventId: `uw-snapshot:${snapshotId}`, actor: actor(), action: 'user-work.snapshot', object: { kind: 'case', id: caseId, caseId }, version: null, outcome: 'succeeded', at: when };
        try {
          await db.batch([guardStatement(db, caseId, revision), db.prepare('INSERT INTO uw_snapshot (snapshot_id, case_id, revision, snapshot_json, snapshot_sha256, event_json, created_at, audited_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)')
            .bind(snapshotId, caseId, revision, json, await sha256Hex(json), JSON.stringify(event), when)]);
        } catch {
          let stored: unknown, current: C.CaseRevision;
          try { stored = await db.prepare('SELECT 1 AS present FROM uw_snapshot WHERE snapshot_id = ?').bind(snapshotId).first(); current = await revisionOf(db, caseId); } catch { throw failure('storage-unavailable', 'unknown', true); }
          if (!stored) { if (current !== revision) throw contractError('snapshot-failed'); throw failure('storage-unavailable', 'not-written', true); }
        }
        await acknowledge(db, JSON.stringify(event), [db.prepare('UPDATE uw_snapshot SET audited_at = ? WHERE snapshot_id = ? AND audited_at IS NULL').bind(at(), snapshotId)]);
        return snapshotId;
      },
      async get(a) {
        const { db, caseId } = await authorize(a, 'read');
        const row = await read(() => db.prepare('SELECT case_id, snapshot_json, snapshot_sha256 FROM uw_snapshot WHERE snapshot_id = ?').bind(a.id).first<{ case_id: string; snapshot_json: string; snapshot_sha256: string }>());
        if (!row) return null;
        if (row.case_id !== caseId) throw contractError('forbidden');
        if (await sha256Hex(row.snapshot_json) !== row.snapshot_sha256) throw contractError('snapshot-failed');
        return JSON.parse(row.snapshot_json) as C.UserWorkExport;
      },
    },
    registers: {
      open(scope) {
        storeName(scope.store);
        const base = { caseId: scope.caseId, store: scope.store };
        return {
          rows: () => work.listRows(base),
          add: (a) => work.putRow({ ...base, fields: a.fields, operationId: a.operationId, rowId: null, expected: { kind: 'absent' }, anchor: null }),
          async replace(a) {
            const rowId = rowIdOf(a.rowId), values = fields(a.fields), expected: C.Expected = { kind: 'match', version: a.expected };
            // The request does not contain an anchor: preserve it only in the fresh-write plan, never in the digest.
            const result = await change<void>({ ...base, operationId: a.operationId }, 'register-replace', { store: base.store, rowId, fields: values, expected }, undefined, async (db, caseId, s) => {
              const old = (await registerRowsOf(db, caseId, base.store)).find((r) => r.rowId === rowId);
              const conflict = compare(expected, old); if (conflict) return { kind: conflict };
              const row: C.WorkRegisterRow = { ...old!, fields: values, updatedAt: s.at };
              return { kind: 'written', value: undefined, statements: [await registerUpsert(db, caseId, row, s.version, true)], beforeCommit: async () => { await authorize(base, 'write-user-work'); } };
            });
            await authorize(base, 'write-user-work');
            return result;
          },
          remove: (a) => work.deleteRow({ ...base, rowId: a.rowId, operationId: a.operationId, expected: { kind: 'match', version: a.expected } }),
          async apply(a) {
            if (!Array.isArray(a.commands) || a.commands.length > 1000) invalid();
            const commands = a.commands.map((c) => c.kind === 'add' ? { kind: c.kind, fields: fields(c.fields) } : c.kind === 'replace' ? { kind: c.kind, rowId: rowIdOf(c.rowId), fields: fields(c.fields) } : c.kind === 'remove' ? { kind: c.kind, rowId: rowIdOf(c.rowId) } : invalid());
            return change<void>({ caseId: scope.caseId, operationId: a.operationId }, 'register-apply', { store: scope.store, commands, expectedRevision: a.expectedRevision }, a.expectedRevision, async (db, caseId, s) => {
              // Applied in order to a view of the store; statements run in the same order inside one guarded batch.
              const rows = new Map<string, C.WorkRegisterRow>((await registerRowsOf(db, caseId, scope.store)).map((r) => [r.rowId, r]));
              const statements: D1Statement[] = [];
              for (const command of commands) {
                if (command.kind === 'remove') {
                  if (!rows.delete(command.rowId)) return { kind: 'gone' };
                  statements.push(db.prepare('DELETE FROM uw_register_row WHERE case_id = ? AND store = ? AND row_id = ?').bind(caseId, scope.store, command.rowId));
                  continue;
                }
                const rowId = command.kind === 'add' ? crypto.randomUUID() : command.rowId, old = rows.get(rowId);
                if (command.kind === 'replace' && !old) return { kind: 'gone' };
                const row: C.WorkRegisterRow = { rowId, store: scope.store, anchor: old?.anchor ?? null, fields: command.fields, createdAt: old?.createdAt ?? s.at, updatedAt: s.at, intact: true };
                statements.push(await registerUpsert(db, caseId, row, s.version, !!old));
                rows.set(rowId, row);
              }
              return { kind: 'written', value: undefined, statements };
            });
          },
        };
      },
      seeds(scope) {
        return {
          views: () => work.seedViews(scope),
          async remove(a) {
            const result = await change<boolean>({ caseId: scope.caseId, operationId: a.operationId }, 'seed-remove', { resultsVersion: scope.resultsVersion, datasetKey: scope.datasetKey, seedId: a.seedId, expected: a.expected }, undefined, async (db, caseId, s) => {
              const seeds = await work.seedRows(scope), seed = seeds.find((s) => s.seedId === a.seedId);
              // Publication and seed visibility constrain fresh mutations, not acknowledgement of a durable removal.
              if (await store.activeVersionId({ caseId }) !== scope.resultsVersion) throw contractError('forbidden');
              await authorize(scope, 'write-user-work');
              const overlay = (await overlaysOf(db, caseId)).find((o) => o.datasetKey === scope.datasetKey && o.seedId === a.seedId);
              if (!seed && !overlay) return { kind: 'gone' };
              const current = overlay?.version ?? id('row-version', `seed:${seed!.seedSha256}`);
              if (current !== a.expected) return { kind: 'stale' };
              const next: C.SeedOverlay = { caseId, datasetKey: scope.datasetKey, seedId: a.seedId, baseSeedSha256: seed?.seedSha256 ?? overlay!.baseSeedSha256, fields: { ...(overlay?.fields ?? {}), deleted: true } };
              return { kind: 'written', value: true, statements: [overlayUpsert(db, caseId, next, s.version, s.at, !!overlay)], beforeCommit: async () => {
                if (await store.activeVersionId({ caseId }) !== scope.resultsVersion) throw contractError('forbidden');
                await authorize(scope, 'write-user-work');
              } };
            });
            await authorize(scope, 'write-user-work');
            return result.kind === 'gone' ? 'absent' : result;
          },
        };
      },
    },
  };
  // Internal calls use `work`, not these wrappers, so one refusal produces exactly one best-effort denial event.
  const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R>, scope: (...args: A) => C.CaseId | null, action: 'read' | 'write') =>
    (...args: A) => boundary(scope(...args), `user-work.${action}`, () => fn(...args));
  const caseScope = (a: C.Scope) => a?.caseId ?? null;
  return Object.freeze({
    anchorFor: wrap(work.anchorFor, caseScope, 'read'),
    resolve: wrap(work.resolve, (a) => a?.into?.caseId ?? null, 'read'),
    notesFor: wrap(work.notesFor, caseScope, 'read'),
    summary: wrap(work.summary, caseScope, 'read'),
    addNote: wrap(work.addNote, caseScope, 'write'),
    deleteNote: wrap(work.deleteNote, caseScope, 'write'),
    seedRows: wrap(work.seedRows, caseScope, 'read'),
    overlays: wrap(work.overlays, caseScope, 'read'),
    seedViews: wrap(work.seedViews, caseScope, 'read'),
    putSeedOverlay: wrap(work.putSeedOverlay, caseScope, 'write'),
    listRows: wrap(work.listRows, caseScope, 'read'),
    readViewWork: wrap(work.readViewWork, caseScope, 'read'),
    putRow: wrap(work.putRow, caseScope, 'write'),
    deleteRow: wrap(work.deleteRow, caseScope, 'write'),
    tables: wrap(work.tables, () => null, 'read'),
    defineTable: wrap(work.defineTable, () => null, 'write'),
    registerStores: wrap(work.registerStores, caseScope, 'read'),
    listTableRows: wrap(work.listTableRows, caseScope, 'read'),
    putTableRow: wrap(work.putTableRow, caseScope, 'write'),
    putTableRows: wrap(work.putTableRows, caseScope, 'write'),
    deleteTableRow: wrap(work.deleteTableRow, caseScope, 'write'),
    exportAll: wrap(work.exportAll, caseScope, 'read'),
    importAll: wrap(work.importAll, caseScope, 'write'),
    snapshots: { put: wrap(work.snapshots.put, caseScope, 'write'), get: wrap(work.snapshots.get, caseScope, 'read') },
    registers: {
      open(scope: Parameters<D1UserWork['registers']['open']>[0]) {
        const r = work.registers.open(scope), c = () => scope.caseId;
        return { rows: wrap(r.rows, c, 'read'), add: wrap(r.add, c, 'write'), replace: wrap(r.replace, c, 'write'), remove: wrap(r.remove, c, 'write'), apply: wrap(r.apply, c, 'write') };
      },
      seeds(scope: Parameters<D1UserWork['registers']['seeds']>[0]) {
        const r = work.registers.seeds(scope), c = () => scope.caseId;
        return { views: wrap(r.views, c, 'read'), remove: wrap(r.remove, c, 'write') };
      },
    },
  } satisfies D1UserWork);
}
