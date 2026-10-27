import type { AuditEvent, CaseId } from '../../server/runtime/contracts.ts';
import { codeOf, isDenial } from '../../server/runtime/errors.ts';
import { id } from '../../server/runtime/ids.ts';
import { canonicalJson } from '../../case-package/canonical.ts';
import { sha256Canonical } from '../../results-review/native/digest.ts';
import type { PublicationRequest } from './controller.ts';
import type { CandidateSnapshot, CandidateSnapshotV2, EvidenceCountGroup, EvidenceKind, EvidenceObservation, EvidenceReader, NativePublicationPorts, RequiredPreviewState, SignoffIdentity, SignoffRecord } from './ports.ts';
import type { PreviewNavigationObservation, PreviewReasonCode, PreviewRenderStage } from './preview-outcome.ts';
import { EVIDENCE_KINDS, acknowledgementFault, acknowledgementGroups, assetBindingOf, awaitsMetaAcknowledgement, checkEvidenceItem, checkSnapshot, checkSnapshotV2, evidenceCount, newWarnings, signoffBlocker, signoffBlockerV2, type Blocker } from './rules.ts';
import { ORIGINAL_WARNED, assetPolicySummary, assetPolicyWording, isAssetHoldReason, isAuthenticMissingOriginal, type AssetPolicyKey, type AssetPolicyLine, type AssetPolicyWording } from './asset-policy.ts';
import { warningsOf } from './signoff-evidence.ts';
import type { ReadinessFence, ReadinessFenceResult, ReadinessObservation } from './readiness-fence.ts';

/** The observation a fence is given for a v2 snapshot. */
export type ReadinessObservationV2 = Omit<ReadinessObservation, 'snapshot'> & { snapshot: CandidateSnapshotV2 };
/**
 * The fence for a v2 snapshot, a separate port from `readinessFence`: a v1 fence compares lists a v2 snapshot does not carry, so it is
 * never handed one. Without this port a v2 candidate answers 503. Its D1 implementation is not part of snapshot v2 itself.
 */
export interface EvidenceReadinessFence {
  readonly protocol: 'coherent-evidence/1';
  check(observation: ReadinessObservationV2): Promise<ReadinessFenceResult>;
}
/**
 * Own read-only contract; ordinary publication ports alone must remain unavailable. `evidenceFence`, `evidence` and `evidencePageSize`
 * matter only to a v2 snapshot: the reader supplies persisted evidence pages, and the page size (1 to 500, default 100) is injected here.
 */
export type PublicationReadinessPorts = NativePublicationPorts & {
  readonly readinessFence?: ReadinessFence | null;
  readonly evidenceFence?: EvidenceReadinessFence | null;
  readonly evidence?: EvidenceReader | null;
  readonly evidencePageSize?: number;
};
export const DEFAULT_EVIDENCE_PAGE_SIZE = 100;
export const MAX_EVIDENCE_PAGE_SIZE = 500;

/** Observations only. Never a signed decision, pointer, apply receipt, or substitute for controller validation. */
export interface ReadinessView {
  caseId: string;
  identity: SignoffIdentity;
  materialSha256: string;
  blocker: Blocker | null;
  /** Preview checks exactly as the pinned snapshot recorded them, even while an earlier blocker is first. Opaque id, state and fixed codes only. */
  previewChecks: { assetId: string; state: RequiredPreviewState; reasonCode?: PreviewReasonCode; stage?: PreviewRenderStage; navigation?: PreviewNavigationObservation }[];
  requiredAcknowledgements: string[];
  selfApprovalRequired: boolean;
  signoff: null | {
    signoffId: string;
    identity: SignoffIdentity;
    state: 'recorded' | 'audited';
    invalidated: boolean;
    blockers: ('signoff-not-effective' | 'signoff-stale')[];
  };
}

/** Readiness for a candidate whose evidence is persisted (snapshot v2): the counts, the blocker and one page of the evidence items. */
export interface ReadinessViewV2 {
  format: 'clearcase.readiness/2';
  caseId: string;
  identity: SignoffIdentity;
  materialSha256: string;
  blocker: Blocker | null;
  evidence: { generation: string; root: string; items: number; groups: readonly EvidenceCountGroup[]; newWarnings: number };
  acknowledgementsRequired: number;
  /**
   * The asset policy states (U10) the run holds, with how many assets are in each and what the publisher reads for it. From the counts alone;
   * a state with no assets has no line. A sign-off or its acknowledgements never change a line: an acknowledgement is not an observation.
   */
  assets: AssetPolicyLine[];
  selfApprovalRequired: boolean;
  signoff: ReadinessView['signoff'];
  /** `items` are this page, in key order; `next` is the cursor for the page after it, or null at the end of the range. */
  page: { kind: EvidenceKind | null; size: number; items: ReadinessItemV2[]; next: string | null };
}

/** One evidence item on a page. `policy` is present on a held asset's preview and on a missing original's warning, and says which asset and what to do. */
export interface ReadinessItemV2 { key: string; observation: EvidenceObservation; acknowledgementRequired?: boolean; policy?: AssetPolicyWording & { assetId: string } }

const PART = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SIGNOFF = /^so-[A-Za-z0-9][A-Za-z0-9-]{15,63}$/;
const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
class Refusal {
  readonly status: number; readonly code: string; readonly message: string;
  constructor(status: number, code: string, message: string) { this.status = status; this.code = code; this.message = message; }
}
const refuse = (status: number, code: string, message: string): never => { throw new Refusal(status, code, message); };
const unavailable = (): never => refuse(503, 'readiness-unavailable', 'Exact publication material is unavailable. No approval or publication is implied.');
const identityOf = (s: CandidateSnapshot | CandidateSnapshotV2): SignoffIdentity => ({
  candidateId: s.link.candidate.candidateId, linkId: s.link.linkId,
  submissionRevisionId: s.link.submissionRevisionId, submissionManifestSha256: s.link.submissionManifestSha256,
  resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256,
  packageInputRevisionId: s.link.candidate.packageInputRevisionId, diagnosticsSha256: s.validation.diagnosticsSha256,
  validatorVersion: s.validation.validatorVersion, snapshotRevision: s.snapshotRevision,
});
const signedIdentity = (s: SignoffRecord): SignoffIdentity => ({
  candidateId: s.candidateId, linkId: s.linkId, submissionRevisionId: s.submissionRevisionId,
  submissionManifestSha256: s.submissionManifestSha256, resultsVersion: s.resultsVersion,
  manifestSha256: s.manifestSha256, packageInputRevisionId: s.packageInputRevisionId,
  diagnosticsSha256: s.diagnosticsSha256, validatorVersion: s.validatorVersion, snapshotRevision: s.snapshotRevision,
});

// A page cursor names the series it was issued for and the last key it returned. The series is the candidate, the evidence generation, the
// sealed root and the snapshot revision (which covers the case's warning baseline), folded into one digest `b`; the root `r` and the kind
// `k` travel in clear. A continuation is served only if the digest matches the snapshot being read now, otherwise it is refused with the
// restart signal, so the pages of one series always come from one generation, one root and one baseline. Opaque to a client.
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/, HEX64 = /^[0-9a-f]{64}$/, ITEM_KEY = /^[A-Za-z0-9._:/-]{1,200}$/;
interface PageCursor { binding: string; root: string; kind: EvidenceKind | null; after: string }
const seriesOf = (s: CandidateSnapshotV2) => sha256Canonical({ candidateId: s.link.candidate.candidateId, generation: s.evidence.generation, root: s.evidence.root, snapshotRevision: s.snapshotRevision });
const encodeCursor = (c: PageCursor) => btoa(JSON.stringify({ v: 2, b: c.binding, r: c.root, k: c.kind, a: c.after })).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
function decodeCursor(text: string): PageCursor | null {
  if (!CURSOR.test(text)) return null;
  try {
    const v = JSON.parse(atob(text.replaceAll('-', '+').replaceAll('_', '/'))) as Record<string, unknown>;
    if (v === null || typeof v !== 'object' || Object.keys(v).sort().join() !== 'a,b,k,r,v' || v.v !== 2 || typeof v.b !== 'string' || !HEX64.test(v.b) || typeof v.r !== 'string' || !HEX64.test(v.r)
      || typeof v.a !== 'string' || !ITEM_KEY.test(v.a) || !(v.k === null || EVIDENCE_KINDS.includes(v.k as EvidenceKind))) return null;
    return { binding: v.b, root: v.r, kind: v.k as EvidenceKind | null, after: v.a };
  } catch { return null; }
}

/** Own hook: parent must resolve the exact original Request to its real publication ports. No defaults/adapters here. */
export type ReadinessComposition = (a: { request: Request; platform: unknown }) => PublicationReadinessPorts | null | Promise<PublicationReadinessPorts | null>;
let composition: ReadinessComposition | null = null;
export function setReadinessComposition(c: ReadinessComposition | null): void { composition = c; }
export async function readinessControllerFor(a: { request: Request; platform: unknown }) {
  let ports: PublicationReadinessPorts | null = null;
  try { ports = await composition?.(a) ?? null; } catch { /* Fail closed. */ }
  return createPublicationReadiness(ports);
}

export function createPublicationReadiness(ports: PublicationReadinessPorts | null) {
  return { read: async (r: PublicationRequest): Promise<Response> => {
    try {
      if (r.request.method !== 'GET') refuse(405, 'method-not-allowed', 'Only GET is accepted.');
      if (!ports?.authorize || !ports.candidates || !ports.ledger || !ports.audit || !ports.publisher
        || ports.publisher.protocol !== 'atomic-publication/1' || typeof ports.publisher.receipt !== 'function' || typeof ports.now !== 'function'
        || ports.readinessFence?.protocol !== 'coherent-readiness/1' || typeof ports.readinessFence.check !== 'function') return unavailable();
      const p = ports;
      const raw = r.params.caseId;
      if (!raw || !PART.test(raw)) return refuse(404, 'not-found', 'Not found.');
      const caseId = id('case', raw) as CaseId;
      const who = r.identity;
      if (!who || who.kind !== 'verified') return refuse(401, 'unauthenticated', 'Sign in to continue.');
      if (who.clientId !== p.clientId) return refuse(401, 'wrong-client', 'Sign in for this client.');
      if (who.principal.kind !== 'staff') return refuse(403, 'forbidden', 'Explicit staff publication and preview access are required.');
      const scope = { clientId: p.clientId, caseId };
      const principal = Object.freeze({ ...who.principal }), sessionId = who.sessionId;
      const actor: AuditEvent['actor'] = Object.freeze({ kind: 'verified', principal, sessionId });
      const audit = async (outcome: AuditEvent['outcome'], action: string, candidateId: string) => {
        try { await p.audit!.append({ eventId: crypto.randomUUID(), actor, action, object: { kind: 'publication-readiness', id: candidateId, caseId }, version: null, outcome, at: p.now().toISOString() }); }
        catch { return refuse(503, 'audit-unavailable', 'Readiness was not released because its required audit could not be recorded.'); }
      };
      const denied = async (e: unknown): Promise<never> => {
        await audit('denied', 'publication.readiness.denied', raw);
        const code = codeOf(e);
        if (code === 'unauthenticated' || code === 'invalid-session' || code === 'wrong-client') return refuse(401, 'unauthenticated', 'Sign in for this client.');
        if (code === 'forbidden' || code === 'not-found') return refuse(403, 'forbidden', 'Explicit staff publication and preview access are required.');
        return refuse(503, 'identity-unavailable', 'Current authority cannot be verified.');
      };
      // The audited decision for both capabilities, made once at admission.
      const authority = async () => {
        try {
          await who.checkRevocation();
          await p.authorize!({ principal, sessionId, caseId, capability: 'publish' });
          await who.authorize({ caseId, operation: 'read-preview' });
        } catch (e) { return denied(e); }
      };
      // Later boundaries observe the live session only. Both grants are read again by the release fence, in the same
      // primary statement that compares the material and sign-off observations, after every other await.
      const session = async () => {
        try { await who.checkRevocation(); } catch (e) { return denied(e); }
      };
      // Both capabilities precede ALL snapshot/ledger/storage metadata, not just response release.
      await authority();
      const candidateId = r.url.searchParams.get('candidateId');
      const signoffId = r.url.searchParams.get('signoffId');
      if (!candidateId || !PART.test(candidateId) || (signoffId !== null && !SIGNOFF.test(signoffId))) return refuse(422, 'invalid-request', 'Name one candidate and optionally one exact sign-off.');
      await audit('succeeded', 'publication.readiness.intent', candidateId);
      await session();
      const readRaw = async (): Promise<unknown> => {
        let rawSnapshot: unknown;
        // The reader audits its own failure. Its denial stands as one here; any other fault holds readiness unavailable.
        try { rawSnapshot = await p.candidates!.read({ ...scope, candidateId }); } catch (e) { return isDenial(e) ? denied(e) : unavailable(); }
        if (rawSnapshot === null) return refuse(404, 'not-found', 'Not found.');
        return rawSnapshot;
      };
      const snapshot = async (rawSnapshot: unknown) => {
        // Fail unavailable rather than truncate any acknowledgement/blocker set. Bound before checkSnapshot clones it.
        if (JSON.stringify(rawSnapshot).length > 256 * 1024) return unavailable();
        const s = checkSnapshot(rawSnapshot);
        if (!s) return unavailable();
        if (s.link.clientId !== p.clientId || s.link.caseId !== caseId || s.link.candidate.clientId !== p.clientId
          || s.link.candidate.caseId !== caseId || s.link.candidate.candidateId !== candidateId) return refuse(404, 'not-found', 'Not found.');
        if ([s.validation.errorFingerprints, s.validation.warningFingerprints, s.trustedBaseline, s.requiredSections, s.requiredPreviews].some((xs) => xs.length > 200)) return unavailable();
        return s;
      };
      // `capped` is v1: a v2 candidate has no 200-entry or 256 KiB limit on its sign-off either.
      const signoff = async (capped = true) => {
        if (!signoffId) return null;
        const so = await p.ledger!.signoff({ ...scope, signoffId });
        if (!so || so.clientId !== p.clientId || so.caseId !== caseId || so.signoffId !== signoffId || so.candidateId !== candidateId) return refuse(404, 'not-found', 'Not found.');
        if (!['recorded', 'audited'].includes(so.state)) return unavailable();
        if (capped && (JSON.stringify(so).length > 256 * 1024 || so.warningFingerprints.length > 200 || so.acknowledgements.length > 200)) return unavailable();
        return structuredClone(so);
      };
      const stale = async () => {
        await audit('refused', 'publication.readiness.refused', candidateId);
        return refuse(409, 'readiness-stale', 'The candidate or sign-off changed during the read. Refresh and review again.');
      };
      // Snapshot v2: counts and the blocker from the snapshot, one page of items from the sealed run, nothing recomputed and nothing capped.
      const releaseV2 = async (rawV2: unknown): Promise<Response> => {
        const s = checkSnapshotV2(rawV2);
        if (!s) return unavailable();
        if (s.link.clientId !== p.clientId || s.link.caseId !== caseId || s.link.candidate.clientId !== p.clientId
          || s.link.candidate.caseId !== caseId || s.link.candidate.candidateId !== candidateId) return refuse(404, 'not-found', 'Not found.');
        const reader = p.evidence, fence = p.evidenceFence, size = p.evidencePageSize ?? DEFAULT_EVIDENCE_PAGE_SIZE;
        if (!reader || typeof reader.page !== 'function' || fence?.protocol !== 'coherent-evidence/1' || typeof fence.check !== 'function'
          || !Number.isInteger(size) || size < 1 || size > MAX_EVIDENCE_PAGE_SIZE) return unavailable();
        const kindParam = r.url.searchParams.get('kind'), cursorParam = r.url.searchParams.get('cursor');
        if (kindParam !== null && !EVIDENCE_KINDS.includes(kindParam as EvidenceKind)) return refuse(422, 'invalid-request', 'Name a known evidence kind.');
        const kind = kindParam as EvidenceKind | null, cursor = cursorParam === null ? null : decodeCursor(cursorParam);
        if (cursorParam !== null && (!cursor || cursor.kind !== kind)) return refuse(422, 'invalid-request', 'The cursor does not belong to this request.');
        const series = await seriesOf(s);
        if (cursor && (cursor.root !== s.evidence.root || cursor.binding !== series)) return await stale();
        const so = await signoff(false);
        let rows: Awaited<ReturnType<EvidenceReader['page']>>;
        try { rows = await reader.page({ ...scope, candidateId, generation: s.evidence.generation, root: s.evidence.root, after: cursor?.after ?? null, kind, limit: size + 1 }); } catch { return unavailable(); }
        if (rows === null) return await stale();
        if (!Array.isArray(rows) || rows.length > size + 1) return unavailable();
        // The run's summary counts a missing original under `ORIGINAL_WARNED` only when the run also holds the validator's warning it names; any
        // other state, including an older summary's, is one `checkSnapshotV2` refuses. So a page serves one only from a snapshot that counts it
        // so, and only when it is the recomputed exception.
        const warned = s.evidence.groups.some((g) => g.kind === 'warning' && g.state === ORIGINAL_WARNED);
        const more = rows.length > size, bound = { clientId: p.clientId, caseId, resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256 };
        const items: ReadinessItemV2[] = [];
        for (const row of rows.slice(0, size)) {
          const item = checkEvidenceItem(row, bound), previous = items.at(-1)?.key ?? cursor?.after ?? null;
          // Served rows are in strictly ascending key order after the cursor, and all of the requested kind.
          if (!item || (previous !== null && item.key <= previous) || (kind !== null && item.observation.kind !== kind)) return unavailable();
          if (item.missing && (!warned || !isAuthenticMissingOriginal(item, assetBindingOf(s)))) return unavailable();
          const o = item.observation, held = o.kind === 'preview' && o.state === 'failed' && isAssetHoldReason(o.reasonCode) ? o : null;
          const policy = item.missing ? { ...assetPolicyWording('original-not-supplied'), assetId: item.missing.assetId } : held ? { ...assetPolicyWording(held.reasonCode as AssetPolicyKey), assetId: held.assetId } : undefined;
          items.push({ key: item.key, observation: o, ...(item.acknowledgementRequired !== undefined && { acknowledgementRequired: item.acknowledgementRequired }), ...(policy && { policy }) });
        }
        // The whole range fitted in this one page, so it must be exactly as many items as the snapshot counts.
        if (cursor === null && !more && items.length !== (kind ? evidenceCount(s, kind) : s.evidence.items)) return unavailable();
        const next = more ? encodeCursor({ binding: series, root: s.evidence.root, kind, after: items.at(-1)!.key }) : null;
        let blocker = signoffBlockerV2(s), acknowledged = true;
        // A named sign-off carries the acknowledgements a META disagreement is cleared by; read what the sealed run derives and apply them, by
        // the rule sign-off and publish apply (`acknowledgementFault`).
        if (so && awaitsMetaAcknowledgement(blocker)) {
          let facts: Awaited<ReturnType<typeof warningsOf>>;
          try { facts = await warningsOf({ reader }, { clientId: p.clientId, caseId, candidateId, generation: s.evidence.generation, root: s.evidence.root,
            resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256 }, evidenceCount(s, 'warning'), assetBindingOf(s)); } catch { return unavailable(); }
          if (!facts) return unavailable();
          const groups = acknowledgementGroups(so.acknowledgements);
          blocker = signoffBlockerV2(s, { disagreements: facts.meta, acknowledgements: groups });
          acknowledged = acknowledgementFault(s, facts, groups) === null;
        }
        const blockers: NonNullable<ReadinessView['signoff']>['blockers'] = [];
        if (so) {
          if (so.state !== 'audited' || so.invalidatedAt !== null) blockers.push('signoff-not-effective');
          // The identity carries the revision, which covers the baseline; the sign-off must also bind the run this snapshot names:
          // its candidate, generation and root (U5 L). A sign-off over another generation is stale even when the root repeats.
          const run = so.evidence;
          if (canonicalJson(signedIdentity(so)) !== canonicalJson(identityOf(s)) || blocker || !acknowledged
            || so.acknowledgements.length !== s.evidence.newWarnings || so.warningFingerprints.length !== evidenceCount(s, 'warning')
            || run?.candidateId !== s.link.candidate.candidateId || run.generation !== s.evidence.generation || run.root !== s.evidence.root) blockers.push('signoff-stale');
        }
        const view: ReadinessViewV2 = {
          format: 'clearcase.readiness/2', caseId, identity: identityOf(s), materialSha256: await sha256Canonical(s), blocker,
          evidence: { generation: s.evidence.generation, root: s.evidence.root, items: s.evidence.items, groups: s.evidence.groups, newWarnings: s.evidence.newWarnings },
          acknowledgementsRequired: s.evidence.newWarnings, assets: assetPolicySummary(s.evidence.groups),
          selfApprovalRequired: principal.issuer === s.preparedBy.issuer && principal.subject === s.preparedBy.subject,
          signoff: so ? { signoffId: so.signoffId, identity: signedIdentity(so), state: so.state, invalidated: so.invalidatedAt !== null, blockers } : null,
          page: { kind, size, items, next },
        };
        await audit('succeeded', 'publication.readiness.release-intent', candidateId);
        await session();
        const latestSignoff = await signoff(false);
        if ((latestSignoff ? canonicalJson(latestSignoff) : null) !== (so ? canonicalJson(so) : null)) return await stale();
        let fenced: ReadinessFenceResult;
        try { fenced = await fence.check({ ...scope, principal, sessionId, snapshot: s, signoff: so }); } catch { fenced = 'unavailable'; }
        if (fenced === 'stale') return await stale();
        if (fenced !== 'current') {
          await audit(fenced === 'forbidden' || fenced === 'invalid-session' ? 'denied' : 'failed', 'publication.readiness.refused', candidateId);
          if (fenced === 'forbidden') return refuse(403, 'forbidden', 'Explicit staff publication and preview access are required.');
          if (fenced === 'invalid-session') return refuse(401, 'unauthenticated', 'Sign in for this client.');
          return unavailable();
        }
        return json(200, view);
      };
      const rawSnapshot = await readRaw();
      if (typeof rawSnapshot === 'object' && rawSnapshot !== null && 'format' in rawSnapshot) return await releaseV2(rawSnapshot);
      const s = await snapshot(rawSnapshot), so = await signoff();
      const signed = so ? canonicalJson(so) : null;
      const materialSha256 = await sha256Canonical(s);
      const blocker = signoffBlocker(s), requiredAcknowledgements = newWarnings(s);
      const blockers: NonNullable<ReadinessView['signoff']>['blockers'] = [];
      if (so) {
        if (so.state !== 'audited' || so.invalidatedAt !== null) blockers.push('signoff-not-effective');
        if (canonicalJson(signedIdentity(so)) !== canonicalJson(identityOf(s)) || blocker
          || canonicalJson(requiredAcknowledgements) !== canonicalJson(so.acknowledgements.map((x) => x.fingerprint))
          || canonicalJson([...s.validation.warningFingerprints].sort()) !== canonicalJson(so.warningFingerprints)) blockers.push('signoff-stale');
      }
      const view: ReadinessView = {
        caseId, identity: identityOf(s), materialSha256, blocker,
        previewChecks: s.requiredPreviews.map((p) => ({ ...p })), requiredAcknowledgements,
        selfApprovalRequired: principal.issuer === s.preparedBy.issuer && principal.subject === s.preparedBy.subject,
        signoff: so ? { signoffId: so.signoffId, identity: signedIdentity(so), state: so.state, invalidated: so.invalidatedAt !== null, blockers } : null,
      };
      // This records intent, NOT successful disclosure. A later refusal must never leave a release-success event.
      await audit('succeeded', 'publication.readiness.release-intent', candidateId);
      await session();
      // Early sign-off change detection only. The material is read once: the fence below compares that observation's
      // generation, link, version, validation and baseline coherently, which a second full read could not.
      const latestSignoff = await signoff();
      if ((latestSignoff ? canonicalJson(latestSignoff) : null) !== signed) return await stale();
      // ALL awaited audit/authority/storage/hash work precedes this shared D1 check. It compares the ORIGINAL
      // observations, not copies refreshed independently. Clerk was last observed in session(), not locked by D1.
      let fenced: ReadinessFenceResult;
      try {
        fenced = await p.readinessFence!.check({ ...scope, principal, sessionId, snapshot: s, signoff: so });
      } catch { fenced = 'unavailable'; }
      if (fenced === 'stale') return await stale();
      if (fenced !== 'current') {
        await audit(fenced === 'forbidden' || fenced === 'invalid-session' ? 'denied' : 'failed', 'publication.readiness.refused', candidateId);
        if (fenced === 'forbidden') return refuse(403, 'forbidden', 'Explicit staff publication and preview access are required.');
        if (fenced === 'invalid-session') return refuse(401, 'unauthenticated', 'Sign in for this client.');
        return unavailable();
      }
      // No further await, callback, audit or storage read on the successful release path.
      return json(200, view);
    } catch (e) {
      if (e instanceof Refusal) return json(e.status, { code: e.code, message: e.message });
      return json(503, { code: 'readiness-unavailable', message: 'Exact publication material cannot be read now. Nothing here approves or publishes it.' });
    }
  } };
}
