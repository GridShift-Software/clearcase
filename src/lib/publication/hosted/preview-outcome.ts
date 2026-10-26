// Fixed, source-owned vocabulary for why a required preview is not rendered (ADR-0011). Only these literals ever leave the
// renderer boundary: an unknown value, such as a raw exception, URL, session or provider text, becomes the generic code.

/** The reason strings `native-render-check.ts` itself assigns, plus two codes the material reader derives from the same outcome. */
export const PREVIEW_REASON_CODES = ['invalid-render-input', 'unsupported-media-type', 'file-budget-exceeded', 'input-integrity-mismatch',
  'unsupported-pdf', 'render-receipt-integrity', 'render-receipt-unavailable', 'render-admission-unavailable', 'render-admission-refused',
  'render-timeout', 'render-failed', 'render-cleanup-failed', 'incomplete-render-transcript', 'page-reference-out-of-range', 'render-unavailable'] as const;
/** The phase the renderer was in, assigned before that phase's first await. Diagnostic only; never a verdict. */
export const PREVIEW_RENDER_STAGES = ['launch', 'page-setup', 'navigation', 'inspection', 'cleanup'] as const;
export type PreviewReasonCode = (typeof PREVIEW_REASON_CODES)[number];
export type PreviewRenderStage = (typeof PREVIEW_RENDER_STAGES)[number];

const REASONS: ReadonlySet<unknown> = new Set(PREVIEW_REASON_CODES);
const STAGES: ReadonlySet<unknown> = new Set(PREVIEW_RENDER_STAGES);
export const isPreviewReasonCode = (v: unknown): v is PreviewReasonCode => REASONS.has(v);
export const isPreviewRenderStage = (v: unknown): v is PreviewRenderStage => STAGES.has(v);
/** The reason if allowlisted, otherwise the generic code. Never returns the input unless it is one of the fixed literals. */
export const safePreviewReason = (v: unknown): PreviewReasonCode => isPreviewReasonCode(v) ? v : 'render-unavailable';

/** Where `page.goto` stood when the run ended. `pending` means the run ended (deadline or another failure) before it settled. */
export const PREVIEW_GOTO_STATES = ['resolved', 'rejected', 'pending'] as const;
/** The first thing the renderer refused or saw go wrong, as a class. Never the URL, path, message or request that did it. */
export const PREVIEW_FIRST_VIOLATIONS = ['unowned-path', 'favicon-path', 'method', 'origin', 'request-budget', 'static-response', 'static-integrity',
  'requestfailed', 'pageerror', 'dialog', 'popup', 'other'] as const;
/** The `net::ERR_*` codes a rejected `goto` may name. Any other text, known or not, becomes `generic`. */
export const PREVIEW_GOTO_ERRORS = ['blocked-by-client', 'blocked-by-administrator', 'access-denied', 'aborted', 'failed', 'connection-refused',
  'connection-closed', 'connection-reset', 'name-not-resolved', 'timed-out', 'generic'] as const;
export type PreviewGotoState = (typeof PREVIEW_GOTO_STATES)[number];
export type PreviewFirstViolation = (typeof PREVIEW_FIRST_VIOLATIONS)[number];
export type PreviewGotoError = (typeof PREVIEW_GOTO_ERRORS)[number];
/** What the run observed around navigation. Diagnostic only; never part of a verdict, and never on a rendered preview. */
export interface PreviewNavigationObservation {
  readonly goto: PreviewGotoState;
  /** True only after the source-owned document's `respond` was acknowledged. */
  readonly documentAcknowledged: boolean;
  readonly firstViolation?: PreviewFirstViolation;
  /** Only with `goto: 'rejected'`. */
  readonly gotoError?: PreviewGotoError;
}

const GOTO_STATES: ReadonlySet<unknown> = new Set(PREVIEW_GOTO_STATES);
const VIOLATIONS: ReadonlySet<unknown> = new Set(PREVIEW_FIRST_VIOLATIONS);
const GOTO_ERRORS: ReadonlySet<unknown> = new Set(PREVIEW_GOTO_ERRORS);
const NAVIGATION_KEYS: ReadonlySet<string> = new Set(['goto', 'documentAcknowledged', 'firstViolation', 'gotoError']);
/** Exactly the documented shape: a plain object, only the four keys, each a fixed literal, `gotoError` only after a rejection. */
export function isPreviewNavigationObservation(v: unknown): v is PreviewNavigationObservation {
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) return false;
  const o = v as Record<string, unknown>, keys = Object.keys(o);
  return keys.every((k) => NAVIGATION_KEYS.has(k)) && GOTO_STATES.has(o.goto) && typeof o.documentAcknowledged === 'boolean'
    && (!keys.includes('firstViolation') || VIOLATIONS.has(o.firstViolation))
    && (!keys.includes('gotoError') || (o.goto === 'rejected' && GOTO_ERRORS.has(o.gotoError)));
}
/** A fresh copy built from the fixed literals, or undefined. Nothing else the input carries survives. */
export function safePreviewNavigation(v: unknown): PreviewNavigationObservation | undefined {
  try {
    if (!isPreviewNavigationObservation(v)) return undefined;
    return { goto: v.goto, documentAcknowledged: v.documentAcknowledged,
      ...(v.firstViolation !== undefined && { firstViolation: v.firstViolation }), ...(v.gotoError !== undefined && { gotoError: v.gotoError }) };
  } catch { return undefined; }
}
