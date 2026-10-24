import { contractError } from '../../server/runtime/errors.ts';
import type { CloudD1 } from '../../storage/cloud/bindings.ts';
import { readModelDigest, type StagedAsset } from './read-model.ts';
import { unavailable } from './versions.ts';

export type DocRow = { ref: string; ord: number; row_json: string; state_json: string; list_json: string; attachments_json: string };
export type SeedRow = { ord: number; dataset_key: string; seed_id: string; seed_sha256: string; record_json: string };
export interface LoadedModel { docs: readonly DocRow[]; seeds: readonly SeedRow[] }

/**
 * One stored version's read model, read from D1 and checked against the version's own record before anything is served:
 * the row counts are the counts it was stored with, and the rows hash to its `read_model_sha256`. A row changed, added or
 * dropped in D1 after the version was stored fails with `integrity`. This catches a changed row; a changed row together
 * with a rewritten digest is caught by `verifyVersion`, which derives the model again from the version's package bytes.
 */
export async function loadVerifiedModel(db: CloudD1, rv: string): Promise<LoadedModel> {
  const version = await db.prepare('SELECT read_model_sha256, overview, expected_documents, expected_assets, expected_seeds, expected_files FROM rs_results_version WHERE version_id = ?').bind(rv)
    .first<{ read_model_sha256: string; overview: string; expected_documents: number; expected_assets: number; expected_seeds: number; expected_files: number }>().catch(unavailable);
  if (!version) throw contractError('integrity');
  const [docs, assets, seeds] = await Promise.all([
    db.prepare('SELECT ref, ord, row_json, state_json, list_json, attachments_json FROM rs_document WHERE version_id = ? ORDER BY ord').bind(rv).all<DocRow>(),
    db.prepare('SELECT row_json FROM rs_asset WHERE version_id = ? ORDER BY asset_key').bind(rv).all<{ row_json: string }>(),
    db.prepare('SELECT ord, dataset_key, seed_id, seed_sha256, record_json FROM rs_seed WHERE version_id = ? ORDER BY ord').bind(rv).all<SeedRow>(),
  ]).catch(unavailable);
  if (docs.results.length !== version.expected_documents || assets.results.length !== version.expected_assets || seeds.results.length !== version.expected_seeds) throw contractError('integrity');
  let digest: string;
  try {
    digest = await readModelDigest({
      documents: docs.results, seeds: seeds.results, overview: version.overview,
      assets: assets.results.map((r) => JSON.parse(r.row_json) as StagedAsset),
      chronologyJson: JSON.stringify(docs.results.map((d) => JSON.parse(d.list_json))),
      expect: { documents: version.expected_documents, assets: version.expected_assets, seeds: version.expected_seeds, files: version.expected_files },
    });
  } catch { throw contractError('integrity'); }
  if (digest !== version.read_model_sha256) throw contractError('integrity');
  return { docs: docs.results, seeds: seeds.results };
}
