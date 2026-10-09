// Browser-safe exports: rendering, link policy, ref grammar, canonical JSON, diagnostic codes,
// serving policy and user-work types. None of these modules imports filesystem code or Node built-ins.
export { renderNarrative, isSafeAppHref, documentRoute, displayText, displayFilename, revealInvisible, escapeHtml, safeExternalHref, exportCell, type RenderNarrativeOptions } from './render.ts';
export { classifyLink, REJECTED_SCHEMES, type LinkClass } from './links.ts';
export { isRef, isAssetKey, parseCitationToken, REF_PATTERN, ASSET_KEY_PATTERN } from './refs.ts';
export { canonicalJson, canonicalText, CanonicalError } from './canonical.ts';
export { parseStrictJson, decodeUtf8Strict, StrictJsonError, type JsonValue } from './strict-json.ts';
export { CODES, type Code, type Diagnostic, type Severity, type DiagClass } from './codes.ts';
export { servePolicy, serveModeOf, mediaTypeForName, type ServeMode, type TextStatus } from './media.ts';
export { checkRelPath, decodeLegacyLocator } from './paths.ts';
export { matchAnchor, viewSeeds, type DocumentAnchor, type AnchorMatch, type SeedRow, type SeedOverlay, type SeedView } from './user-work.ts';
export { readViewContent, isViewValue, isViewTemplate, VIEW_CONTENT_KEY, type ViewContentReader, type ViewValue, type ViewTemplate, type ViewTemplatePart, type FilledText } from './view-content.ts';
