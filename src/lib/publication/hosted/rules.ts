import type { CandidateSnapshot } from './ports.ts';

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
const SECTION_STATES = new Set(['valid', 'invalid', 'unsupported', 'missing']);
const PREVIEW_STATES = new Set(['rendered', 'failed', 'pending']);

/**
 * The snapshot if it has exactly the documented shape, otherwise null (the caller answers 503, never trusts it). An
 * extra key such as `ready` makes the whole snapshot unreadable: a verdict smuggled in beside the facts is not a fact.
 */
export function checkSnapshot(v: unknown): CandidateSnapshot | null {
  if (!plain(v) || !keys(v, ['link', 'preparedBy', 'snapshotRevision', 'validation', 'trustedBaseline', 'requiredSections', 'requiredPreviews'])) return null;
  const { link, preparedBy, validation: val } = v;
  if (!plain(link) || !keys(link, ['linkId', 'clientId', 'caseId', 'submissionRevisionId', 'submissionManifestSha256', 'candidate'])) return null;
  if (!text(link.linkId) || !text(link.clientId) || !text(link.caseId) || !text(link.submissionRevisionId) || typeof link.submissionManifestSha256 !== 'string' || !SHA.test(link.submissionManifestSha256)) return null;
  const c = link.candidate;
  if (!plain(c) || !keys(c, ['clientId', 'caseId', 'candidateId', 'resultsVersion', 'manifestSha256', 'packageInputRevisionId'])) return null;
  if (!text(c.clientId) || !text(c.caseId) || !text(c.candidateId) || typeof c.resultsVersion !== 'string' || !RV.test(c.resultsVersion)
    || typeof c.manifestSha256 !== 'string' || !SHA.test(c.manifestSha256) || !text(c.packageInputRevisionId)) return null;
  if (!plain(preparedBy) || !keys(preparedBy, ['issuer', 'subject']) || !text(preparedBy.issuer) || !text(preparedBy.subject)) return null;
  if (!text(v.snapshotRevision)) return null;
  if (!plain(val) || !keys(val, ['verdict', 'validatorVersion', 'diagnosticsSha256', 'errorFingerprints', 'warningFingerprints'])) return null;
  if (!['accept', 'report', 'reject'].includes(val.verdict as string) || !text(val.validatorVersion) || typeof val.diagnosticsSha256 !== 'string' || !DIAGNOSTICS_SHA.test(val.diagnosticsSha256)) return null;
  if (!fingerprints(val.errorFingerprints) || !fingerprints(val.warningFingerprints) || !fingerprints(v.trustedBaseline)) return null;
  if (!Array.isArray(v.requiredSections) || !v.requiredSections.every((x) => plain(x) && keys(x, ['key', 'state']) && text(x.key) && SECTION_STATES.has(x.state as string))) return null;
  if (!Array.isArray(v.requiredPreviews) || !v.requiredPreviews.every((x) => plain(x) && keys(x, ['assetId', 'state']) && text(x.assetId) && PREVIEW_STATES.has(x.state as string))) return null;
  return structuredClone(v) as unknown as CandidateSnapshot;
}

export type Blocker =
  | { code: 'validation-failed'; detail: string[] }
  | { code: 'required-section'; detail: string[] }
  | { code: 'preview-not-ready'; detail: string[] };

/** The first rule that blocks sign-off, or null. Errors are never waivable; a required section or preview holds the update. */
export function signoffBlocker(s: CandidateSnapshot): Blocker | null {
  if (s.validation.verdict === 'reject' || s.validation.errorFingerprints.length > 0) return { code: 'validation-failed', detail: [...s.validation.errorFingerprints] };
  const sections = s.requiredSections.filter((x) => x.state !== 'valid').map((x) => `${x.key}:${x.state}`);
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
