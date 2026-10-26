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

const NOT_DATA = Symbol('not-data');
const MAX_DEPTH = 8, INDEX = /^(?:0|[1-9][0-9]{0,8})$/;
function detach(v: unknown, depth: number): unknown {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number') return v;
  if (typeof v !== 'object' || depth <= 0) return NOT_DATA;
  const array = Array.isArray(v);
  if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)) return NOT_DATA;
  const out: Record<string, unknown> | unknown[] = array ? [] : {};
  let indexes = 0;
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (typeof key !== 'string' || !d || !('value' in d) || (!d.enumerable && !(array && key === 'length'))) return NOT_DATA;
    if (array && key === 'length') continue;
    if (array && !INDEX.test(key)) return NOT_DATA;
    const value = detach(d.value, depth - 1);
    if (value === NOT_DATA) return NOT_DATA;
    // defineProperty, never assignment: an own `__proto__` key must stay an ordinary own key.
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
    indexes++;
  }
  return array && (out as unknown[]).length !== indexes ? NOT_DATA : out;
}
/**
 * A deep copy of JSON-shaped data, read once, or undefined. Only plain objects, dense arrays, strings, numbers, booleans and null
 * survive. An accessor (own or on a proxy's descriptor), a non-enumerable or symbol key, a custom prototype or anything else makes
 * the whole value undefined, so a value validated from the copy is exactly the value the copy returns: no later read can change it.
 */
export function detachedData(v: unknown): unknown {
  try { const out = detach(v, MAX_DEPTH); return out === NOT_DATA ? undefined : out; } catch { return undefined; }
}

function validNavigation(o: unknown): o is PreviewNavigationObservation {
  if (typeof o !== 'object' || o === null || Array.isArray(o) || Object.getPrototypeOf(o) !== Object.prototype) return false;
  const r = o as Record<string, unknown>, keys = Object.keys(r);
  return keys.every((k) => NAVIGATION_KEYS.has(k)) && GOTO_STATES.has(r.goto) && typeof r.documentAcknowledged === 'boolean'
    && (!keys.includes('firstViolation') || VIOLATIONS.has(r.firstViolation))
    && (!keys.includes('gotoError') || (r.goto === 'rejected' && GOTO_ERRORS.has(r.gotoError)));
}
/** Exactly the documented shape: a plain data object, only the four keys, each a fixed literal, `gotoError` only after a rejection. */
export function isPreviewNavigationObservation(v: unknown): boolean {
  return validNavigation(detachedData(v));
}
/** A fresh copy built from the fixed literals of one single read, or undefined. Nothing else the input carries survives. */
export function safePreviewNavigation(v: unknown): PreviewNavigationObservation | undefined {
  const d = detachedData(v);
  if (!validNavigation(d)) return undefined;
  return { goto: d.goto, documentAcknowledged: d.documentAcknowledged,
    ...(d.firstViolation !== undefined && { firstViolation: d.firstViolation }), ...(d.gotoError !== undefined && { gotoError: d.gotoError }) };
}
