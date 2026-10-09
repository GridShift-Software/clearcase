// Activation policy: a pure function over a fresh ImportResult. Errors are never waivable.
// Every warning whose fingerprint is not in the trusted baseline is new and must be covered
// by an acknowledgement bound to this exact result (resultsVersion, manifestSha256,
// diagnosticsSha256, validatorVersion). The trusted baseline comes from the active version's
// accepted warnings plus an operator-accepted local register; it is never read from a package.
import type { ImportResult } from './candidate.ts';
import { ACKNOWLEDGEMENT, type Acknowledgement } from './schema.ts';

export type ActivationReason =
  | { code: 'REJECTED'; message: string }
  | { code: 'ERRORS_PRESENT'; message: string; count: number }
  | { code: 'ERROR_NOT_WAIVABLE'; message: string; fingerprints: string[] }
  | { code: 'ACK_REQUIRED'; message: string; missing: string[] }
  | { code: 'ACK_STALE'; message: string; fields: string[] }
  | { code: 'ACK_INCOMPLETE'; message: string; missing: string[] };

export interface ActivationDecision { ok: boolean; reasons: ActivationReason[]; newWarnings: string[] }

/** New warning fingerprints of a result relative to a trusted baseline. */
export function newWarningFingerprints(result: ImportResult, trusted: Iterable<string>): string[] {
  const t = new Set(trusted);
  return result.warningFingerprints.filter((f) => !t.has(f));
}

export function canActivate(result: ImportResult, acknowledgement: Acknowledgement | null | undefined, trustedBaselineFingerprints: Iterable<string> = []): ActivationDecision {
  const reasons: ActivationReason[] = [];
  const trusted = new Set(trustedBaselineFingerprints);
  if (result.verdict === 'reject' || result.candidate === null) reasons.push({ code: 'REJECTED', message: 'the import was rejected; there is no candidate to activate' });
  const errors = result.errorFingerprints;
  if (errors.length > 0) reasons.push({ code: 'ERRORS_PRESENT', message: 'errors block activation and can never be waived', count: errors.length });
  const waived = [...new Set([...(acknowledgement?.warningFingerprints ?? []), ...trusted])].filter((f) => result.errorFingerprints.includes(f));
  if (waived.length > 0) reasons.push({ code: 'ERROR_NOT_WAIVABLE', message: 'an acknowledgement or baseline names an error; errors cannot be waived', fingerprints: waived });
  const fresh = newWarningFingerprints(result, trusted);
  if (fresh.length > 0) {
    if (!acknowledgement) reasons.push({ code: 'ACK_REQUIRED', message: `${fresh.length} new warning(s) need the operator's acknowledgement`, missing: fresh });
    else {
      const stale: string[] = [];
      if (acknowledgement.acknowledgement !== ACKNOWLEDGEMENT) stale.push('acknowledgement');
      if (result.candidate && acknowledgement.resultsVersion !== result.candidate.resultsVersion) stale.push('resultsVersion');
      if (result.candidate && acknowledgement.manifestSha256 !== result.candidate.manifestSha256) stale.push('manifestSha256');
      if (acknowledgement.diagnosticsSha256 !== result.diagnosticsSha256) stale.push('diagnosticsSha256');
      if (acknowledgement.validatorVersion !== result.validatorVersion) stale.push('validatorVersion');
      if (stale.length > 0) reasons.push({ code: 'ACK_STALE', message: 'the acknowledgement was made for different results or diagnostics; acknowledge again', fields: stale });
      const acked = new Set(acknowledgement.warningFingerprints);
      const missing = fresh.filter((f) => !acked.has(f));
      if (missing.length > 0) reasons.push({ code: 'ACK_INCOMPLETE', message: `${missing.length} new warning(s) are not acknowledged`, missing });
    }
  }
  return { ok: reasons.length === 0, reasons, newWarnings: fresh };
}

/** Builds an acknowledgement of the given (default: all new) warnings of a fresh result. */
export function acknowledge(result: ImportResult, warningFingerprints: Iterable<string>, by?: { acknowledgedBy?: string; at?: string }): Acknowledgement {
  if (!result.candidate) throw new Error('a rejected import cannot be acknowledged');
  return {
    acknowledgement: ACKNOWLEDGEMENT,
    resultsVersion: result.candidate.resultsVersion,
    manifestSha256: result.candidate.manifestSha256,
    diagnosticsSha256: result.diagnosticsSha256,
    validatorVersion: result.validatorVersion,
    warningFingerprints: [...new Set(warningFingerprints)].sort(),
    ...(by?.acknowledgedBy !== undefined && { acknowledgedBy: by.acknowledgedBy }),
    ...(by?.at !== undefined && { at: by.at }),
  };
}

/** Warnings an activated version carries forward as trusted: its acknowledged set plus the baseline it was checked against. */
export function acceptedWarnings(result: ImportResult, acknowledgement: Acknowledgement | null, trusted: Iterable<string>): string[] {
  const t = new Set([...trusted, ...(acknowledgement?.warningFingerprints ?? [])]);
  return result.warningFingerprints.filter((f) => t.has(f));
}
