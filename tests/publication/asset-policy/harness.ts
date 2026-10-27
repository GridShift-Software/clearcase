import { assetPolicyItems, missingAssetDiagnostic, type AssetBinding, type AssetPolicyInput } from '../../../src/lib/publication/hosted/asset-policy.ts';
import type { EvidenceProducer } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { createEvidenceEngine, d1EvidenceStore } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { d1EvidenceReader } from '../../../src/lib/publication/hosted/readiness-evidence.ts';
import { d1, database } from '../evidence/harness.ts';
import { snapshot } from '../../hosted-smoke/operator-workbench/fixtures.ts';
import { binding as readinessBinding, type Built } from '../readiness-v2/harness.ts';
import { CASE, RV, hash, world, type World } from '../signoff-root/harness.ts';

// Synthetic only. The four cases of the U10 acceptance, as the evidence asset step receives them, and a candidate whose sealed run
// holds exactly the step's items beside a valid set of sections and the validator's own warning for every missing original.
export const BOUND = { resultsVersion: RV, manifestSha256: hash('1'), validatorVersion: 'validator-1', diagnosticsSha256: hash('d') };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const base = { cited: false, supplied: false, preview: false, render: null } as const;
export const UNCITED_MISSING: AssetPolicyInput = { ...base, assetId: 'SY-0001', kind: 'missing', mediaType: 'application/pdf' };
export const CITED_MISSING: AssetPolicyInput = { ...base, assetId: 'SY-0002', kind: 'missing', mediaType: 'application/pdf', cited: true };
export const EMBEDDED: AssetPolicyInput = { ...base, assetId: 'SY-0003.a1', kind: 'embedded', mediaType: 'application/pdf', cited: true };
export const DOCX_NO_PREVIEW: AssetPolicyInput = { ...base, assetId: 'SY-0004', kind: 'file', mediaType: DOCX, supplied: true, cited: true };
export const PDF_RENDERED: AssetPolicyInput = { ...base, assetId: 'SY-0005', kind: 'file', mediaType: 'application/pdf', supplied: true, render: { state: 'rendered' } };
export const DOCX_WITH_PREVIEW: AssetPolicyInput = { ...base, assetId: 'SY-0006', kind: 'file', mediaType: DOCX, supplied: true, preview: true, render: { state: 'rendered' } };

export type Item = { key: string; observation: Record<string, unknown> };
const byKey = (a: Item, b: Item) => (a.key < b.key ? -1 : 1);
const warnedOf = (inputs: readonly AssetPolicyInput[]) => inputs.filter((i) => i.kind === 'missing').map((i) => missingAssetDiagnostic(i.assetId));

/** Every item of a run for these assets: the step's items, the validator's warning for each missing original, and valid sections. */
export function runItems(inputs: readonly AssetPolicyInput[], binding: AssetBinding = BOUND): Item[] {
  const warned = warnedOf(inputs);
  return [
    ...assetPolicyItems(inputs, { binding, warningFingerprints: warned }) as Item[],
    ...warned.map((f) => ({ key: `warning/${f}`, observation: { kind: 'warning', fingerprint: f } })),
    ...['matter', 'meta', 'quantum'].map((key) => ({ key: `section/${key}`, observation: { kind: 'section', key, state: key === 'meta' ? 'integrity-verified' : 'valid' } })),
  ].sort(byKey);
}
export const producerOf = (items: readonly Item[]): EvidenceProducer => async (cursor) => {
  const n = cursor === null ? 0 : Number(cursor), item = items[n];
  return item ? { done: false, nextCursor: String(n + 1), key: item.key, observation: item.observation } : { done: true };
};
export async function assetWorld(inputs: readonly AssetPolicyInput[], binding: AssetBinding = BOUND): Promise<World & { items: Item[] }> {
  const items = runItems(inputs, binding);
  const w = await world({ spec: { previews: 0, warnings: 0 }, baseline: 0, producer: producerOf(items) });
  return Object.assign(w, { items });
}
/** The warnings the case's baseline does not hold, read back from the sealed rows. */
export const freshOf = (w: World): string[] => w.db.rows<{ f: string }>(`SELECT json_extract(item_json, '$.observation.fingerprint') AS f FROM pub_evidence_item
  WHERE item_key >= 'warning/' AND item_key < 'warning0' AND json_extract(item_json, '$.observation.fingerprint') NOT IN (SELECT fingerprint FROM rs_trusted_fingerprint WHERE case_id = ?) ORDER BY item_key`, CASE).map((r) => r.f);

// Readiness reads the same run through U4's real reader. `Built` is what the readiness harness takes from `buildEvidence`; this builds one over
// these assets' items instead of the generic ones, by the same real engine into the same real tables.
// The readiness snapshot is the operator-workbench fixture's, so its policy fingerprints are bound to that candidate and validation.
const fixture = snapshot();
export const FIXTURE_BOUND: AssetBinding = { resultsVersion: fixture.link.candidate.resultsVersion, manifestSha256: fixture.link.candidate.manifestSha256, validatorVersion: fixture.validation.validatorVersion,
  diagnosticsSha256: fixture.validation.diagnosticsSha256 };
/** `edit` changes the run's items before they are sealed, for a run the asset step would never write. */
export async function buildAssetEvidence(inputs: readonly AssetPolicyInput[], binding: AssetBinding = FIXTURE_BOUND, edit: (items: Item[]) => Item[] = (items) => items) {
  const items = edit(runItems(inputs, binding));
  const db = database(); db.exec('PRAGMA foreign_keys=OFF');
  const adapter = d1(db), b = readinessBinding;
  let now = 0, root: string | null = null;
  const engine = createEvidenceEngine({ binding: b, store: d1EvidenceStore(adapter), producer: producerOf(items), clock: () => now, leaseId: 'builder', leaseMs: 1_000_000, bounds: { itemsPerStep: 500, bytesPerStep: 1024 * 1024 } });
  for (let step = 0; step < 100 && root === null; step++, now++) { const r = await engine.step(); if (r.kind === 'complete') root = r.root; else if (r.kind !== 'progress') throw new Error(r.kind); }
  if (!root) throw new Error('evidence did not complete');
  return { db, adapter, items, root, binding: b, reader: d1EvidenceReader(adapter) } as unknown as Built;
}
