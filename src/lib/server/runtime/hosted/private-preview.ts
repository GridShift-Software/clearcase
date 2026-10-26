// The operator's private preview of one exact current candidate: its stored, digest-verified read model (overview,
// chronology rows) and the originals its immutable link mapped, before any sign-off or publication. It reads no R2
// byte, renders nothing, records no render evidence, sign-off, publication or user work, and is not readiness: the
// publication material, render and required-view gates stay where they are. Originals open through the case's own
// original routes (read-original), each a separate request.
import type { AuditSink, CaseId, ClientId, Identity, ResultsVersion } from '../contracts.ts';
import { codeOf, contractError, isDenial } from '../errors.ts';
import { freeze } from '../data.ts';
import { id } from '../ids.ts';
import type { D1 } from './bindings.ts';
import type { ImportLinkCoverage } from './alpha-contracts.ts';
import type { AuthorizeOperate, OperateCondition, Origin } from '../../../results-review/native/ports.ts';
import { d1NativeCandidateRepository, linkDigest } from '../../../results-review/native/repository.ts';
import { loadVerifiedModel } from '../../../results/hosted/model.ts';
import type { ChronologyListRow, OverviewModel } from '../../../local-case/model.ts';

export interface PrivatePreviewOptions {
  /** The deployment's client, from trusted configuration. */
  clientId: ClientId;
  /** This request's identity. Its `authorize` is the audited content check (`read-preview`): a staff session plus an explicit grant. */
  identity: Identity;
  /** The client's primary-session database (`withSession('first-primary')`), never a replica. */
  db: D1;
  /** This request's audit sink. A preview is released only after its read event is acknowledged. */
  audit: AuditSink;
  /** The audited operate admission: the live session, then the explicit operate grant (import-composition `caseAuthority`). */
  authorizeOperate: AuthorizeOperate;
  /** The same operate grant as SQL (tenancy `d1OperateObservation`), held by the final fence statement. */
  operateCondition: OperateCondition;
  now(): Date;
}

/** One mapped original: its case asset (served by `/cases/<case>/originals/<asset>`), never a storage key. */
export interface PreviewOriginal { ref: string; assetId: string; path: string; mediaType: string; size: number; inline: boolean }
export interface PrivatePreview {
  state: 'private-candidate-not-published';
  caseId: CaseId; candidateId: string; linkId: string; origin: Origin; linkedAt: string;
  resultsVersion: ResultsVersion; manifestSha256: string; packageInputRevisionId: string;
  submissionRevisionId: string; submissionManifestSha256: string;
  attribution: 'manual-operator-link-not-processing-proof';
  overview: OverviewModel;
  rows: readonly ChronologyListRow[];
  originals: readonly PreviewOriginal[];
  /** Declared originals the link records as missing or embedded, exactly as recorded: nothing here pretends they exist. */
  unavailable: ImportLinkCoverage['unavailableOriginals'];
}
export interface PrivatePreviewReader {
  read(a: { caseId: string; candidateId: string }): Promise<PrivatePreview>;
  /**
   * The denied event for a refusal the caller makes before it reads: best effort, never throws, releases nothing. Only a
   * verified identity of this deployment is recorded, and only against a well-formed case and candidate id.
   */
  denied(a: { caseId: string; candidateId: string }): Promise<void>;
}

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const fail = (code: string, retryable = false): never => { throw contractError(code, retryable); };
const isRow = (r: unknown): r is ChronologyListRow => !!r && typeof r === 'object' && typeof (r as ChronologyListRow).ref === 'string' && typeof (r as ChronologyListRow).ord === 'number';

// The final fence: the operate grant, and this exact link of this candidate still current (durably audited, not
// superseded) over its stored version with the read model just verified. One statement; nothing is awaited after it.
const FENCE = (operate: string) => `SELECT (${operate}) AS operate, EXISTS (SELECT 1 FROM native_candidate c
  JOIN native_import_link l ON l.client_id = c.client_id AND l.case_id = c.case_id AND l.candidate_id = c.candidate_id
  JOIN native_candidate_audit_intent ai ON ai.client_id = c.client_id AND ai.case_id = c.case_id AND ai.candidate_id = c.candidate_id
  JOIN native_candidate_audit_settlement ats ON ats.client_id = ai.client_id AND ats.case_id = ai.case_id AND ats.candidate_id = ai.candidate_id AND ats.event_id = ai.event_id
  JOIN rs_results_version v ON v.version_id = c.results_version AND v.case_id = c.case_id AND v.state = 'stored'
  WHERE c.client_id = ? AND c.case_id = ? AND c.candidate_id = ? AND c.results_version = ? AND l.link_id = ? AND l.link_sha256 = ? AND v.read_model_sha256 = ?
    AND NOT EXISTS (SELECT 1 FROM native_candidate_supersession s WHERE s.client_id = c.client_id AND s.case_id = c.case_id AND s.old_candidate_id = c.candidate_id)) AS current`;

/** Null when anything it needs is missing; authority is checked on every read, not at construction. */
export function createPrivatePreview(o: PrivatePreviewOptions): PrivatePreviewReader | null {
  if (!o?.clientId || !o.identity || typeof o.db?.prepare !== 'function' || typeof o.audit?.append !== 'function'
    || typeof o.authorizeOperate !== 'function' || typeof o.operateCondition !== 'function' || typeof o.now !== 'function') return null;
  const { clientId, identity, db, audit, now } = o;
  const repository = d1NativeCandidateRepository(db);

  async function record(caseId: CaseId, candidateId: string, version: ResultsVersion | null, outcome: 'succeeded' | 'denied') {
    const actor = identity.kind === 'verified' ? { kind: 'verified' as const, principal: identity.principal, sessionId: identity.sessionId } : { kind: 'anonymous' as const, principal: null, sessionId: null };
    const event = { eventId: `native-preview-${crypto.randomUUID()}`, actor, action: 'results.preview-candidate', object: { kind: 'candidate', id: candidateId, caseId }, version, outcome, at: now().toISOString() };
    const ack = await audit.append(event).catch(() => fail('audit-unavailable', true));
    if (ack.eventId !== event.eventId) fail('audit-unavailable', true);
  }

  return Object.freeze({
    async read(input: { caseId: string; candidateId: string }): Promise<PrivatePreview> {
      if (typeof input?.caseId !== 'string' || !PART.test(input.caseId) || typeof input.candidateId !== 'string' || !PART.test(input.candidateId)) return fail('not-found');
      const caseId = id('case', input.caseId) as CaseId, candidateId = input.candidateId;
      let rv: ResultsVersion | null = null;
      try {
        if (identity.clientId !== clientId) fail('wrong-client');
        if (identity.kind !== 'verified') fail('unauthenticated');
        const who = identity as Extract<Identity, { kind: 'verified' }>;
        // A client principal is never an operator, whatever content grants it holds.
        if (who.principal.kind !== 'staff') fail('forbidden');
        const subject = { principal: who.principal, sessionId: who.sessionId, clientId, caseId };
        // Admission: the audited operate capability (live session first), then the audited content authority. Each is
        // the existing separate grant; neither implies the other.
        await o.authorizeOperate(subject);
        await identity.authorize({ caseId, operation: 'read-preview' });

        // Only the exact candidate named, current in stored state: durably audited and not superseded. No latest, no
        // version from the URL, no other case's candidate.
        const candidate = await repository.candidate({ clientId, caseId, candidateId });
        if (!candidate || !candidate.current || candidate.supersededBy !== null) return fail('not-found');
        const link = candidate.link, pin = link.candidate;
        if (candidate.candidateId !== candidateId || link.clientId !== clientId || link.caseId !== caseId || pin.clientId !== clientId
          || pin.caseId !== caseId || pin.candidateId !== candidateId || link.coverage?.policy !== 'exact-required-file-set/1') return fail('integrity');
        rv = pin.resultsVersion;
        const version = await db.prepare("SELECT manifest_sha256, input_revision_id, read_model_sha256, overview FROM rs_results_version WHERE version_id = ? AND case_id = ? AND state = 'stored'")
          .bind(rv, caseId).first<{ manifest_sha256: string; input_revision_id: string; read_model_sha256: string; overview: string }>().catch(() => fail('storage-unavailable', true));
        if (!version || version.manifest_sha256 !== pin.manifestSha256 || version.input_revision_id !== pin.packageInputRevisionId) return fail('integrity');
        // The stored read model, counted and hashed against the version's own record before anything is shaped.
        const model = await loadVerifiedModel(db, rv);
        let overview: OverviewModel, rows: ChronologyListRow[];
        try {
          overview = JSON.parse(version.overview) as OverviewModel;
          rows = model.docs.map((d) => JSON.parse(d.list_json) as unknown).filter(isRow);
        } catch { return fail('integrity'); }
        if (!overview || overview.resultsVersion !== rv || overview.caseId !== caseId || rows.length !== model.docs.length) return fail('integrity');
        // A mapped original is shown only where the link's verified bytes and the read model's asset row agree.
        const assets = new Map(model.assets.map((a) => [a.key, a]));
        const originals: PreviewOriginal[] = link.coverage.mappedOriginals.flatMap((m) => m.packageRefs.flatMap((ref) => {
          const a = assets.get(ref);
          if (!a || a.kind !== 'file' || (a.status !== 'verified' && a.status !== 'case-mismatch') || a.sha256 !== m.sha256 || a.size !== m.size) return [];
          return [{ ref, assetId: m.submissionAssetId, path: m.storedPath, mediaType: a.media_type, size: m.size, inline: a.media_type === 'application/pdf' && a.download_only === 0 }];
        })).sort((x, y) => (x.ref < y.ref ? -1 : x.ref > y.ref ? 1 : 0));
        const digest = await linkDigest(link);
        const preview: PrivatePreview = freeze({
          state: 'private-candidate-not-published', caseId, candidateId, linkId: link.linkId, origin: candidate.origin, linkedAt: link.linkedAt,
          resultsVersion: rv, manifestSha256: pin.manifestSha256, packageInputRevisionId: pin.packageInputRevisionId,
          submissionRevisionId: link.submissionRevisionId, submissionManifestSha256: link.submissionManifestSha256, attribution: link.attribution,
          overview, rows, originals, unavailable: link.coverage.unavailableOriginals,
        }) as PrivatePreview;

        // Release: the read event, then a fresh session and content check, then the final fence statement.
        await record(caseId, candidateId, rv, 'succeeded');
        await identity.authorize({ caseId, operation: 'read-preview' });
        const operate = o.operateCondition(subject);
        const fence = await db.prepare(FENCE(operate.sql)).bind(...operate.values, clientId, caseId, candidateId, rv, link.linkId, digest, version.read_model_sha256)
          .first<{ operate: number; current: number }>().catch(() => fail('identity-unavailable', true));
        if (fence?.operate !== 1) return fail('forbidden');
        if (fence.current !== 1) return fail('not-found');
        return preview;
      } catch (e) {
        // The refusal stands whether or not its event persists. An anonymous request is not an actor to record.
        if (isDenial(e) && codeOf(e) !== 'unauthenticated') await record(caseId, candidateId, rv, 'denied').catch(() => undefined);
        throw e;
      }
    },
    async denied(input: { caseId: string; candidateId: string }): Promise<void> {
      try {
        if (typeof input?.caseId !== 'string' || !PART.test(input.caseId) || typeof input.candidateId !== 'string' || !PART.test(input.candidateId)) return;
        if (identity.kind !== 'verified' || identity.clientId !== clientId) return;
        await record(id('case', input.caseId) as CaseId, input.candidateId, null, 'denied');
      } catch { /* the refusal stands */ }
    },
  });
}

/** The request's own composed preview (compositions.ts), keyed by the exact original Request. Null answers 503. */
export type PrivatePreviewComposition = (a: { request: Request }) => PrivatePreviewReader | null;
let composition: PrivatePreviewComposition | null = null;
export function setPrivatePreviewComposition(c: PrivatePreviewComposition | null): void { composition = c; }
export function privatePreviewFor(a: { request: Request }): PrivatePreviewReader | null {
  try { return composition?.(a) ?? null; } catch { return null; }
}
