// Resumable, lease-claimed, bounded evidence build (real-export design 2). Hosted-safe: Web Crypto is not even needed; the
// digests are an incremental pure-TypeScript SHA-256, and nothing here imports a Node built-in.
export { createEvidenceEngine, type EvidenceEngine, type EvidenceEngineOptions } from './engine.ts';
export { d1EvidenceStore, type EvidenceD1 } from './d1-store.ts';
export { canonicalJson, pageBytes, rootBytes, rowText, KEY_PATTERN, PAGE_SIZE, PAGE_TAG, ROOT_TAG, type EvidenceRow } from './canonical.ts';
export { Sha256, sha256Hex, type Sha256Snapshot } from './sha256.ts';
export { DEFAULT_EVIDENCE_BOUNDS, MAX_BYTES_PER_STEP, MAX_ITEMS_PER_STEP } from './types.ts';
export type * from './types.ts';
