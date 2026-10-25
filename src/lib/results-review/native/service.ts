import type { JsonValue } from '../../case-package/strict-json.ts';
import type { AuditEvent, CaseId, ClientId, Identity, IdentityState, Principal, ResultsVersion, SessionId } from '../../server/runtime/contracts.ts';
import { contractError, isDenial } from '../../server/runtime/errors.ts';
import type { CandidateImportLink, FinalizedSubmissionSnapshot } from '../../server/runtime/hosted/alpha-contracts.ts';
import { id, resultsVersion as brandVersion, sha256 as brandSha } from '../../server/runtime/ids.ts';
import { buildCoverage, type UnlinkedReason } from './coverage.ts';
import { candidateIdOf, linkIdOf, sha256Bytes, sha256Canonical, sha256Text } from './digest.ts';
import { buildCorrection, inspectPackage, type InspectedPackage } from './package.ts';
import type { CandidateReader, CorrectionRecord, LinkedCandidate, NativeImportPorts, Origin, Scoped, StageOutcome } from './ports.ts';

export type RefusalCode =
  | 'invalid-request' | 'package-invalid' | 'wrong-case' | 'validator-refused' | 'invalid-correction' | 'no-change'
  | 'operation-reused' | 'submission-not-finalized' | 'candidate-exists' | 'superseded' | 'submission-changed'
  | 'submission-not-found' | 'base-not-found' | 'stager-identity-mismatch';
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
}

const refused = (code: RefusalCode, ...detail: string[]): ImportOutcome => ({ kind: 'refused', code, detail });
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const admittedTokens = new WeakSet<object>();

/** Builds the import service, or null (the routes answer 503) while any required port is not composed. */
export function createNativeResultsImport(ports: NativeImportPorts | null): NativeResultsImport | null {
  if (!ports || !ports.budget || !ports.authorizeOperate || !ports.submissions || !ports.stager || !ports.repository || !ports.audit) return null;
  const { budget, authorizeOperate, submissions, stager, repository, audit } = ports;
  const clientId = ports.clientId;
  const scope = (caseId: CaseId): Scoped => ({ clientId, caseId });
  const sessionTag = async (a: AdmittedOperator) => (await sha256Text(a.sessionId)).slice(0, 12);
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
      admittedTokens.add(token);
      return token;
    } catch (e) { return deny(e); }
  }
  const must = (a: AdmittedOperator, access: 'read' | 'write') => {
    if (!admittedTokens.has(a) || (access === 'write' && a.access !== 'write')) throw contractError('forbidden');
  };

  async function success(a: AdmittedOperator, c: LinkedCandidate) {
    const l = c.link;
    // One event per (link, session): a retry from the same session re-appends the identical event, so the sink treats it as the same one.
    await audit.append({
      eventId: `native-${c.origin}-${l.linkId}-${await sessionTag(a)}`, actor: actor(a), action: c.origin === 'import' ? 'results.import-candidate' : 'results.correct-candidate',
      object: { kind: 'candidate', id: c.candidateId, caseId: a.caseId }, version: l.candidate.resultsVersion, outcome: 'succeeded', at: l.linkedAt,
    });
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
    if (prior) return refused('candidate-exists', 'a candidate of this results version already exists in this case');
    const out: StageOutcome = await stager.stage({ clientId, caseId: a.caseId, operationId: o.operationId, files: pkg.files, identity: { resultsVersion: brandVersion(pkg.resultsVersion), manifestSha256: pkg.manifestSha256 } });
    if (out.kind === 'refused') return refused('validator-refused', out.reason, ...out.detail.slice(0, 20));
    if (out.resultsVersion !== pkg.resultsVersion || out.manifestSha256 !== pkg.manifestSha256 || out.inputRevisionId !== pkg.inputRevisionId || (out.verdict !== 'accept' && out.verdict !== 'report')) {
      return refused('stager-identity-mismatch', 'the stager reported an identity other than the supplied package\'s');
    }
    const cov = buildCoverage({ assets: pkg.assets, submission: o.snapshot, caseMismatch: out.caseMismatch, warningFingerprints: out.warningFingerprints });
    if (!cov.ok) return { kind: 'unlinked', resultsVersion: pkg.resultsVersion, reasons: cov.reasons };
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
    const stored = await repository.record({ ...s, operationId: o.operationId, origin: o.origin, parentCandidateId: o.parent, link, correction });
    await success(a, stored);
    return { kind: 'linked', repeated: false, candidate: stored };
  }

  return {
    admit, budget, clientId, correctionsAvailable: ports.packages !== null,

    async importPackage(a, r) {
      must(a, 'write');
      const s = scope(a.caseId);
      // Pure checks first: a package that cannot verify claims nothing, so its operation id is not spent on it.
      const pkg = inspectPackage(r.files, a.caseId);
      if (!pkg.ok) return refused(pkg.code, ...pkg.detail);
      const manifest = [...r.files.entries()].sort((x, y) => cmp(x[0], y[0]));
      const requestSha256 = await sha256Canonical({ kind: 'import', submissionRevisionId: r.submissionRevisionId, files: await Promise.all(manifest.map(async ([path, bytes]) => ({ path, sha256: await sha256Bytes(bytes), size: bytes.byteLength }))) });
      const claim = await repository.claim({ ...s, operationId: r.operationId, kind: 'import', operator: { issuer: a.principal.issuer, subject: a.principal.subject }, requestSha256, submissionRevisionId: r.submissionRevisionId, baseCandidateId: null, at: ports!.now().toISOString() });
      if (claim.kind === 'operation-reused') return refused('operation-reused', 'this operation id was already used for a different request');
      const existing = await repository.byOperation({ ...s, operationId: r.operationId });
      if (existing) { await success(a, existing); return { kind: 'linked', repeated: true, candidate: existing }; }

      const snap = await snapshotOf(a.caseId, r.submissionRevisionId);
      if (isOutcome(snap)) return snap;
      return stageAndLink(a, { operationId: r.operationId, origin: 'import', parent: null, pkg: pkg.value, snapshot: snap, correction: null });
    },

    async correct(a, r) {
      must(a, 'write');
      const s = scope(a.caseId);
      if (!ports!.packages) throw contractError('correction-unavailable', true);
      const base = await repository.candidate({ ...s, candidateId: r.candidateId });
      if (!base) return refused('base-not-found', 'no such candidate in this case');
      const requestSha256 = await sha256Canonical({ kind: 'correction', baseCandidateId: base.candidateId, reason: r.reason, replacements: await Promise.all(r.replacements.map(async (x) => ({ key: x.key, data: await sha256Canonical(x.data) }))) });
      const claim = await repository.claim({ ...s, operationId: r.operationId, kind: 'correction', operator: { issuer: a.principal.issuer, subject: a.principal.subject }, requestSha256, submissionRevisionId: base.link.submissionRevisionId, baseCandidateId: base.candidateId, at: ports!.now().toISOString() });
      if (claim.kind === 'operation-reused') return refused('operation-reused', 'this operation id was already used for a different request');
      const existing = await repository.byOperation({ ...s, operationId: r.operationId });
      if (existing) { await success(a, existing); return { kind: 'linked', repeated: true, candidate: existing }; }
      if (!base.current) return refused('superseded', 'only the current candidate is corrected');

      // The base package, read back from the stored bytes and verified against the identity the link pinned, not trusted as stored.
      const files = await ports!.packages.files({ clientId, caseId: a.caseId, resultsVersion: base.link.candidate.resultsVersion });
      if (!files) throw contractError('storage-unavailable', true);
      const stored = inspectPackage(files, a.caseId);
      if (!stored.ok || stored.value.resultsVersion !== base.link.candidate.resultsVersion || stored.value.manifestSha256 !== base.link.candidate.manifestSha256) throw contractError('integrity');
      const built = buildCorrection(stored.value, r.replacements, ports!.now().toISOString());
      if (!built.ok) return refused(built.code, ...built.detail);
      const next = inspectPackage(built.files, a.caseId);
      if (!next.ok) return refused(next.code, ...next.detail);

      const snap = await snapshotOf(a.caseId, base.link.submissionRevisionId);
      if (isOutcome(snap)) return snap;
      if (snap.storedManifestSha256 !== base.link.submissionManifestSha256) return refused('submission-changed', 'the submission no longer matches the link it was made from');
      return stageAndLink(a, { operationId: r.operationId, origin: 'correction', parent: base.candidateId, pkg: next.value, snapshot: snap, correction: { reason: r.reason, changes: built.changes } });
    },

    async readCandidate(a, candidateId) {
      must(a, 'read');
      const c = await repository.candidate({ ...scope(a.caseId), candidateId });
      if (!c) return null;
      await audit.append({ eventId: `native-read-${crypto.randomUUID()}`, actor: actor(a), action: 'results.read-candidate', object: { kind: 'candidate', id: c.candidateId, caseId: a.caseId }, version: c.link.candidate.resultsVersion as ResultsVersion, outcome: 'succeeded', at: ports!.now().toISOString() });
      return c;
    },

    async listCandidates(a) {
      must(a, 'read');
      const rows = await repository.list(scope(a.caseId));
      await audit.append({ eventId: `native-list-${crypto.randomUUID()}`, actor: actor(a), action: 'results.read-candidate', object: { kind: 'case', id: a.caseId, caseId: a.caseId }, version: null, outcome: 'succeeded', at: ports!.now().toISOString() });
      return rows;
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
