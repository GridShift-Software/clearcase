import type { CandidateSnapshot, CandidateSnapshotV2, EvidenceCountGroup, EvidenceItemRow, EvidenceKind, EvidenceObservation, PreviewStateV2, SectionStateV2 } from './ports.ts';
import { isIntegrityKey } from '../../case-package/registry.ts';
import { META_DISAGREEMENT_CODE, metaDisagreementFingerprint, type MetaBinding, type MetaCountDetail, type MetaDisagreement } from '../../case-package/meta-integrity.ts';
import { ASSET_ACK_CODE, ASSET_HOLD_REASONS, ORIGINAL_NOT_SUPPLIED, authenticMissingOriginals, isAssetHoldReason, type AssetBinding, type MissingOriginal } from './asset-policy.ts';
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
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['error', 'original', 'preview', 'section', 'warning'];
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
// The asset policy reasons (U10) are v2 only: v1's `previewCheck` keeps its own vocabulary. A policy reason belongs to a `failed` preview and to no other state.
const PREVIEW_REASONS_V2: ReadonlySet<unknown> = new Set<string>([...PREVIEW_REASON_CODES, ...ASSET_HOLD_REASONS]);
const reasonFits = (state: unknown, reason: unknown): boolean => PREVIEW_REASONS_V2.has(reason) && state !== 'rendered' && (!isAssetHoldReason(reason) || state === 'failed');
const sectionState = (v: unknown): v is SectionStateV2 => typeof v === 'string' && Object.hasOwn(SECTION_CLEARING, v);
const previewState = (v: unknown): v is PreviewStateV2 => typeof v === 'string' && Object.hasOwn(PREVIEW_CLEARING, v);
const safeCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function groupOk(g: unknown): g is EvidenceCountGroup {
  if (!plain(g) || !keys(g, ['kind', 'subject', 'state', 'reason', 'count']) || !safeCount(g.count) || g.count < 1) return false;
  switch (g.kind) {
    case 'section': return text(g.subject) && sectionState(g.state) && g.reason === null && g.count === 1;
    case 'preview': return g.subject === null && previewState(g.state) && (g.reason === null || reasonFits(g.state, g.reason));
    // A warning is grouped as a missing original when its item says so (`readiness-evidence.ts`); no other kind has a state or a reason.
    case 'warning': return g.subject === null && (g.state === null || g.state === ORIGINAL_NOT_SUPPLIED) && g.reason === null;
    case 'error': case 'original': return g.subject === null && g.state === null && g.reason === null;
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
 * once; every derived fingerprint is named, and the only others a group may name are the validator's own warnings for them. Groups of any other code are not about META and are ignored.
 */
function metaAcknowledged(s: CandidateSnapshotV2, meta: MetaEvidence | undefined): boolean {
  if (!meta || meta.disagreements.length === 0) return false;
  const bound: MetaBinding = { resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256,
    validatorVersion: s.validation.validatorVersion, diagnosticsSha256: s.validation.diagnosticsSha256 };
  const derived = new Set<string>(), diagnostics = new Set<string>();
  for (const d of meta.disagreements) {
    if (!disagreementOk(d) || d.fingerprint !== metaDisagreementFingerprint(bound, d)) return false;
    derived.add(d.fingerprint); diagnostics.add(d.diagnostic);
  }
  if (derived.size !== meta.disagreements.length) return false;
  const groups = meta.acknowledgements.filter((g) => plain(g) && g.code === META_DISAGREEMENT_CODE);
  if (groups.length === 0) return false;
  const named = new Set<string>();
  for (const g of groups) {
    if (typeof g.reason !== 'string' || g.reason.trim() === '' || g.reason.length > MAX_ACK_REASON || !Array.isArray(g.fingerprints)) return false;
    for (const f of g.fingerprints) {
      // The group may name a derived disagreement or the validator's own warning for one (ADR-0014: each disagreement has a matching diagnostic), and nothing else.
      if (typeof f !== 'string' || (!derived.has(f) && !diagnostics.has(f)) || named.has(f)) return false;
      named.add(f);
    }
  }
  return [...derived].every((f) => named.has(f));
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
export interface CheckedEvidenceItem { readonly key: string; readonly observation: EvidenceObservation; readonly acknowledgementRequired?: boolean; readonly meta?: MetaCountDetail;
  /** Present only on a warning that is the bound acknowledgement of a missing original (U10, `asset-policy.ts`). */
  readonly missing?: MissingOriginalDetail }
/** What a missing original's warning carries: the asset and the validator's own `ASSET_MISSING_AT_BUILD` diagnostic for it. */
export interface MissingOriginalDetail { readonly assetId: string; readonly diagnostic: string }
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const missingDetail = (m: unknown): m is MissingOriginalDetail => plain(m) && keys(m, ['assetId', 'diagnostic']) && typeof m.assetId === 'string' && ASSET_ID.test(m.assetId)
  && typeof m.diagnostic === 'string' && FP.test(m.diagnostic);

const metaDetail = (m: unknown): m is MetaCountDetail => plain(m) && keys(m, ['carried', 'derived', 'diagnostic', 'subject']) && (m.carried === null || safeCount(m.carried))
  && safeCount(m.derived) && typeof m.diagnostic === 'string' && FP.test(m.diagnostic) && text(m.subject, 200);

const disagreementOk = (d: unknown): d is MetaDisagreement => plain(d) && keys(d, ['carried', 'derived', 'diagnostic', 'fingerprint', 'subject']) && typeof d.fingerprint === 'string' && FP.test(d.fingerprint)
  && metaDetail({ carried: d.carried, derived: d.derived, diagnostic: d.diagnostic, subject: d.subject });

/** The META disagreements among checked warning items, as `MetaEvidence` wants them. A fingerprint listed twice is returned twice, so the rule refuses it. */
export const metaDisagreementsOf = (items: readonly CheckedEvidenceItem[]): MetaDisagreement[] =>
  items.flatMap((i) => (i.meta && i.observation.kind === 'warning' ? [{ ...i.meta, fingerprint: i.observation.fingerprint }] : []));

/**
 * The missing originals among the checked warnings of a whole run (U10), or null when any exception is not genuine: its diagnostic must be
 * `ASSET_MISSING_AT_BUILD` for exactly that asset, the validator's own warning must be in the run, and its fingerprint must be the one
 * recomputed from `binding`, the current candidate and validation (`authenticMissingOriginals`). Coverage of the originals (U14) may let
 * these stand in for an `original/` observation, and no other asset.
 */
export const missingOriginalsOf = (items: readonly CheckedEvidenceItem[], binding: AssetBinding): MissingOriginal[] | null => authenticMissingOriginals(items, binding);

/** The binding a snapshot gives the fingerprints of its candidate: the candidate's pin and the current validation. */
export const assetBindingOf = (s: CandidateSnapshotV2): AssetBinding => ({ resultsVersion: s.link.candidate.resultsVersion, manifestSha256: s.link.candidate.manifestSha256,
  validatorVersion: s.validation.validatorVersion, diagnosticsSha256: s.validation.diagnosticsSha256 });

/** A sign-off's recorded acknowledgements as groups, one per code and reason, as `signoffBlockerV2` takes them. An entry without a code is not about any section. */
export function acknowledgementGroups(acks: readonly { readonly fingerprint: string; readonly reason: string; readonly code?: string }[]): AcknowledgementGroup[] {
  const by = new Map<string, { code: string; reason: string; fingerprints: string[] }>();
  for (const a of acks) {
    if (a.code === undefined) continue;
    const key = JSON.stringify([a.code, a.reason]), g = by.get(key) ?? { code: a.code, reason: a.reason, fingerprints: [] };
    g.fingerprints.push(a.fingerprint); by.set(key, g);
  }
  return [...by.values()];
}

/** Whether the only thing between a candidate and sign-off is the acknowledgement of its META disagreements, which the sign-off itself supplies. */
export const awaitsMetaAcknowledgement = (b: Blocker | null): boolean => b !== null && b.code === 'required-section' && b.detail.length > 0 && b.detail.every((d) => d === 'meta:disagrees');

/** What the sealed run's warnings ask of a sign-off (`warningsOf`): the ones the case's baseline does not hold, and the exceptions among them all. */
export interface WarningsToAcknowledge { readonly fresh: readonly string[]; readonly meta: readonly MetaDisagreement[]; readonly missing: readonly MissingOriginal[] }
export type AcknowledgementFault =
  | { readonly code: 'ack-not-exact' }
  | { readonly code: 'ack-incomplete'; readonly missing: readonly string[] }
  | { readonly code: 'blocked'; readonly blocker: Blocker };
/**
 * Whether `groups` acknowledge exactly what the run asks, or the first fault. Sign-off applies it to the request's groups and publish to the
 * recorded ones (`acknowledgementGroups`), so the two cannot decide differently. Every fingerprint named is a fresh warning, named once; a
 * warning the baseline holds is never named, so a missing original the case already trusts needs nothing. A missing original and the
 * validator's warning for it are named only under that warning's code. META disagreements clear only as `metaAcknowledged` says. Every fresh
 * warning is named.
 */
export function acknowledgementFault(s: CandidateSnapshotV2, w: WarningsToAcknowledge, groups: readonly AcknowledgementGroup[]): AcknowledgementFault | null {
  const fresh = new Set(w.fresh), named = groups.flatMap((g) => g.fingerprints), unique = new Set(named);
  if (unique.size !== named.length || named.some((f) => !fresh.has(f))) return { code: 'ack-not-exact' };
  const codeOf = new Map(groups.flatMap((g) => g.fingerprints.map((f) => [f, g.code] as const)));
  if (w.missing.some((m) => [m.fingerprint, m.diagnostic].some((f) => codeOf.has(f) && codeOf.get(f) !== ASSET_ACK_CODE))) return { code: 'ack-not-exact' };
  const first = signoffBlockerV2(s), still = awaitsMetaAcknowledgement(first) ? signoffBlockerV2(s, { disagreements: w.meta, acknowledgements: groups }) : first;
  if (still) return { code: 'blocked', blocker: still };
  const missing = w.fresh.filter((f) => !unique.has(f));
  return missing.length ? { code: 'ack-incomplete', missing } : null;
}

function observationOf(o: unknown): { observation: EvidenceObservation; subject: string; meta?: MetaCountDetail; missing?: MissingOriginalDetail } | null {
  if (!plain(o)) return null;
  switch (o.kind) {
    case 'section':
      return keys(o, ['kind', 'key', 'state']) && text(o.key) && sectionState(o.state) ? { observation: o as unknown as EvidenceObservation, subject: o.key } : null;
    case 'preview':
      if (!text(o.assetId) || !previewState(o.state) || (o.state === 'rendered' && Object.keys(o).length !== 3)) return null;
      return Object.keys(o).every((k) => k === 'kind' || k === 'assetId' || k === 'state' || (k === 'reasonCode' && reasonFits(o.state, o[k])) || (k === 'stage' && isPreviewRenderStage(o[k]))
        || (k === 'navigation' && isPreviewNavigationObservation(o[k]))) ? { observation: o as unknown as EvidenceObservation, subject: o.assetId } : null;
    case 'warning': case 'error': {
      if (typeof o.fingerprint !== 'string' || !FP.test(o.fingerprint)) return null;
      if (keys(o, ['kind', 'fingerprint'])) return { observation: o as unknown as EvidenceObservation, subject: o.fingerprint };
      // A META count disagreement carries its counts. It is a warning only, and never its own diagnostic's fingerprint.
      if (o.kind === 'warning' && keys(o, ['kind', 'fingerprint', 'meta']) && metaDetail(o.meta) && o.meta.diagnostic !== o.fingerprint) {
        return { observation: { kind: 'warning', fingerprint: o.fingerprint }, subject: o.fingerprint, meta: o.meta };
      }
      // A missing original's warning carries its asset. It is a warning only, never its own diagnostic's fingerprint, and never also a META count.
      if (o.kind === 'warning' && keys(o, ['kind', 'fingerprint', 'missing']) && missingDetail(o.missing) && o.missing.diagnostic !== o.fingerprint) {
        return { observation: { kind: 'warning', fingerprint: o.fingerprint }, subject: o.fingerprint, missing: o.missing };
      }
      return null;
    }
    case 'original':
      // An etag is whatever R2 gave: opaque text, bounded. The size is a safe integer, as the object's size is.
      return keys(o, ['kind', 'assetId', 'sha256', 'size', 'etag']) && text(o.assetId) && typeof o.sha256 === 'string' && SHA.test(o.sha256) && safeCount(o.size) && text(o.etag, 128)
        ? { observation: o as unknown as EvidenceObservation, subject: o.assetId } : null;
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
  if (found.observation.kind === 'warning') return typeof row.baseline === 'boolean' ? { key: row.key, observation: found.observation, acknowledgementRequired: !row.baseline, ...(found.meta && { meta: found.meta }), ...(found.missing && { missing: found.missing }) } : null;
  return row.baseline === null ? { key: row.key, observation: found.observation } : null;
}
