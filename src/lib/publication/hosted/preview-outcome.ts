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
