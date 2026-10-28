export const SHARD_MANIFEST_FORMAT = 'clearcase.shard-manifest/1';

/** One shard file, by its name under the version's prefix. */
export interface ShardEntry {
	name: string;
	bytes: number;
	sha256: string;
}

/** `manifest.json`: what was built, from which package and by which builder; D1 records its hash at publication. */
export interface PayloadManifest {
	format: typeof SHARD_MANIFEST_FORMAT;
	caseId: string;
	resultsVersion: string;
	manifestSha256: string;
	readModelSha256: string;
	validatorVersion: string;
	diagnosticsSha256: string;
	warningFingerprints: string[];
	counts: { documents: number; assets: number; seeds: number; files: number; listPages: number };
	builtAt: string;
	builder: { sha: string; bun: string };
	shards: ShardEntry[];
}
