import { assetPolicyItems, missingAssetDiagnostic, type AssetPolicyInput } from '../../../src/lib/publication/hosted/asset-policy.ts';
import type { EvidenceProducer } from '../../../src/lib/publication/hosted/evidence/index.ts';
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
export function runItems(inputs: readonly AssetPolicyInput[], binding = BOUND): Item[] {
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
export async function assetWorld(inputs: readonly AssetPolicyInput[], binding = BOUND): Promise<World & { items: Item[] }> {
  const items = runItems(inputs, binding);
  const w = await world({ spec: { previews: 0, warnings: 0 }, baseline: 0, producer: producerOf(items) });
  return Object.assign(w, { items });
}
/** The warnings the case's baseline does not hold, read back from the sealed rows. */
export const freshOf = (w: World): string[] => w.db.rows<{ f: string }>(`SELECT json_extract(item_json, '$.observation.fingerprint') AS f FROM pub_evidence_item
  WHERE item_key >= 'warning/' AND item_key < 'warning0' AND json_extract(item_json, '$.observation.fingerprint') NOT IN (SELECT fingerprint FROM rs_trusted_fingerprint WHERE case_id = ?) ORDER BY item_key`, CASE).map((r) => r.f);
