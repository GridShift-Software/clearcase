import Type, { type Static } from 'typebox';
import { LIMITS } from './limits.ts';
import { ASSET_KEY_PATTERN, REF_PATTERN } from './refs.ts';

export const FORMAT = 'clearcase.results-package';
/** Integer, must-understand. The only package version. */
export const FORMAT_VERSION = 1;
export const ENVELOPE = 'clearcase.dataset/1';
export const ASSET_INDEX = 'clearcase.assets/1';
export const ACKNOWLEDGEMENT = 'clearcase.acknowledgement/1';

export const SHA256_HEX = '^[0-9a-f]{64}$';
export const DIGEST = '^sha256:[0-9a-f]{64}$';
export const CASE_ID = '^[a-z0-9][a-z0-9._-]{0,63}$';
export const DATASET_KEY = '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$';
export const SCHEMA_ID = '^[a-z0-9][a-z0-9.-]{0,63}@[0-9]{1,3}$';

const Sha256 = Type.String({ pattern: SHA256_HEX });
const Digest = Type.String({ pattern: DIGEST });
const Size = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const Slug = Type.String({ pattern: CASE_ID });
const ShortText = Type.String({ maxLength: 200 });
const RelPath = Type.String({ minLength: 1, maxLength: 1024 });
const DatasetKey = Type.String({ pattern: DATASET_KEY, maxLength: 64 });
const DateTime = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})?$' });
const Kind = Type.Union([Type.Literal('generated'), Type.Literal('authored')]);

export const ManifestFile = Type.Object({
  path: RelPath,
  role: Type.Union([Type.Literal('dataset'), Type.Literal('assets'), Type.Literal('preview')]),
  key: Type.Optional(DatasetKey),
  kind: Type.Optional(Kind),
  schema: Type.Optional(Type.String({ pattern: SCHEMA_ID })),
  required: Type.Optional(Type.Boolean()),
  count: Type.Optional(Size),
  sha256: Sha256,
  size: Size,
}, { additionalProperties: false });
export type ManifestFile = Static<typeof ManifestFile>;

export const InputSource = Type.Object({ role: Slug, name: ShortText, sha256: Sha256, size: Size }, { additionalProperties: false });
export type InputSource = Static<typeof InputSource>;

export const Manifest = Type.Object({
  format: Type.Literal(FORMAT),
  formatVersion: Type.Literal(FORMAT_VERSION),
  case: Type.Object({ id: Slug, label: Type.Optional(ShortText) }, { additionalProperties: false }),
  inputRevision: Type.Object({
    id: Digest,
    /** e.g. v5-workspace-html, pipeline-run, markdown-roundtrip */
    kind: Slug,
    sources: Type.Array(InputSource, { minItems: 1, maxItems: 64 }),
    /** source-declared facts kept as provenance, never trusted for counts */
    claims: Type.Optional(Type.Record(Type.String({ pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$' }), Type.Union([ShortText, Type.Integer(), Type.Null()]), { additionalProperties: false })),
  }, { additionalProperties: false }),
  resultsVersion: Digest,
  /** resultsVersion this one was derived from (Markdown round trip, re-run), or null */
  parent: Type.Union([Digest, Type.Null()]),
  producer: Type.Object({ name: Slug, version: ShortText }, { additionalProperties: false }),
  /** deterministic: from the input (v5: META.builtAt), never the clock */
  created: DateTime,
  files: Type.Array(ManifestFile, { minItems: 1, maxItems: LIMITS.packageFiles - 1 }),
  extensions: Type.Optional(Type.Record(Type.String({ pattern: '^x-[a-z0-9][a-z0-9-]{0,62}$' }), Type.Unknown(), { additionalProperties: false })),
}, { additionalProperties: false });
export type Manifest = Static<typeof Manifest>;

export const Provenance = Type.Object({
  /** e.g. v5-workspace-html, pipeline, markdown-roundtrip */
  source: Slug,
  /** e.g. DATA.lit.recon */
  sourcePath: Type.String({ maxLength: 256 }),
  adapter: ShortText,
}, { additionalProperties: false });

export const DatasetEnvelope = Type.Object({
  envelope: Type.Literal(ENVELOPE),
  key: DatasetKey,
  kind: Kind,
  schema: Type.String({ pattern: SCHEMA_ID }),
  /** must-understand: a reader that does not know `schema` rejects the package */
  required: Type.Boolean(),
  count: Size,
  provenance: Provenance,
  data: Type.Unknown(),
}, { additionalProperties: false });
export type DatasetEnvelope = Static<typeof DatasetEnvelope>;

const MediaType = Type.String({ pattern: '^[a-z]+/[a-z0-9.+-]{1,100}$' });
const TextStatus = Type.Union([Type.Literal('extracted'), Type.Literal('ocr'), Type.Literal('none'), Type.Literal('pending'), Type.Literal('unsupported')]);
const Ref = Type.String({ pattern: REF_PATTERN, maxLength: 32 });

export const AssetFile = Type.Object({
  kind: Type.Literal('file'),
  path: RelPath,
  sha256: Sha256,
  size: Size,
  mediaType: MediaType,
  textStatus: TextStatus,
  /** PDF package file derived from this exact original. */
  preview: Type.Optional(Type.Object({ path: RelPath, sha256: Sha256, size: Size, originalSha256: Sha256 }, { additionalProperties: false })),
  /** an extracted attachment stored as its own file */
  parentRef: Type.Optional(Ref),
}, { additionalProperties: false });
export const AssetEmbedded = Type.Object({
  /** attachment still inside its parent container */
  kind: Type.Literal('embedded'),
  parentRef: Ref,
  ordinal: Type.Integer({ minimum: 1, maximum: 9999 }),
  /** untrusted display text, never a path */
  member: Type.String({ minLength: 1, maxLength: 1024 }),
  mediaType: MediaType,
  textStatus: TextStatus,
  sha256: Type.Optional(Sha256),
  size: Type.Optional(Size),
}, { additionalProperties: false });
export const AssetMissing = Type.Object({
  /** the converter found no original: no fingerprint, never resolved by path alone */
  kind: Type.Literal('missing'),
  path: RelPath,
  mediaType: MediaType,
  textStatus: TextStatus,
  parentRef: Type.Optional(Ref),
}, { additionalProperties: false });
export const Asset = Type.Union([AssetFile, AssetEmbedded, AssetMissing]);
export type Asset = Static<typeof Asset>;
export type FileAsset = Static<typeof AssetFile>;

export const AssetIndex = Type.Object({
  index: Type.Literal(ASSET_INDEX),
  root: Type.Literal('case-folder'),
  assets: Type.Record(Type.String({ pattern: ASSET_KEY_PATTERN }), Asset, { additionalProperties: false }),
}, { additionalProperties: false });
export type AssetIndex = Static<typeof AssetIndex>;

const Fingerprint = Type.String({ pattern: '^[0-9a-f]{32}$' });

/** Operator acknowledgement of a fresh import result's warnings. Stale if any bound field differs. */
export const Acknowledgement = Type.Object({
  acknowledgement: Type.Literal(ACKNOWLEDGEMENT),
  resultsVersion: Digest,
  manifestSha256: Sha256,
  diagnosticsSha256: Digest,
  validatorVersion: ShortText,
  warningFingerprints: Type.Array(Fingerprint, { maxItems: 10_000_000 }),
  acknowledgedBy: Type.Optional(ShortText),
  at: Type.Optional(DateTime),
}, { additionalProperties: false });
export type Acknowledgement = Static<typeof Acknowledgement>;
