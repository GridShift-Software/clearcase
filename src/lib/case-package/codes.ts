// Diagnostic code registry. Codes are stable; a severity may only be raised in a new
// format version. Errors are never waivable. A warning lets a candidate through, but each
// new warning needs the operator's acknowledgement before activation. Info is shown only.
// Classes: structural (shape, identity, containment, version), integrity (bytes and
// fingerprints disagree), quality (defects carried over from the source data).
// Browser-safe: no Node built-ins.

export type Severity = 'error' | 'warning' | 'info';
export type DiagClass = 'structural' | 'integrity' | 'quality';

interface CodeDef { severity: Severity; cls: DiagClass; title: string; hint: string }

const e = (cls: DiagClass, title: string, hint: string): CodeDef => ({ severity: 'error', cls, title, hint });
const w = (cls: DiagClass, title: string, hint: string): CodeDef => ({ severity: 'warning', cls, title, hint });
const i = (cls: DiagClass, title: string, hint: string): CodeDef => ({ severity: 'info', cls, title, hint });

const REBUILD = 'Rebuild the package with the converter; do not edit package files by hand.';

export const CODES = {
  // source and layout
  PKG_SOURCE_INVALID: e('structural', 'package source is not a directory, zip file or byte collection', 'Select the package directory or its .zip file.'),
  PKG_MANIFEST_MISSING: e('structural', 'manifest.json missing', 'Select the folder that contains manifest.json.'),
  PKG_NOT_A_PACKAGE: e('structural', 'manifest.format is not clearcase.results-package', 'This is not a ClearCase results package; convert the source first.'),
  PKG_MANIFEST_INVALID: e('structural', 'manifest does not match the manifest schema', REBUILD),
  PKG_SYMLINK: e('structural', 'symlink inside the package', 'Remove links from the package; copy real files instead.'),
  PKG_SPECIAL_FILE: e('structural', 'non-regular file inside the package', 'Remove devices, sockets and FIFOs from the package.'),
  PKG_TOO_MANY_FILES: e('structural', 'file count limit exceeded', 'Split the results or raise the bound in a new format version.'),
  PKG_TOO_LARGE: e('structural', 'size limit exceeded', 'Check the package for unexpected content; the bounds are in docs/results-package.md.'),
  PKG_PATH_INVALID: e('structural', 'listed path violates the path rules', REBUILD),
  PKG_PATH_TRAVERSAL: e('structural', 'listed path escapes the package root', 'Do not import this package; a listed path points outside it.'),
  PKG_DUPLICATE_PATH: e('structural', 'path listed twice (exactly or after case/NFC folding)', REBUILD),
  PKG_FILE_MISSING: e('structural', 'listed file missing', 'Copy the complete package; a listed file is absent.'),
  PKG_FILE_HASH_MISMATCH: e('integrity', 'file bytes do not match the manifest size or sha256', 'The package was changed or damaged after it was built; rebuild it.'),
  PKG_UNLISTED_FILE: w('structural', 'file present but not listed (ignored, never imported)', 'Remove the extra file or rebuild the package.'),
  PKG_NONCANONICAL: e('structural', 'file is not canonical JSON', REBUILD),
  PKG_INPUT_REVISION_MISMATCH: e('integrity', 'inputRevision.id is not the digest of its sources', REBUILD),
  PKG_VERSION_MISMATCH: e('integrity', 'resultsVersion is not the digest of the listed content', REBUILD),
  PKG_ROLE_INVALID: e('structural', 'missing or duplicate asset index', REBUILD),
  JSON_BAD_UTF8: e('structural', 'file is not valid UTF-8 or has a byte order mark', REBUILD),
  JSON_MALFORMED: e('structural', 'malformed JSON', REBUILD),
  JSON_DUPLICATE_KEY: e('structural', 'duplicate key in a JSON object', REBUILD),
  JSON_LIMIT: e('structural', 'JSON nesting or size bound exceeded', 'Check the source for runaway data; the bounds are in docs/results-package.md.'),
  // versions
  VER_UNSUPPORTED: e('structural', 'unsupported package format or formatVersion', 'Convert the package with a matching converter or upgrade ClearCase.'),
  // zip transport
  ARC_MALFORMED: e('structural', 'malformed zip archive', 'Re-create the zip from the package directory.'),
  ARC_UNSUPPORTED: e('structural', 'unsupported zip feature (encryption, method, multi-disk)', 'Use an unencrypted zip with stored or deflated entries.'),
  ARC_LIMIT: e('structural', 'archive bound exceeded (entries, expanded size or ratio)', 'Check the archive for a decompression bomb; the bounds are in docs/results-package.md.'),
  ARC_ENTRY_INVALID: e('structural', 'unsafe archive entry (traversal, absolute, link, duplicate, file/folder clash)', 'Do not import this archive; re-create it from the package directory.'),
  // datasets
  DS_ENVELOPE_INVALID: e('structural', 'dataset envelope does not match its schema', REBUILD),
  DS_MANIFEST_MISMATCH: e('structural', 'dataset envelope disagrees with the manifest', REBUILD),
  DS_COUNT_MISMATCH: e('structural', 'declared count differs from the actual record count', REBUILD),
  DS_SHAPE_INVALID: e('structural', 'record does not match the dataset schema', 'Fix the source record and convert again.'),
  DS_SCHEMA_UNSUPPORTED: e('structural', 'a required dataset uses a schema this reader does not understand', 'Upgrade ClearCase or convert with a matching converter.'),
  DS_UNKNOWN_SCHEMA: w('structural', 'optional dataset with an unknown or opaque schema (preserved, not rendered)', 'Review the dataset; it is kept but not shown.'),
  DS_REQUIRED_MISSING: e('structural', 'required dataset missing', REBUILD),
  DS_USERWORK_EMBEDDED: e('structural', 'user work found inside immutable results', 'Keep notes and registers in the workspace, not in a results package.'),
  DS_UNSUPPORTED_FIELD: w('quality', 'field not in the dataset schema (preserved, not rendered)', 'Review the field; a later format version may support it.'),
  DS_ENUM_UNKNOWN: w('quality', 'value outside the known set', 'Review the value in the source.'),
  DS_DATE_INVALID: w('quality', 'date has the right form but is not a calendar date', 'Review the source date; the value is kept unchanged.'),
  DS_SEED_ID_AMBIGUOUS: w('quality', 'two seed rows share a stable seed id', 'Make the seed rows distinguishable in the source.'),
  // identity
  ID_DUPLICATE: e('structural', 'duplicate document ref', 'Give each document a unique ref in the source and convert again.'),
  ID_REF_INVALID: e('structural', 'ref missing or not matching the ref grammar', 'Fix the ref in the source and convert again.'),
  // asset index
  ASSET_PATH_INVALID: e('structural', 'asset path violates the path rules', 'Fix the original path in the source and convert again.'),
  ASSET_PATH_TRAVERSAL: e('structural', 'asset path escapes the case folder', 'Do not import this package; an original points outside the case folder.'),
  ASSET_PATH_RESERVED: e('structural', 'asset path inside the reserved .clearcase/ area', 'Move the original out of .clearcase/ and convert again.'),
  ASSET_AMBIGUOUS_MAPPING: e('structural', 'two refs map to different paths that collide after case/NFC folding', 'Rename one original so the paths stay distinct on every filesystem.'),
  ASSET_SHARED_PATH: i('quality', 'several refs name the same original (alias)', 'No action; the refs open the same bytes.'),
  ASSET_PARENT_UNKNOWN: e('structural', 'parentRef does not exist in the asset index', REBUILD),
  ASSET_PARENT_CYCLE: e('structural', 'parent chain cycles or is too deep', REBUILD),
  ASSET_TOO_LARGE: e('structural', 'declared original size exceeds the per-original bound', 'Split or remove the oversized original; the bound is in docs/results-package.md.'),
  ASSET_PARENT_NOT_CONTAINER: w('quality', 'parent media type is not a container (e-mail or archive)', 'Review the attachment mapping in the source.'),
  ASSET_NOT_INDEXED: w('quality', 'document has no asset entry and cannot be opened', 'Add the original to the case folder and convert again.'),
  ASSET_ORPHAN: w('quality', 'asset has no document row and no parent', 'Review the asset index.'),
  ASSET_MISSING_AT_BUILD: w('quality', 'the converter found no original for this document', 'Add the original to the case folder and convert again, or acknowledge it as missing.'),
  ASSET_DUPLICATE_CONTENT: i('quality', 'several refs share identical content (sha256)', 'No action; anchors use the fingerprint and disclose the ambiguity.'),
  TEXT_NONE: w('quality', 'text-capable media but no text was extracted (e.g. a scan without OCR)', 'Run OCR in the pipeline, or acknowledge that the text is absent.'),
  TEXT_PENDING: i('quality', 'text extraction pending', 'No action; the document opens but is not searchable.'),
  MEDIA_UNSUPPORTED: i('quality', 'media type has no text extractor; open or download only', 'No action; this is not missing text.'),
  TEXT_STATUS_INCONSISTENT: w('quality', 'textStatus contradicts the media capability', 'Review the text status in the source.'),
  // originals in the case folder
  ORIG_CASE_FOLDER_INVALID: e('integrity', 'case folder missing, unreadable or not a directory', 'Select the case folder that holds the originals.'),
  ORIG_MISSING: w('integrity', 'original not found in the case folder', 'Restore the original, or acknowledge it; the document stays flagged as missing.'),
  ORIG_FINGERPRINT_MISMATCH: e('integrity', 'original bytes differ from the indexed size or sha256', 'Restore the original bytes or convert again from the current case folder.'),
  ORIG_ESCAPE: e('integrity', 'original resolves outside the case folder (link escape)', 'Replace the link with the real file inside the case folder.'),
  ORIG_NOT_FILE: e('integrity', 'original is not a regular file', 'Replace it with a regular file.'),
  ORIG_UNREADABLE: e('integrity', 'original could not be read', 'Check file permissions in the case folder.'),
  ORIG_CASE_MISMATCH: w('integrity', 'original found only by a case- or normalisation-insensitive match', 'Rename the file to its indexed name, or acknowledge the recorded on-disk name.'),
  ORIG_MEDIA_MISMATCH: w('integrity', 'content contradicts the declared media type (download only)', 'Review the original; it will only be offered as a download.'),
  ORIG_TOO_LARGE: e('integrity', 'original exceeds the per-original bound', 'Remove or split the oversized original; the bound is in docs/results-package.md.'),
  ORIG_TOTAL_TOO_LARGE: e('integrity', 'referenced originals exceed the total bound', 'Split the case; the bound is in docs/results-package.md.'),
  IMPORT_DEADLINE: e('integrity', 'validation exceeded its deadline', 'Retry on a faster disk or with a warm cache; nothing was stored.'),
  IMPORT_ABORTED: e('integrity', 'import cancelled', 'Start the import again; nothing was stored.'),
  // citations
  CITE_UNRESOLVED: w('quality', 'citation target is not in the document register', 'Fix the citation in the source, or acknowledge it as a known defect.'),
  CITE_TARGET_NO_ORIGINAL: w('integrity', 'cited document has no original in the case folder', 'Restore the original, or acknowledge it; the citation stays flagged.'),
  CITE_TOKEN_INVALID: w('quality', 'malformed [[...]] citation token', 'Use [[REF]] or [[REF#pN]].'),
  CITE_BARE_MENTION: i('quality', 'ref mentioned in prose without a [[...]] token (not linked)', 'No action; use [[REF]] to make it a link.'),
  // links and text
  LINK_UNSAFE_SCHEME: e('structural', 'link uses a forbidden URL scheme', 'Remove the link from the source; only https and mailto may be external links.'),
  LINK_RELATIVE_UNSAFE: e('structural', 'link is absolute, protocol-relative, UNC, a drive path or traversing', 'Use a "./" locator inside the case folder.'),
  LINK_EXTERNAL: i('quality', 'external link (rendered inert, never fetched)', 'No action.'),
  LINK_TEXT_ONLY: i('quality', 'link with a scheme that is shown as text only', 'No action.'),
  LINK_ASSET_MISMATCH: w('quality', 'legacy locator disagrees with the indexed original path', 'Review the source locator.'),
  TEXT_CONTROL_CHARS: w('quality', 'text contains control or bidirectional-override characters (rendered visibly)', 'Review the value; hidden characters are shown as ⟨U+XXXX⟩.'),
  // v5 adapter and source metadata
  V5_PAYLOAD_MISSING: e('structural', 'required v5 data line not found', 'Select the v5 workspace HTML that holds the data.'),
  V5_PAYLOAD_AMBIGUOUS: e('structural', 'v5 data assignment appears more than once', 'Select an unmodified v5 workspace HTML.'),
  V5_PAYLOAD_NOT_JSON: e('structural', 'v5 data line is not pure JSON (refused, never evaluated)', 'Select an unmodified v5 workspace HTML.'),
  V5_PAYLOAD_ENCODED: e('structural', 'v5 data line is encoded or computed (refused, never evaluated)', 'Select a v5 workspace HTML with plain JSON data lines.'),
  V5_UNMAPPED_KEY: w('quality', 'source key has no mapping; preserved as an opaque dataset', 'Review the residual dataset; a later converter may map it.'),
  V5_SIZE_CLAIM_MISMATCH: w('quality', 'source size field differs from the original on disk', 'Review the source; the on-disk size is indexed.'),
  V5_META_COUNT_DISAGREEMENT: w('quality', 'source META count disagrees with the count derived from the records', 'Displayed counts come from the records; acknowledge the source discrepancy.'),
  DIAG_TRUNCATED: i('quality', 'more instances of a code than listed', 'See the counts; every instance is fingerprinted.'),
} as const satisfies Record<string, CodeDef>;

export type Code = keyof typeof CODES;

export interface Diagnostic {
  code: Code;
  severity: Severity;
  cls: DiagClass;
  /** package-relative file, e.g. datasets/chronology.json, or "input" for the converter's source */
  file?: string;
  /** RFC 6901 pointer inside the file */
  pointer?: string;
  /** short machine subject (ref, path, key); untrusted, rendered as text */
  subject?: string;
  message: string;
  hint: string;
  /** stable across rebuilds and record reordering */
  fingerprint: string;
  /** relative to the trusted baseline supplied by the caller; errors are always new */
  baseline: 'known' | 'new';
}
