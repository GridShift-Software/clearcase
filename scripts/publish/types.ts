// The shard builder's contracts. A shard family is one module under ./shards/ whose default export is a ShardModule;
// build.ts finds it by listing the directory, so a later ticket adds a file and edits nothing else.
import type { ViewContentReader } from '../../src/lib/case-package/view-content.ts';
import type { CaseStore } from '../../src/lib/local-case/store.server.ts';
import type { PureInput } from '../../src/lib/views/payloads/views.ts';

export interface Shard { name: string; bytes: Uint8Array }

/** What every shard family reads: the version imported into a throwaway local store, and its view content. */
export interface BuildContext {
  caseId: string;
  resultsVersion: string;
  store: CaseStore;
  vc: ViewContentReader;
  /** The input of the pure loader halves (src/lib/views/payloads/views.ts). */
  pure: PureInput;
  /** The value as a shard: JSON text, UTF-8. */
  json(name: string, value: unknown): Shard;
}

export interface ShardModule {
  /** The family: `shell`, `list`, `views-analysis`. `build --family <name>` builds this module alone, as an amendment. */
  name: string;
  build(ctx: BuildContext): Promise<Shard[]>;
}

/**
 * One shard family added to an already-published version (`amendments/<sha256>.json` beside its shards): canonical JSON,
 * identified by its own sha256, bound to the case, the version and the signed manifest.json it extends. It only adds
 * names; a name the version already serves is refused.
 */
export interface ShardAmendment {
  format: 'clearcase.shard-amendment/1';
  caseId: string;
  resultsVersion: string;
  /** The hex sha256 of the version's signed manifest.json. */
  parentManifestSha256: string;
  family: string;
  shards: { name: string; bytes: number; sha256: string }[];
}

/** The local-only record `build` leaves beside the shards for register, signoff and publish. Holds case content: `.local/` only. */
export interface BuildRecord {
  format: 'clearcase.publish-build/1';
  caseId: string;
  resultsVersion: string;
  shardManifestSha256: string;
  builtAt: string;
  version: {
    caseLabel: string | null; inputRevisionId: string; created: string; verdict: 'accept' | 'report'; manifestSha256: string; validatorVersion: string;
    diagnosticsSha256: string; warningFingerprints: string[]; expect: { documents: number; assets: number; seeds: number; files: number };
    readModelSha256: string; overview: string; packageBytes: number;
  };
  /** The import's diagnostic counts by code: `register` refuses missing originals, a sign-off acknowledges every warning code. */
  diagnostics: Record<string, number>;
  rows: {
    documents: { ref: string; ord: number; row_json: string; state_json: string; list_json: string; attachments_json: string }[];
    assets: { key: string; row_json: string }[];
    seeds: { ord: number; dataset_key: string; seed_id: string; seed_sha256: string; record_json: string }[];
  };
}
