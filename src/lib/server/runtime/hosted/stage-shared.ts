// What the one-request stager and the stepped stager share: the refusal shape, the stored-version head and its reads, and the selection
// of an asset's original from the case's finalized folder. Moved here unchanged so the two cannot drift.
import { canonicalText } from '../../../case-package/canonical.ts';
import { foldPath } from '../../../case-package/paths.ts';
import type { StageOutcome } from '../../../results-review/native/ports.ts';
import { originalKey } from '../../../storage/cloud/keys.ts';
import type { FolderOriginal } from '../../../storage/cloud/original-facts.ts';
import type { FileAssetClaim } from '../../../results/hosted/project.ts';
import { contractError } from '../errors.ts';
import type { FinalizedSubmissionSnapshot } from './alpha-contracts.ts';

export const unavailable = (): never => { throw contractError('storage-unavailable', true); };
export const integrity = (): never => { throw contractError('integrity'); };
export const refused = (reason: string, ...detail: string[]): Extract<StageOutcome, { kind: 'refused' }> => ({ kind: 'refused', reason, detail });
export const same = (a: unknown, b: unknown) => canonicalText(a) === canonicalText(b);
export const size = (n: number) => Number.isSafeInteger(n) && n >= 0;
export const VERSION_HEAD = 'SELECT * FROM rs_results_version WHERE version_id = ? AND case_id = ?';
export type FileRow = { path: string; sha256: string; size: number; object_key: string };
export type VersionRow = {
  case_id: string; state: string; manifest_sha256: string; input_revision_id: string; package_bytes: number;
  verdict: 'accept' | 'report'; validator_version: string; diagnostics_sha256: string; warning_fingerprints: string;
  read_model_sha256: string; expected_files: number; expected_documents: number; expected_assets: number; expected_seeds: number;
};
export type Selection = { asset: FileAssetClaim; original: FolderOriginal };
/** Which stored objects are case content another request put there, as opposed to this request's own package bytes. */
export type ContentKeys = (key: string) => boolean;
export const originals: ContentKeys = (key) => key.startsWith('orig/');
export const storedContent: ContentKeys = (key) => key.startsWith('orig/') || key.startsWith('pkg/');


/** PATH FIRST in the selected revision's real finalized folder; a fingerprint never chooses a path or a revision. */
export function select(assets: readonly FileAssetClaim[], folder: readonly FolderOriginal[], submission: FinalizedSubmissionSnapshot): { kind: 'selected'; selections: Selection[] } | Extract<StageOutcome, { kind: 'refused' }> {
  const mine = folder.filter((f) => f.source === 'submission' && f.revisionId === submission.manifest.revisionId);
  const selections: Selection[] = [];
  for (const asset of assets) {
    const literal = mine.filter((f) => f.path === asset.path);
    const found = literal.length ? literal : mine.filter((f) => foldPath(f.path) === foldPath(asset.path));
    if (found.length !== 1) return refused('original-link-required', 'selected revision has no unique finalized original at the indexed path');
    const f = found[0];
    const declared = submission.manifest.files.filter((d) => d.assetId === f.assetId && d.path === f.path && d.sha256 === f.sha256 && d.size === f.size);
    if (declared.length !== 1 || f.sha256 !== asset.sha256 || f.size !== asset.size || f.originalSize !== f.size || !size(f.size) || f.objectKey !== originalKey(f.sha256)) return refused('integrity', 'selected path does not have the exact submission and package fingerprint');
    selections.push({ asset, original: f });
  }
  return { kind: 'selected', selections };
}
