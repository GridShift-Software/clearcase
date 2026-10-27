// Asset policy states for a v2 candidate (real-export design 3; U10; ADR-0011 accepted, ADR-0014 Proposed). Hosted-safe: pure functions.
//
// The evidence asset step decides each asset of the candidate by this policy and writes the result as evidence items:
//
//   viewable          the bytes the viewer would show (the original of a PDF or an inline image, otherwise the declared preview) were
//                     render-checked. The item is the render outcome, exactly: `rendered`, `failed` with its fixed reason, or `pending`.
//   held              the asset cannot be shown and nothing the publisher says changes that. The item is a `failed` preview with a
//                     named reason: `preview-required`, `embedded-not-extracted` or `supplied-references`. The rules never clear it.
//   not-supplied      the converter found no original and nothing cites the asset. It leaves the preview set: there is no preview item.
//                     Its item is a warning bound to this exact candidate and validation, so a sign-off must acknowledge it with a
//                     reason and an acknowledgement of an earlier candidate or validation names a fingerprint this one does not hold.
//
// Nothing here clears anything. A held asset is a failed preview, which `rules.ts` never clears; a missing original that is cited is held,
// so no acknowledgement reaches it. The one thing an acknowledgement does is clear the warning of a missing original nothing cites, and
// that warning stands in for the original's observation (U8) only because it is written here. The U14 coverage check asks `missingOriginalsOf`
// (`rules.ts`) which assets may lack an `original/` observation, and for no other.
import { canonicalJson } from '../../case-package/canonical.ts';
import { fingerprint } from '../../case-package/diagnostics.ts';
import { sha256Hex } from '../../case-package/hash.ts';
import { serveModeOf } from '../../case-package/media.ts';
import { escapePointer } from '../../case-package/strict-json.ts';
import type { EvidenceCountGroup } from './ports.ts';
import type { PreviewNavigationObservation, PreviewReasonCode, PreviewRenderStage } from './preview-outcome.ts';
import type { AcknowledgementGroup, CheckedEvidenceItem } from './rules.ts';

/** The reasons an asset is held. They are preview reasons of a `failed` preview, and only of one. */
export const ASSET_HOLD_REASONS = ['preview-required', 'embedded-not-extracted', 'supplied-references'] as const;
export type AssetHoldReason = (typeof ASSET_HOLD_REASONS)[number];
export const isAssetHoldReason = (v: unknown): v is AssetHoldReason => (ASSET_HOLD_REASONS as readonly unknown[]).includes(v);

/** The state the count of a missing original's warning is grouped under (`readiness-evidence.ts`). */
export const ORIGINAL_NOT_SUPPLIED = 'original-not-supplied' as const;
/**
 * The state a missing original's warning is counted under when the run does not also hold the validator's own warning it names. No snapshot
 * reader accepts it (`checkSnapshotV2`), so a run with such an exception is unavailable to readiness, sign-off and publish alike.
 */
export const ORIGINAL_NOT_WARNED = 'original-not-warned' as const;
/** The code a sign-off groups the acknowledgement of a missing original under: the validator's own code for it. */
export const ASSET_ACK_CODE = 'ASSET_MISSING_AT_BUILD' as const;
const FINGERPRINT_TAG = 'clearcase.original-not-supplied/1';
/** Where the validator reports a `missing` asset (`validate.ts`): the same file, pointer and subject. */
const ASSETS_FILE = 'assets.json';

export interface RenderOutcome {
  readonly state: 'rendered' | 'failed' | 'pending';
  readonly reasonCode?: PreviewReasonCode;
  readonly stage?: PreviewRenderStage;
  readonly navigation?: PreviewNavigationObservation;
}
/** What the evidence asset step knows of one asset of the candidate. */
export interface AssetPolicyInput {
  /** The asset's key in the package index. */
  readonly assetId: string;
  /** As the package declares it. A `file` whose original the case folder does not hold is `supplied: false`. */
  readonly kind: 'file' | 'embedded' | 'missing';
  readonly mediaType: string;
  /** Some citation of the candidate resolves to this asset. */
  readonly cited: boolean;
  /** The original's bytes are in the case folder and were read. */
  readonly supplied: boolean;
  /** The package declares a PDF preview of these bytes (U11). */
  readonly preview: boolean;
  /** The render check of the bytes the viewer would show, or null when none ran. */
  readonly render: RenderOutcome | null;
}

export type AssetDecision =
  | { readonly assetId: string; readonly policy: 'viewable'; readonly render: RenderOutcome | null }
  | { readonly assetId: string; readonly policy: 'held'; readonly reason: AssetHoldReason }
  | { readonly assetId: string; readonly policy: 'not-supplied' };

/** Only a PDF and the common images are shown as they are; every other format needs a preview (design 3). */
const shownAsIs = (mediaType: string): boolean => serveModeOf(mediaType) === 'inline-isolated';

export function decideAsset(a: AssetPolicyInput): AssetDecision {
  const { assetId } = a;
  // Embedded assets have no bytes. ADR-0011 requires each attachment to be viewable, so the fix is upstream: extract it.
  if (a.kind === 'embedded') return { assetId, policy: 'held', reason: 'embedded-not-extracted' };
  if (a.kind === 'missing') return a.cited ? { assetId, policy: 'held', reason: 'supplied-references' } : { assetId, policy: 'not-supplied' };
  // A file whose original is not there is an inconsistent package, not a recorded absence: held, never acknowledged.
  if (!a.supplied) return { assetId, policy: 'held', reason: 'supplied-references' };
  if (!shownAsIs(a.mediaType) && !a.preview) return { assetId, policy: 'held', reason: 'preview-required' };
  return { assetId, policy: 'viewable', render: a.render };
}

export class AssetPolicyError extends Error {
  constructor(message: string) { super(`asset policy: ${message}`); this.name = 'AssetPolicyError'; }
}

/** The candidate and validation an acknowledgement of a missing original is bound to. */
export interface AssetBinding { readonly resultsVersion: string; readonly manifestSha256: string; readonly validatorVersion: string; readonly diagnosticsSha256: string }

/** The validator's `ASSET_MISSING_AT_BUILD` warning for a missing asset: the fingerprint of the diagnostic it reports at this asset. */
export const missingAssetDiagnostic = (assetId: string): string =>
  fingerprint('ASSET_MISSING_AT_BUILD', { file: ASSETS_FILE, pointer: `/assets/${escapePointer(assetId)}/path`, subject: assetId });

/** The fingerprint a sign-off acknowledges for a missing original: bound to the exact candidate, the exact validation and the asset. */
export const missingOriginalFingerprint = (b: AssetBinding, assetId: string, diagnostic: string): string =>
  sha256Hex(canonicalJson([FINGERPRINT_TAG, b.resultsVersion, b.manifestSha256, b.validatorVersion, b.diagnosticsSha256, diagnostic, assetId])).slice(0, 32);

export interface EvidenceItemDraft { readonly key: string; readonly observation: Record<string, unknown> }

/**
 * The one definition of a missing-original exception for an asset under a candidate and validation: the validator's own diagnostic for it, and
 * the fingerprint recomputed from the binding. The build, the extractor and the sign-off and readiness reads all ask this, so none accepts
 * what another would refuse. With `warned` it also requires the validation to have reported that diagnostic; null when it did not.
 */
export function expectedMissingOriginal(binding: AssetBinding, assetId: string, warned?: ReadonlySet<string>): { diagnostic: string; fingerprint: string } | null {
  const diagnostic = missingAssetDiagnostic(assetId);
  if (warned && !warned.has(diagnostic)) return null;
  return { diagnostic, fingerprint: missingOriginalFingerprint(binding, assetId, diagnostic) };
}

/**
 * The evidence items the asset step contributes, in ascending key order. One `preview/<assetId>` item for every asset that is shown or held,
 * and one `warning/<fingerprint>` item for every asset that is not supplied, carrying the asset and the validator's diagnostic. The
 * validation must have reported that diagnostic (`warningFingerprints`): a missing original the validation did not warn about is not
 * something to acknowledge, and the build stops rather than invent it. Fixed vocabularies only.
 */
export function assetPolicyItems(inputs: readonly AssetPolicyInput[], context: { readonly binding: AssetBinding; readonly warningFingerprints: Iterable<string> }): EvidenceItemDraft[] {
  const warned = new Set(context.warningFingerprints), seen = new Set<string>(), items: EvidenceItemDraft[] = [];
  for (const input of inputs) {
    if (seen.has(input.assetId)) throw new AssetPolicyError(`asset ${input.assetId} appears twice`);
    seen.add(input.assetId);
    const d = decideAsset(input);
    switch (d.policy) {
      case 'held':
        items.push({ key: `preview/${d.assetId}`, observation: { kind: 'preview', assetId: d.assetId, state: 'failed', reasonCode: d.reason } });
        break;
      case 'viewable': {
        const r = d.render;
        // A rendered preview carries nothing else; a failed one keeps its fixed reason, stage and navigation exactly as the check gave them.
        items.push({ key: `preview/${d.assetId}`, observation: { kind: 'preview', assetId: d.assetId, state: r?.state ?? 'pending',
          ...(r && r.state !== 'rendered' && { ...(r.reasonCode && { reasonCode: r.reasonCode }), ...(r.stage && { stage: r.stage }), ...(r.navigation && { navigation: r.navigation }) }) } });
        break;
      }
      case 'not-supplied': {
        const e = expectedMissingOriginal(context.binding, d.assetId, warned);
        if (!e) throw new AssetPolicyError(`the validation reported no ASSET_MISSING_AT_BUILD for ${d.assetId}`);
        items.push({ key: `warning/${e.fingerprint}`, observation: { kind: 'warning', fingerprint: e.fingerprint, missing: { assetId: d.assetId, diagnostic: e.diagnostic } } });
        break;
      }
    }
  }
  return items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** One missing original the run holds: the asset, the validator's diagnostic for it and the bound fingerprint a sign-off acknowledges. */
export interface MissingOriginal { readonly assetId: string; readonly diagnostic: string; readonly fingerprint: string }

/** Whether one checked warning is a genuine missing-original exception for this candidate and validation: its diagnostic and its fingerprint are the recomputed ones. */
export function isAuthenticMissingOriginal(item: CheckedEvidenceItem, binding: AssetBinding): boolean {
  if (!item.missing || item.observation.kind !== 'warning') return false;
  const e = expectedMissingOriginal(binding, item.missing.assetId);
  return e !== null && item.missing.diagnostic === e.diagnostic && item.observation.fingerprint === e.fingerprint;
}

/**
 * The missing originals among the checked warnings of a whole run, or null when any exception is not genuine. Each must be the recomputed one
 * for the current candidate and validation, the validator's own warning for that exact asset must be in the run, and no asset or fingerprint
 * may appear twice. Anything else fails closed: a run with one doubtful exception has none. `items` must be every warning of the run.
 */
export function authenticMissingOriginals(items: readonly CheckedEvidenceItem[], binding: AssetBinding): MissingOriginal[] | null {
  const warnings = new Set(items.flatMap((i) => (i.observation.kind === 'warning' ? [i.observation.fingerprint] : []))), assets = new Set<string>(), found = new Set<string>(), out: MissingOriginal[] = [];
  for (const item of items) {
    if (!item.missing) continue;
    const fingerprint = item.observation.kind === 'warning' ? item.observation.fingerprint : '';
    if (!isAuthenticMissingOriginal(item, binding) || !warnings.has(item.missing.diagnostic) || assets.has(item.missing.assetId) || found.has(fingerprint)) return null;
    assets.add(item.missing.assetId); found.add(fingerprint);
    out.push({ ...item.missing, fingerprint });
  }
  return out;
}

/**
 * The acknowledgement a publisher gives for the missing originals of a candidate, as the sign-off route takes it: one group under the
 * validator's code with one reason. It names each bound fingerprint and, for the ones the case's baseline does not already hold (`fresh`),
 * the validator's own warning too, because a sign-off acknowledges every new warning exactly once. The sign-off records it with its audit event.
 */
export function missingOriginalAcknowledgement(missing: readonly { readonly fingerprint: string; readonly diagnostic: string }[], fresh: ReadonlySet<string>, reason: string): AcknowledgementGroup {
  const named = new Set<string>();
  for (const m of missing) {
    if (fresh.has(m.fingerprint)) named.add(m.fingerprint);
    if (fresh.has(m.diagnostic)) named.add(m.diagnostic);
  }
  return { code: ASSET_ACK_CODE, reason, fingerprints: [...named].sort() };
}

// ---- Operator wording ------------------------------------------------------------------------------------------------------

/** A policy state as the publisher meets it. `original-not-supplied` is the warning group; the rest are the reasons of a failed preview. */
export type AssetPolicyKey = typeof ORIGINAL_NOT_SUPPLIED | AssetHoldReason;
export interface AssetPolicyWording {
  readonly key: AssetPolicyKey;
  readonly title: string;
  readonly detail: string;
  /** What clears it: an acknowledgement with a reason at sign-off, or nothing the publisher can do in this screen. */
  readonly clearsBy: 'acknowledgement' | 'upstream-fix';
}
const WORDING: Readonly<Record<AssetPolicyKey, AssetPolicyWording>> = {
  'original-not-supplied': { key: 'original-not-supplied', title: 'Original not supplied', clearsBy: 'acknowledgement',
    detail: 'The converter found no original for this document and nothing in the results cites it. The client will not be able to open it. Acknowledge each with a reason to publish without it.' },
  'preview-required': { key: 'preview-required', title: 'Preview required', clearsBy: 'upstream-fix',
    detail: 'This file cannot be opened in the viewer as it is, and the export supplies no PDF preview of it. The processing step must supply a preview built from the original. This cannot be acknowledged.' },
  'embedded-not-extracted': { key: 'embedded-not-extracted', title: 'Attachment not extracted', clearsBy: 'upstream-fix',
    detail: 'This attachment is still inside the file that holds it and has no bytes of its own, so the client could not open it. The processing step must extract it as a file. This cannot be acknowledged.' },
  'supplied-references': { key: 'supplied-references', title: 'Required original not available', clearsBy: 'upstream-fix',
    detail: 'The original for this asset is not available. A citation in the results may point at it, and the client would follow that citation to nothing. Supply the original and convert again. This cannot be acknowledged.' },
};
export const assetPolicyWording = (key: AssetPolicyKey): AssetPolicyWording => WORDING[key];
export const isAssetPolicyKey = (v: unknown): v is AssetPolicyKey => typeof v === 'string' && Object.hasOwn(WORDING, v);

/** One line of the publisher's summary: a policy state, how many assets are in it and what to do. */
export interface AssetPolicyLine extends AssetPolicyWording { readonly count: number }
/**
 * The policy states present in a run, from its counts alone: a failed preview with a hold reason, and the warnings grouped as missing originals.
 * Lines are in a fixed order (not supplied first, then the reasons as listed) and a state with no assets has no line.
 */
export function assetPolicySummary(groups: readonly EvidenceCountGroup[]): AssetPolicyLine[] {
  const counts = new Map<AssetPolicyKey, number>();
  for (const g of groups) {
    const key = g.kind === 'warning' && g.state === ORIGINAL_NOT_SUPPLIED ? ORIGINAL_NOT_SUPPLIED : g.kind === 'preview' && g.state === 'failed' && isAssetHoldReason(g.reason) ? g.reason : null;
    if (key) counts.set(key, (counts.get(key) ?? 0) + g.count);
  }
  return ([ORIGINAL_NOT_SUPPLIED, ...ASSET_HOLD_REASONS] as const).flatMap((key) => (counts.has(key) ? [{ ...WORDING[key], count: counts.get(key)! }] : []));
}
