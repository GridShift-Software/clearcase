import type { CandidateSnapshot, CandidateSnapshotV2, EvidenceCountGroup, EvidenceItemRow, EvidenceKind, EvidenceObservation, PreviewStateV2, SectionStateV2 } from './ports.ts';
import { isIntegrityKey } from '../../case-package/registry.ts';
import { META_DISAGREEMENT_CODE, metaDisagreementFingerprint, type MetaBinding, type MetaCountDetail, type MetaDisagreement } from '../../case-package/meta-integrity.ts';
import { PREVIEW_REASON_CODES, detachedData, isPreviewNavigationObservation, isPreviewReasonCode, isPreviewRenderStage } from './preview-outcome.ts';

// Pure sign-off rules over a candidate snapshot (ADR-0010, ADR-0011, results-package acknowledgement contract). There
// is no readiness boolean anywhere: each rule reads the facts, and the snapshot shape is checked key by key.

const plain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const keys = (v: Record<string, unknown>, want: readonly string[]) => Object.keys(v).sort().join() === [...want].sort().join();
const text = (v: unknown, max = 256): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const SHA = /^[0-9a-f]{64}$/;
const DIAGNOSTICS_SHA = /^(?:sha256:)?[0-9a-f]{64}$/;
const RV = /^sha256:[0-9a-f]{64}$/;
const FP = /^[0-9a-f]{32}$/;
const fingerprints = (v: unknown): v is string[] => Array.isArray(v) && v.every((f) => typeof f === 'string' && FP.test(f)) && new Set(v).size === v.length;
const SECTION_STATES = new Set(['valid', 'integrity-verified', 'invalid', 'unsupported', 'missing']);
const PREVIEW_STATES = new Set(['rendered', 'failed', 'pending']);
/** `reasonCode`, `stage` and `navigation` are optional, fixed-literal only and never on a rendered preview; any other key or value makes the snapshot unreadable. */
const previewCheck = (x: unknown): boolean => plain(x) && text(x.assetId) && PREVIEW_STATES.has(x.state as string) && (x.state !== 'rendered' || Object.keys(x).length === 2)
  && Object.keys(x).every((k) => k === 'assetId' || k === 'state' || (k === 'reasonCode' && isPreviewReasonCode(x[k])) || (k === 'stage' && isPreviewRenderStage(x[k])) || (k === 'navigation' && isPreviewNavigationObservation(x[k])));

/** The link, candidate, preparer and revision of a snapshot: the same shape in v1 and v2. */
function identityOk(v: Record<string, unknown>): boolean {
  const { link, preparedBy } = v;
  if (!plain(link) || !keys(link, ['linkId', 'clientId', 'caseId', 'submissionRevisionId', 'submissionManifestSha256', 'candidate'])) return false;
  if (!text(link.linkId) || !text(link.clientId) || !text(link.caseId) || !text(link.submissionRevisionId) || typeof link.submissionManifestSha256 !== 'string' || !SHA.test(link.submissionManifestSha256)) return false;
  const c = link.candidate;
  if (!plain(c) || !keys(c, ['clientId', 'caseId', 'candidateId', 'resultsVersion', 'manifestSha256', 'packageInputRevisionId'])) return false;
  if (!text(c.clientId) || !text(c.caseId) || !text(c.candidateId) || typeof c.resultsVersion !== 'string' || !RV.test(c.resultsVersion)
    || typeof c.manifestSha256 !== 'string' || !SHA.test(c.manifestSha256) || !text(c.packageInputRevisionId)) return false;
  if (!plain(preparedBy) || !keys(preparedBy, ['issuer', 'subject']) || !text(preparedBy.issuer) || !text(preparedBy.subject)) return false;
  return text(v.snapshotRevision);
}

/**
 * The snapshot if it has exactly the documented shape, otherwise null (the caller answers 503, never trusts it). An
 * extra key such as `ready` makes the whole snapshot unreadable: a verdict smuggled in beside the facts is not a fact. The
 * input is read once into a detached copy (an accessor, proxy trap or non-data value refuses it), then that copy is checked
 * and returned, so nothing validated can change before it is handed back.
 */
export function checkSnapshot(input: unknown): CandidateSnapshot | null {
  const v = detachedData(input);
  if (!plain(v) || !keys(v, ['link', 'preparedBy', 'snapshotRevision', 'validation', 'trustedBaseline', 'requiredSections', 'requiredPreviews'])) return null;
  const { preparedBy, validation: val } = v;
  if (!identityOk(v)) return null;
  if (!plain(val) || !keys(val, ['verdict', 'validatorVersion', 'diagnosticsSha256', 'errorFingerprints', 'warningFingerprints'])) return null;
  if (!['accept', 'report', 'reject'].includes(val.verdict as string) || !text(val.validatorVersion) || typeof val.diagnosticsSha256 !== 'string' || !DIAGNOSTICS_SHA.test(val.diagnosticsSha256)) return null;
  if (!fingerprints(val.errorFingerprints) || !fingerprints(val.warningFingerprints) || !fingerprints(v.trustedBaseline)) return null;
  if (!Array.isArray(v.requiredSections) || !v.requiredSections.every((x) => plain(x) && keys(x, ['key', 'state']) && text(x.key) && SECTION_STATES.has(x.state as string))) return null;
  if (!Array.isArray(v.requiredPreviews) || !v.requiredPreviews.every(previewCheck)) return null;
  return v as unknown as CandidateSnapshot;
}

export type Blocker =
  | { code: 'validation-failed'; detail: string[] }
  | { code: 'required-section'; detail: string[] }
  | { code: 'preview-not-ready'; detail: string[] };

/** The first rule that blocks sign-off, or null. Errors are never waivable; a required section or preview holds the update. */
export function signoffBlocker(s: CandidateSnapshot): Blocker | null {
  if (s.validation.verdict === 'reject' || s.validation.errorFingerprints.length > 0) return { code: 'validation-failed', detail: [...s.validation.errorFingerprints] };
  // integrity-verified clears only a registered integrity key; it never stands in for a rendered view (ADR 0012).
  const sections = s.requiredSections.filter((x) => x.state !== 'valid' && !(x.state === 'integrity-verified' && isIntegrityKey(x.key)))
    .map((x) => `${x.key}:${x.state}`);
  if (sections.length) return { code: 'required-section', detail: sections };
  const previews = s.requiredPreviews.filter((x) => x.state !== 'rendered').map((x) => `${x.assetId}:${x.state}`);
  if (previews.length) return { code: 'preview-not-ready', detail: previews };
  return null;
}

/** Warnings not in the case's trusted baseline: exactly the set a sign-off must acknowledge, each with a reason. */
export function newWarnings(s: CandidateSnapshot): string[] {
  const trusted = new Set(s.trustedBaseline);
  return s.validation.warningFingerprints.filter((f) => !trusted.has(f)).sort();
}

// ---- Snapshot v2 ---------------------------------------------------------------------------------------------------------
// The same rules over counts instead of lists. Nothing here is capped: a count is a count, whatever the number of items. A state is
// added by adding it to its union in `ports.ts` and one row to its table below; `Record` makes the build fail until the row exists.

export const SNAPSHOT_V2_FORMAT = 'clearcase.candidate-snapshot/2' as const;
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['error', 'preview', 'section', 'warning'];
/**
 * `always` clears; `integrity-key` clears only a registered integrity dataset (ADR 0012); `acknowledged` clears only META, and only
 * when exactly its derived disagreements are acknowledged with a reason (ADR-0014, Proposed); `never` holds sign-off.
 */
type Clearing = 'always' | 'integrity-key' | 'acknowledged' | 'never';
const SECTION_CLEARING: Readonly<Record<SectionStateV2, Clearing>> = {
  valid: 'always',
  'integrity-verified': 'integrity-key',
  // ADR-0013 (Accepted): a required dataset with no native view clears as its complete records view. Never reported as `valid`.
  'records-rendered': 'always',
  // ADR-0014 (Proposed): holds until exactly the gate-derived disagreements are acknowledged (`metaAcknowledged`). Never clears alone.
  disagrees: 'acknowledged',
  invalid: 'never', unsupported: 'never', missing: 'never',
};
const PREVIEW_CLEARING: Readonly<Record<PreviewStateV2, Exclude<Clearing, 'integrity-key' | 'acknowledged'>>> = { rendered: 'always', failed: 'never', pending: 'never' };
export const SECTION_STATES_V2 = Object.keys(SECTION_CLEARING) as SectionStateV2[];
export const PREVIEW_STATES_V2 = Object.keys(PREVIEW_CLEARING) as PreviewStateV2[];
const PREVIEW_REASONS_V2: ReadonlySet<unknown> = new Set<string>(PREVIEW_REASON_CODES);
const sectionState = (v: unknown): v is SectionStateV2 => typeof v === 'string' && Object.hasOwn(SECTION_CLEARING, v);
const previewState = (v: unknown): v is PreviewStateV2 => typeof v === 'string' && Object.hasOwn(PREVIEW_CLEARING, v);
const safeCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function groupOk(g: unknown): g is EvidenceCountGroup {
  if (!plain(g) || !keys(g, ['kind', 'subject', 'state', 'reason', 'count']) || !safeCount(g.count) || g.count < 1) return false;
  switch (g.kind) {
    case 'section': return text(g.subject) && sectionState(g.state) && g.reason === null && g.count === 1;
    case 'preview': return g.subject === null && previewState(g.state) && (g.reason === null || (g.state !== 'rendered' && PREVIEW_REASONS_V2.has(g.reason)));
    case 'warning': case 'error': return g.subject === null && g.state === null && g.reason === null;
    default: return false;
  }
}

/** The v2 snapshot if it has exactly the documented shape and its counts are consistent, otherwise null (the caller answers 503). Read once, as `checkSnapshot` does. */
export function checkSnapshotV2(input: unknown): CandidateSnapshotV2 | null {
  const v = detachedData(input);
  if (!plain(v) || !keys(v, ['format', 'link', 'preparedBy', 'snapshotRevision', 'validation', 'evidence']) || v.format !== SNAPSHOT_V2_FORMAT || !identityOk(v)) return null;
  const { validation: val, evidence: e } = v;
  if (!plain(val) || !keys(val, ['verdict', 'validatorVersion', 'diagnosticsSha256'])) return null;
  if (!['accept', 'report', 'reject'].includes(val.verdict as string) || !text(val.validatorVersion) || typeof val.diagnosticsSha256 !== 'string' || !DIAGNOSTICS_SHA.test(val.diagnosticsSha256)) return null;
  if (!plain(e) || !keys(e, ['generation', 'root', 'items', 'groups', 'newWarnings']) || !text(e.generation) || typeof e.root !== 'string' || !SHA.test(e.root)) return null;
  if (!safeCount(e.items) || !safeCount(e.newWarnings) || !Array.isArray(e.groups) || !e.groups.every(groupOk)) return null;
  const groups = e.groups as EvidenceCountGroup[], seen = new Set<string>(), sections = new Set<string>();
  let total = 0, warnings = 0;
  for (const g of groups) {
    const id = JSON.stringify([g.kind, g.subject, g.state, g.reason]);
    if (seen.has(id) || (g.kind === 'section' && sections.has(g.subject!))) return null;
    seen.add(id); if (g.kind === 'section') sections.add(g.subject!);
    total += g.count; if (g.kind === 'warning') warnings += g.count;
  }
  if (total !== e.items || e.newWarnings > warnings) return null;
  return v as unknown as CandidateSnapshotV2;
}

const countOf = (s: CandidateSnapshotV2, kind: EvidenceKind) => s.evidence.groups.filter((g) => g.kind === kind).reduce((n, g) => n + g.count, 0);
/** How many items of a kind the snapshot says the run holds, for a reader to check a page against. */
export const evidenceCount = countOf;

/** One reasoned acknowledgement of a group of warnings of one code: every fingerprint in it is acknowledged with this one reason. */
export interface AcknowledgementGroup { readonly code: string; readonly reason: string; readonly fingerprints: readonly string[] }
/**
 * What the `disagrees` rule needs beyond the counts: the META disagreements the sealed run holds (`metaDisagreementsOf`, read from its
 * warning items) and the acknowledgements a sign-off offers. Absent, `disagrees` holds like any other unmet state.
 */
export interface MetaEvidence { readonly disagreements: readonly MetaDisagreement[]; readonly acknowledgements: readonly AcknowledgementGroup[] }
const MAX_ACK_REASON = 1000;

/**
 * Whether the acknowledgements are exactly the META disagreements this snapshot's run holds. Each disagreement's fingerprint must
 * recompute from this snapshot's candidate and validation and its own values, so evidence derived for another candidate or validation,
 * or an acknowledgement of an earlier value, never matches. Every group of the META code needs a reason; each fingerprint is named
 * once; none is missing and none is extra. Groups of any other code are not about META and are ignored.
 */
function metaAcknowledged(s: CandidateSnapshotV2, meta: MetaEvidence | undefined): boolean {
  if (!meta || meta.disagreements.length === 0) return false;
  const bound: MetaBinding = { resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256,
    validatorVersion: s.validation.validatorVersion, diagnosticsSha256: s.validation.diagnosticsSha256 };
  const derived = new Set<string>();
  for (const d of meta.disagreements) { if (d.fingerprint !== metaDisagreementFingerprint(bound, d)) return false; derived.add(d.fingerprint); }
  if (derived.size !== meta.disagreements.length) return false;
  const groups = meta.acknowledgements.filter((g) => g.code === META_DISAGREEMENT_CODE);
  if (groups.length === 0) return false;
  const named = new Set<string>();
  for (const g of groups) {
    if (typeof g.reason !== 'string' || g.reason.trim() === '' || g.reason.length > MAX_ACK_REASON || !Array.isArray(g.fingerprints)) return false;
    for (const f of g.fingerprints) { if (typeof f !== 'string' || !derived.has(f) || named.has(f)) return false; named.add(f); }
  }
  return named.size === derived.size;
}

/**
 * The first rule that blocks sign-off, or null: the v1 order and meaning over counts. Its detail lists one entry per group, which is
 * bounded by the vocabularies and the registered sections, never by the number of items: `<section>:<state>` for a section,
 * `<state>[:<reason>]=<count>` for previews, and `errors=<count>`.
 */
export function signoffBlockerV2(s: CandidateSnapshotV2, meta?: MetaEvidence): Blocker | null {
  const errors = countOf(s, 'error');
  if (s.validation.verdict === 'reject' || errors > 0) return { code: 'validation-failed', detail: [`errors=${errors}`] };
  const clears = (g: EvidenceCountGroup): boolean => {
    switch (SECTION_CLEARING[g.state as SectionStateV2]) {
      case 'always': return true;
      case 'integrity-key': return isIntegrityKey(g.subject!);
      case 'acknowledged': return g.subject === 'meta' && metaAcknowledged(s, meta);
      case 'never': return false;
    }
  };
  const sections = s.evidence.groups.filter((g) => g.kind === 'section' && !clears(g)).map((g) => `${g.subject}:${g.state}`).sort();
  if (sections.length) return { code: 'required-section', detail: sections };
  const previews = s.evidence.groups.filter((g) => g.kind === 'preview' && PREVIEW_CLEARING[g.state as PreviewStateV2] !== 'always')
    .map((g) => `${g.state}${g.reason ? `:${g.reason}` : ''}=${g.count}`).sort();
  if (previews.length) return { code: 'preview-not-ready', detail: previews };
  return null;
}

export interface EvidenceBound { readonly clientId: string; readonly caseId: string; readonly resultsVersion: string; readonly manifestSha256: string }
/** `meta` is present only on a warning that is a META count disagreement (`metaEvidenceItems`). */
export interface CheckedEvidenceItem { readonly key: string; readonly observation: EvidenceObservation; readonly acknowledgementRequired?: boolean; readonly meta?: MetaCountDetail }

const metaDetail = (m: unknown): m is MetaCountDetail => plain(m) && keys(m, ['carried', 'derived', 'diagnostic', 'subject']) && (m.carried === null || safeCount(m.carried))
  && safeCount(m.derived) && typeof m.diagnostic === 'string' && FP.test(m.diagnostic) && text(m.subject, 200);

/** The META disagreements among checked warning items, as `MetaEvidence` wants them. A fingerprint listed twice is returned twice, so the rule refuses it. */
export const metaDisagreementsOf = (items: readonly CheckedEvidenceItem[]): MetaDisagreement[] =>
  items.flatMap((i) => (i.meta && i.observation.kind === 'warning' ? [{ ...i.meta, fingerprint: i.observation.fingerprint }] : []));

function observationOf(o: unknown): { observation: EvidenceObservation; subject: string; meta?: MetaCountDetail } | null {
  if (!plain(o)) return null;
  switch (o.kind) {
    case 'section':
      return keys(o, ['kind', 'key', 'state']) && text(o.key) && sectionState(o.state) ? { observation: o as unknown as EvidenceObservation, subject: o.key } : null;
    case 'preview':
      if (!text(o.assetId) || !previewState(o.state) || (o.state === 'rendered' && Object.keys(o).length !== 3)) return null;
      return Object.keys(o).every((k) => k === 'kind' || k === 'assetId' || k === 'state' || (k === 'reasonCode' && PREVIEW_REASONS_V2.has(o[k])) || (k === 'stage' && isPreviewRenderStage(o[k]))
        || (k === 'navigation' && isPreviewNavigationObservation(o[k]))) ? { observation: o as unknown as EvidenceObservation, subject: o.assetId } : null;
    case 'warning': case 'error': {
      if (typeof o.fingerprint !== 'string' || !FP.test(o.fingerprint)) return null;
      if (keys(o, ['kind', 'fingerprint'])) return { observation: o as unknown as EvidenceObservation, subject: o.fingerprint };
      // A META count disagreement carries its counts. It is a warning only, and never its own diagnostic's fingerprint.
      if (o.kind === 'warning' && keys(o, ['kind', 'fingerprint', 'meta']) && metaDetail(o.meta) && o.meta.diagnostic !== o.fingerprint) {
        return { observation: { kind: 'warning', fingerprint: o.fingerprint }, subject: o.fingerprint, meta: o.meta };
      }
      return null;
    }
    default: return null;
  }
}

/**
 * One stored row, checked against the candidate it is served for, or null (the caller answers 503, never serves it). The row must be
 * bound to this client, case, results version and manifest; its observation must use only the fixed vocabularies; and its key must be
 * exactly `<kind>/<subject>`, so a row cannot be passed off as another. A warning also says whether it still needs an acknowledgement.
 */
export function checkEvidenceItem(row: EvidenceItemRow, bound: EvidenceBound): CheckedEvidenceItem | null {
  let parsed: unknown;
  try { parsed = detachedData(JSON.parse(row.json)); } catch { return null; }
  if (!plain(parsed) || !keys(parsed, ['input', 'observation']) || !plain(parsed.input)
    || !keys(parsed.input, ['caseId', 'clientId', 'manifestSha256', 'rendererVersion', 'resultsVersion', 'validatorVersion'])
    || parsed.input.caseId !== bound.caseId || parsed.input.clientId !== bound.clientId
    || parsed.input.resultsVersion !== bound.resultsVersion || parsed.input.manifestSha256 !== bound.manifestSha256
    || !text(parsed.input.rendererVersion) || !text(parsed.input.validatorVersion)) return null;
  const found = observationOf(parsed.observation);
  if (!found || row.key !== `${found.observation.kind}/${found.subject}`) return null;
  if (found.observation.kind === 'warning') return typeof row.baseline === 'boolean' ? { key: row.key, observation: found.observation, acknowledgementRequired: !row.baseline, ...(found.meta && { meta: found.meta }) } : null;
  return row.baseline === null ? { key: row.key, observation: found.observation } : null;
}
