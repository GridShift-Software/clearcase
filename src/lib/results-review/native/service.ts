import type { JsonValue } from '../../case-package/strict-json.ts';
import type { AuditEvent, CaseId, ClientId, Identity, IdentityState, Principal, ResultsVersion, SessionId } from '../../server/runtime/contracts.ts';
import { contractError, isDenial } from '../../server/runtime/errors.ts';
import type { CandidateImportLink, FinalizedSubmissionSnapshot } from '../../server/runtime/hosted/alpha-contracts.ts';
import { id, resultsVersion as brandVersion, sha256 as brandSha } from '../../server/runtime/ids.ts';
import { candidateAuditEvent } from './audit.ts';
import { overRequestBudget } from './budget.ts';
import { buildCoverage, type UnlinkedReason } from './coverage.ts';
import { candidateIdOf, linkIdOf, sha256Bytes, sha256Canonical } from './digest.ts';
import { buildCorrection, inspectPackage, type InspectedPackage } from './package.ts';
import { createStagedImport, type StagedImport } from './staging/service.ts';
import type { CandidateReader, CommittedCandidateAudit, CorrectionRecord, LinkedCandidate, NativeImportPorts, Origin, Scoped, SqlCondition, StageOutcome } from './ports.ts';

export type RefusalCode =
  | 'invalid-request' | 'package-invalid' | 'wrong-case' | 'validator-refused' | 'invalid-correction' | 'no-change'
  | 'operation-reused' | 'submission-not-finalized' | 'candidate-exists' | 'superseded' | 'submission-changed'
  | 'submission-not-found' | 'base-not-found' | 'stager-identity-mismatch' | 'over-budget';
export type ImportOutcome =
  | { kind: 'linked'; repeated: boolean; candidate: LinkedCandidate }
  | { kind: 'unlinked'; resultsVersion: string; reasons: readonly UnlinkedReason[] }
  | { kind: 'refused'; code: RefusalCode; detail: readonly string[] };

/** A verified, explicitly case-authorized operator for one case. Only `admit` makes one; the writes refuse anything else. */
export interface AdmittedOperator { readonly principal: Principal; readonly sessionId: SessionId; readonly caseId: CaseId; readonly access: 'read' | 'write' }
export interface ImportRequest { operationId: string; submissionRevisionId: string; files: ReadonlyMap<string, Uint8Array> }
export interface CorrectionRequest { operationId: string; candidateId: string; reason: string; replacements: readonly { key: string; data: JsonValue }[] }

/** The typed parent API. Authority is decided by `admit` before any body is read; writes demand its token. */
export interface NativeResultsImport {
  admit(a: { identity: Identity; caseId: CaseId; access: 'read' | 'write' }): Promise<AdmittedOperator>;
  importPackage(admitted: AdmittedOperator, request: ImportRequest): Promise<ImportOutcome>;
  correct(admitted: AdmittedOperator, request: CorrectionRequest): Promise<ImportOutcome>;
  /** An audited operator read (the append happens before the data is returned). */
  readCandidate(admitted: AdmittedOperator, candidateId: string): Promise<LinkedCandidate | null>;
  listCandidates(admitted: AdmittedOperator): Promise<readonly LinkedCandidate[]>;
  readonly budget: NonNullable<NativeImportPorts['budget']>;
  readonly clientId: ClientId;
  readonly correctionsAvailable: boolean;
  /** The chunked, resumable import; null until its ledger and store are composed. */
  readonly staged: StagedImport | null;
}

const refused = (code: RefusalCode, ...detail: string[]): ImportOutcome => ({ kind: 'refused', code, detail });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Builds the import service, or null (the routes answer 503) while any required port is not composed. */
export function createNativeResultsImport(ports: NativeImportPorts | null): NativeResultsImport | null {
  if (!ports || !ports.budget || !ports.authorizeOperate || !ports.submissions || !ports.stager || !ports.repository || !ports.audit) return null;
  const { budget, authorizeOperate, submissions, stager, repository, audit } = ports;
  const admitted = new WeakMap<AdmittedOperator, Identity>();
  const observeOperate = ports.observeOperate ?? authorizeOperate, condition = ports.operateCondition ?? null;
  const clientId = ports.clientId;
  const scope = (caseId: CaseId): Scoped => ({ clientId, caseId });
  const actor = (a: AdmittedOperator): IdentityState => ({ kind: 'verified', principal: a.principal, sessionId: a.sessionId });

  /** Best effort: a refusal is already final, so a fault appending its event never changes the answer. */
  async function note(event: Omit<AuditEvent, 'eventId' | 'at'>, key: string) {
    try { await audit.append({ ...event, eventId: `native-${key}-${crypto.randomUUID()}`, at: ports!.now().toISOString() }); } catch { /* the refusal stands */ }
  }

  async function admit(a: { identity: Identity; caseId: CaseId; access: 'read' | 'write' }): Promise<AdmittedOperator> {
    const who = a.identity;
    const deny = async (e: unknown): Promise<never> => {
      if (isDenial(e)) await note({ actor: who.kind === 'verified' ? { kind: 'verified', principal: who.principal, sessionId: who.sessionId } : { kind: 'anonymous', principal: null, sessionId: null }, action: 'results.native-access', object: { kind: 'case', id: a.caseId, caseId: a.caseId }, version: null, outcome: 'denied' }, 'denied');
      throw e;
    };
    try {
      if (who.kind !== 'verified') throw contractError('unauthenticated');
      if (who.clientId !== clientId) throw contractError('wrong-client');
      await who.checkRevocation();
      // A client principal is never an operator, whatever grants it holds: the link records a staff operator.
      if (who.principal.kind !== 'staff') throw contractError('forbidden');
      await authorizeOperate({ principal: who.principal, sessionId: who.sessionId, clientId, caseId: a.caseId });
      const token: AdmittedOperator = Object.freeze({ principal: who.principal, sessionId: who.sessionId, caseId: a.caseId, access: a.access });
      admitted.set(token, who);
      return token;
    } catch (e) { return deny(e); }
  }
  const must = (a: AdmittedOperator, access: 'read' | 'write') => {
    if (!admitted.has(a) || (access === 'write' && a.access !== 'write')) throw contractError('forbidden');
  };
  const intent = (a: AdmittedOperator) => ({ principal: a.principal, sessionId: a.sessionId, clientId, caseId: a.caseId });
  /** The session as the identity provider holds it now: before every write and every answer. */
  const live = (a: AdmittedOperator) => admitted.get(a)!.checkRevocation();
  /** The session and the operate grant as they stand now. */
  const observe = async (a: AdmittedOperator) => { await live(a); await observeOperate(intent(a)); };
  /**
   * A write's or a release's fence: the live session, then the grant as SQL that the statement itself holds, so it
   * commits or answers only while the grant stands. Without the SQL form the grant is observed just before instead.
   */
  const fence = async (a: AdmittedOperator): Promise<SqlCondition | undefined> => {
    if (!condition) { await observe(a); return undefined; }
    await live(a);
    return condition(intent(a));
  };
  /** A fault under a fence may be the fence: observe, so a lost grant or session answers as that denial. */
  const fenced = async <T>(a: AdmittedOperator, f: () => Promise<T>): Promise<T> => {
    try { return await f(); } catch (e) { if (!isDenial(e)) await observe(a); throw e; }
  };
  /**
   * A read or list refused at its final fence has already written its succeeded event (the data must not leave before it).
   * The refusal is recorded beside it, best effort and only on the denial path; the success event is not rewritten and the
   * refusal is what the caller sees whether or not the companion persists.
   */
  async function refusedRead(a: AdmittedOperator, object: AuditEvent['object'], e: unknown): Promise<never> {
    if (isDenial(e)) await note({ actor: actor(a), action: 'results.read-candidate', object, version: null, outcome: 'denied' }, 'read-denied');
    throw e;
  }
  /** Every answer but a link (whose readback is fenced) is given only after a fresh observation. */
  const answer = async <T>(a: AdmittedOperator, out: T): Promise<T> => { await observe(a); return out; };

  /**
   * Delivers the committed intent through the request sink, settles it, and answers the settled candidate. The repository
   * verifies the candidate first, then asks for this fence (a fresh session check) and ends on one statement that holds the
   * grant and the exact verified rows: nothing is hashed, parsed, read or awaited after it.
   */
  async function success(a: AdmittedOperator, committed: CommittedCandidateAudit) {
    // Only the verified original principal can deliver this via a request sink. Independent recovery uses the trusted port.
    const who = committed.event.actor;
    if (who.kind !== 'verified' || who.principal.kind !== a.principal.kind || who.principal.issuer !== a.principal.issuer || who.principal.subject !== a.principal.subject) throw contractError('integrity');
    await live(a);
    const ack = await audit.append(committed.event);
    if (ack.eventId !== committed.event.eventId) throw contractError('integrity');
    return fenced(a, () => repository.settleAudit(committed, () => fence(a)));
  }
  /** The attempt record, written only while the session and grant stand. */
  async function claim(a: AdmittedOperator, c: Omit<Parameters<typeof repository.claim>[0], 'guard'>) {
    const guard = await fence(a);
    return fenced(a, () => repository.claim({ ...c, guard }));
  }
  async function repeated(a: AdmittedOperator, existing: LinkedCandidate): Promise<ImportOutcome> {
    const committed = await repository.auditIntent({ ...scope(a.caseId), candidateId: existing.candidateId });
    return { kind: 'linked', repeated: true, candidate: await success(a, committed) };
  }

  /** The submission the link pins, read through the trusted reader; anything but a finalized one in this case refuses. */
  async function snapshotOf(caseId: CaseId, revisionId: string): Promise<FinalizedSubmissionSnapshot | ImportOutcome> {
    const s = await submissions.finalized({ clientId, caseId, revisionId });
    if (s.state === 'absent') return refused('submission-not-found', 'no such finalized submission in this case');
    if (s.state === 'not-final') return refused('submission-not-finalized', 'the submission is reserved, not finalized');
    const m = s.manifest;
    if (s.state !== 'finalized' || m.clientId !== clientId || m.caseId !== caseId || m.revisionId !== revisionId || m.files.length === 0 || !/^[0-9a-f]{64}$/.test(s.storedManifestSha256)) throw contractError('integrity');
    return s;
  }
  const isOutcome = (x: FinalizedSubmissionSnapshot | ImportOutcome): x is ImportOutcome => 'kind' in x;

  /** Stage privately through the injected real validator, check what it reports against the bytes, then link under the exact-set policy. */
  async function stageAndLink(a: AdmittedOperator, o: { operationId: string; origin: Origin; parent: string | null; pkg: InspectedPackage; snapshot: FinalizedSubmissionSnapshot; correction: Omit<CorrectionRecord, 'at' | 'operator'> | null }): Promise<ImportOutcome> {
    const s = scope(a.caseId), pkg = o.pkg;
    const prior = await repository.byResultsVersion({ ...s, resultsVersion: brandVersion(pkg.resultsVersion) });
    if (prior) return answer(a, refused('candidate-exists', 'a candidate of this results version already exists in this case'));
    const out: StageOutcome = await stager.stage({ clientId, caseId: a.caseId, operationId: o.operationId, files: pkg.files, submission: o.snapshot, identity: { resultsVersion: brandVersion(pkg.resultsVersion), manifestSha256: pkg.manifestSha256 } });
    // The stager observed the grant after its last read, so the validator's detail is answered under that observation.
    if (out.kind === 'refused') return out.reason === 'over-request-budget' ? refused('over-budget', ...out.detail.slice(0, 20)) : refused('validator-refused', out.reason, ...out.detail.slice(0, 20));
    if (out.resultsVersion !== pkg.resultsVersion || out.manifestSha256 !== pkg.manifestSha256 || out.inputRevisionId !== pkg.inputRevisionId || (out.verdict !== 'accept' && out.verdict !== 'report')) {
      return answer(a, refused('stager-identity-mismatch', 'the stager reported an identity other than the supplied package\'s'));
    }
    const cov = buildCoverage({ assets: pkg.assets, submission: o.snapshot, caseMismatch: out.caseMismatch, warningFingerprints: out.warningFingerprints });
    if (!cov.ok) return answer(a, { kind: 'unlinked', resultsVersion: pkg.resultsVersion, reasons: cov.reasons });
    const candidateId = await candidateIdOf({ clientId, caseId: a.caseId, resultsVersion: pkg.resultsVersion, manifestSha256: pkg.manifestSha256 });
    const at = ports!.now().toISOString();
    const submissionManifestSha256 = brandSha(o.snapshot.storedManifestSha256);
    const link: CandidateImportLink = {
      format: 'clearcase.candidate-import-link/1', linkId: await linkIdOf({ candidateId, submissionRevisionId: o.snapshot.manifest.revisionId, submissionManifestSha256 }),
      clientId, caseId: a.caseId, submissionRevisionId: o.snapshot.manifest.revisionId, submissionManifestSha256,
      candidate: { clientId, caseId: a.caseId, candidateId, resultsVersion: brandVersion(pkg.resultsVersion), manifestSha256: brandSha(pkg.manifestSha256), packageInputRevisionId: id('input-revision', pkg.inputRevisionId) },
      coverage: cov.coverage, operator: { issuer: a.principal.issuer, subject: a.principal.subject, kind: 'staff' }, linkedAt: at,
      attribution: 'manual-operator-link-not-processing-proof', state: 'private-candidate-linked',
    };
    const correction: CorrectionRecord | null = o.correction ? { ...o.correction, operator: { issuer: a.principal.issuer, subject: a.principal.subject }, at } : null;
    const auditEvent = await candidateAuditEvent({ origin: o.origin, candidateId, link }, a.sessionId);
    const guard = await fence(a);
    const stored = await fenced(a, () => repository.record({ ...s, operationId: o.operationId, origin: o.origin, parentCandidateId: o.parent, link, correction, auditEvent, guard }));
    return { kind: 'linked', repeated: false, candidate: await success(a, stored.audit) };
  }

  // The chunked import shares this service's authority, fences and link path; it adds only acceptance in verified batches.
  let service: NativeResultsImport;
  const staged = ports.staging ? createStagedImport({ clientId, budget, staging: ports.staging, repository, requestBudget: ports.requestBudget ?? null, now: () => ports.now(),
    must, observe, fence, fenced, answer, importPackage: (a, r) => service.importPackage(a, r), repeated,
    submissionRefusal: async (caseId, revisionId) => { const s = await snapshotOf(caseId, revisionId); return isOutcome(s) && s.kind === 'refused' ? s : null; } }) : null;

  return service = {
    admit, budget, clientId, correctionsAvailable: ports.packages !== null, staged,

    async importPackage(a, r) {
      must(a, 'write');
      const s = scope(a.caseId);
      // Pure checks first: a package that cannot verify claims nothing, so its operation id is not spent on it.
      const pkg = inspectPackage(r.files, a.caseId);
      if (!pkg.ok) return refused(pkg.code, ...pkg.detail);
      // Work this request cannot finish is refused before anything is written, not exhausted part way through.
      const originals = new Set(Object.values(pkg.value.assets).flatMap((x) => x.kind === 'file' ? [x.sha256] : [])).size;
      const over = ports!.requestBudget ? overRequestBudget({ files: r.files.size, originals, rows: 0 }, ports!.requestBudget) : null;
      if (over) return refused('over-budget', over);
      const manifest = [...r.files.entries()].sort((x, y) => cmp(x[0], y[0]));
      const requestSha256 = await sha256Canonical({ kind: 'import', submissionRevisionId: r.submissionRevisionId, files: await Promise.all(manifest.map(async ([path, bytes]) => ({ path, sha256: await sha256Bytes(bytes), size: bytes.byteLength }))) });
      const claimed = await claim(a, { ...s, operationId: r.operationId, kind: 'import', operator: { issuer: a.principal.issuer, subject: a.principal.subject }, requestSha256, submissionRevisionId: r.submissionRevisionId, baseCandidateId: null, at: ports!.now().toISOString() });
      if (claimed.kind === 'operation-reused') return answer(a, refused('operation-reused', 'this operation id was already used for a different request'));
      // A candidate is recorded only from its attempt, so a fresh claim has none yet; only a repeat looks for one.
      const existing = claimed.kind === 'repeated' ? await repository.byOperation({ ...s, operationId: r.operationId }) : null;
      if (existing) return repeated(a, existing);

      const snap = await snapshotOf(a.caseId, r.submissionRevisionId);
      if (isOutcome(snap)) return answer(a, snap);
      return stageAndLink(a, { operationId: r.operationId, origin: 'import', parent: null, pkg: pkg.value, snapshot: snap, correction: null });
    },

    async correct(a, r) {
      must(a, 'write');
      const s = scope(a.caseId);
      if (!ports!.packages) throw contractError('correction-unavailable', true);
      // A correction reads back its whole base package (each file under a fresh observation) and then stages a whole package:
      // more than the import alone, which already takes most of a request on a budgeted plan.
      if (ports!.requestBudget) return refused('over-budget', `a correction re-reads and re-stages a whole package, more than one request here may make (${ports!.requestBudget.d1} D1 calls, ${ports!.requestBudget.external} subrequests)`);
      const base = await repository.candidate({ ...s, candidateId: r.candidateId });
      if (!base) return answer(a, refused('base-not-found', 'no such candidate in this case'));
      const requestSha256 = await sha256Canonical({ kind: 'correction', baseCandidateId: base.candidateId, reason: r.reason, replacements: await Promise.all(r.replacements.map(async (x) => ({ key: x.key, data: await sha256Canonical(x.data) }))) });
      const claimed = await claim(a, { ...s, operationId: r.operationId, kind: 'correction', operator: { issuer: a.principal.issuer, subject: a.principal.subject }, requestSha256, submissionRevisionId: base.link.submissionRevisionId, baseCandidateId: base.candidateId, at: ports!.now().toISOString() });
      if (claimed.kind === 'operation-reused') return answer(a, refused('operation-reused', 'this operation id was already used for a different request'));
      const existing = await repository.byOperation({ ...s, operationId: r.operationId });
      if (existing) return repeated(a, existing);
      if (!base.current) return answer(a, refused('superseded', 'only the current candidate is corrected'));

      // The base package, read back from the stored bytes and verified against the identity the link pinned, not trusted as stored.
      const files = await ports!.packages.files({ clientId, caseId: a.caseId, resultsVersion: base.link.candidate.resultsVersion });
      if (!files) throw contractError('storage-unavailable', true);
      const stored = inspectPackage(files, a.caseId);
      if (!stored.ok || stored.value.resultsVersion !== base.link.candidate.resultsVersion || stored.value.manifestSha256 !== base.link.candidate.manifestSha256) throw contractError('integrity');
      const built = buildCorrection(stored.value, r.replacements, claimed.at);
      if (!built.ok) return answer(a, refused(built.code, ...built.detail));
      const next = inspectPackage(built.files, a.caseId);
      if (!next.ok) return answer(a, refused(next.code, ...next.detail));

      const snap = await snapshotOf(a.caseId, base.link.submissionRevisionId);
      if (isOutcome(snap)) return answer(a, snap);
      if (snap.storedManifestSha256 !== base.link.submissionManifestSha256) return answer(a, refused('submission-changed', 'the submission no longer matches the link it was made from'));
      return stageAndLink(a, { operationId: r.operationId, origin: 'correction', parent: base.candidateId, pkg: next.value, snapshot: snap, correction: { reason: r.reason, changes: built.changes } });
    },

    async readCandidate(a, candidateId) {
      must(a, 'read');
      // The read event is written once the candidate is verified and before it is released; a fresh fence then ends the read.
      return fenced(a, () => repository.candidate({ ...scope(a.caseId), candidateId }, async ([c]) => {
        await audit.append({ eventId: `native-read-${crypto.randomUUID()}`, actor: actor(a), action: 'results.read-candidate', object: { kind: 'candidate', id: c!.candidateId, caseId: a.caseId }, version: c!.link.candidate.resultsVersion as ResultsVersion, outcome: 'succeeded', at: ports!.now().toISOString() });
        return fence(a);
      })).catch((e) => refusedRead(a, { kind: 'candidate', id: candidateId, caseId: a.caseId }, e));
    },

    async listCandidates(a) {
      must(a, 'read');
      return fenced(a, () => repository.list(scope(a.caseId), async () => {
        await audit.append({ eventId: `native-list-${crypto.randomUUID()}`, actor: actor(a), action: 'results.read-candidate', object: { kind: 'case', id: a.caseId, caseId: a.caseId }, version: null, outcome: 'succeeded', at: ports!.now().toISOString() });
        return fence(a);
      })).catch((e) => refusedRead(a, { kind: 'case', id: a.caseId, caseId: a.caseId }, e));
    },
  };
}

/** Read access for the parent's review and sign-off. Not audited here: the caller audits its own operator read. */
export function createCandidateReader(ports: Pick<NativeImportPorts, 'repository'> | null): CandidateReader | null {
  const repository = ports?.repository;
  if (!repository) return null;
  const reader: CandidateReader = {
    candidate: (a) => repository.candidate(a),
    list: (a) => repository.list(a),
    current: async (a) => (await repository.list(a)).filter((c) => c.current),
  };
  return Object.freeze(reader);
}
