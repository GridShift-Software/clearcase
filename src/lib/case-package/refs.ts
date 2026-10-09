// Ref grammar. Refs are package-local aliases for documents; they are never equated across
// independently built packages (identity of an original is sha256 + size).
// Browser-safe: no Node built-ins.

/** Document register ref, e.g. OD-001. */
export const REF_PATTERN = '^[A-Z]{1,8}-[0-9]{1,8}$';
/** Asset key: a register ref, or an embedded attachment <parentRef>.a<ordinal> (1-based). */
export const ASSET_KEY_PATTERN = '^[A-Z]{1,8}-[0-9]{1,8}(?:\\.a[1-9][0-9]{0,3})?$';

const REF = new RegExp(REF_PATTERN);
const ASSET_KEY = new RegExp(ASSET_KEY_PATTERN);

export const isRef = (s: unknown): s is string => typeof s === 'string' && REF.test(s);
export const isAssetKey = (s: unknown): s is string => typeof s === 'string' && ASSET_KEY.test(s);

/** Refs mentioned inside a free-text "refs" field, e.g. "VDM-001 – VDM-005". */
export const REF_IN_TEXT = /\b[A-Z]{1,8}-[0-9]{1,8}\b/g;

/** Inline citation token in authored prose: [[REF]] or [[REF#p<page>]]. */
export const CITATION_TOKEN = /\[\[([^\]\n]{0,80})\]\]/g;
const TOKEN_INNER = /^([A-Z]{1,8}-[0-9]{1,8})(?:#p([1-9][0-9]{0,4}))?$/;

export type CitationToken = { ref: string; page: number | null } | null;

export function parseCitationToken(inner: string): CitationToken {
  const m = TOKEN_INNER.exec(inner);
  return m ? { ref: m[1]!, page: m[2] ? Number(m[2]) : null } : null;
}
