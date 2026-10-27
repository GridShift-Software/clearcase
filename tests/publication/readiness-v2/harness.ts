import { createEvidenceEngine, type EvidenceBinding, type EvidenceProducer } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { d1EvidenceReader } from '../../../src/lib/publication/hosted/readiness-evidence.ts';
import type { CandidateSnapshotV2, EvidenceCountGroup } from '../../../src/lib/publication/hosted/ports.ts';
import type { PublicationReadinessPorts } from '../../../src/lib/publication/hosted/readiness.ts';
import type { ReadinessFence } from '../../../src/lib/publication/hosted/readiness-fence.ts';
import { canonicalJson } from '../../../src/lib/case-package/canonical.ts';
import { d1, database } from '../evidence/harness.ts';
import { CASE, CLIENT, RV, SHA, snapshot, world } from '../../hosted-smoke/operator-workbench/fixtures.ts';
import { d1EvidenceStore } from '../../../src/lib/publication/hosted/evidence/index.ts';

// Synthetic only. The evidence is written by U3's real engine into the real evidence tables; readiness reads it back.
export const PREVIEWS = 1689, WARNINGS = 2500, BASELINE = 100;
export const fp = (n: number) => n.toString(16).padStart(32, '0');
export const sectionKeys = ['matter', 'meta', 'quantum'];

export interface Spec { previews?: number; warnings?: number; errors?: number; failedPreviews?: number; pendingPreviews?: number; sections?: { key: string; state: string }[] }
/** Every key the spec produces, in the ASCII order a build must produce them. */
export function observations(spec: Spec = {}) {
  const previews = spec.previews ?? PREVIEWS, warnings = spec.warnings ?? WARNINGS, errors = spec.errors ?? 0;
  const failed = spec.failedPreviews ?? 0, pending = spec.pendingPreviews ?? 0;
  const sections = spec.sections ?? sectionKeys.map(key => ({ key, state: key === 'meta' ? 'integrity-verified' : 'valid' }));
  const out: { key: string; observation: Record<string, unknown> }[] = [];
  for (let n = 0; n < errors; n++) out.push({ key: `error/${fp(n)}`, observation: { kind: 'error', fingerprint: fp(n) } });
  for (let n = 0; n < previews; n++) {
    const assetId = `asset-${String(n).padStart(5, '0')}`;
    out.push({ key: `preview/${assetId}`, observation: n < failed ? { kind: 'preview', assetId, state: 'failed', reasonCode: 'render-timeout', stage: 'navigation' }
      : n < failed + pending ? { kind: 'preview', assetId, state: 'pending' } : { kind: 'preview', assetId, state: 'rendered' } });
  }
  for (const s of [...sections].sort((a, b) => a.key < b.key ? -1 : 1)) out.push({ key: `section/${s.key}`, observation: { kind: 'section', key: s.key, state: s.state } });
  for (let n = 0; n < warnings; n++) out.push({ key: `warning/${fp(n)}`, observation: { kind: 'warning', fingerprint: fp(n) } });
  return out;
}
export const binding: EvidenceBinding = { candidateId: 'cand-synthetic', generation: '1', clientId: CLIENT, caseId: CASE, resultsVersion: RV, manifestSha256: SHA,
  validatorVersion: 'synthetic-validator/1', rendererVersion: 'renderer/1' };

function producerOf(items: ReturnType<typeof observations>): EvidenceProducer {
  return async cursor => {
    const n = cursor === null ? 0 : Number(cursor);
    const item = items[n];
    return item ? { done: false, nextCursor: String(n + 1), key: item.key, observation: item.observation } : { done: true };
  };
}
export async function buildEvidence(spec: Spec = {}, overrides: Partial<EvidenceBinding> = {}) {
  const db = database(); db.exec('PRAGMA foreign_keys=OFF');
  const adapter = d1(db), b = { ...binding, ...overrides }, items = observations(spec);
  let now = 0;
  const engine = createEvidenceEngine({ binding: b, store: d1EvidenceStore(adapter), producer: producerOf(items), clock: () => now, leaseId: 'builder', leaseMs: 1_000_000,
    bounds: { itemsPerStep: 500, bytesPerStep: 1024 * 1024 } });
  let root: string | null = null;
  for (let step = 0; step < 100 && root === null; step++) { const r = await engine.step(); if (r.kind === 'complete') root = r.root; else if (r.kind !== 'progress') throw new Error(r.kind); now++; }
  if (!root) throw new Error('evidence did not complete');
  for (let n = 0; n < BASELINE; n++) db.prepare('INSERT INTO rs_trusted_fingerprint (case_id, fingerprint) VALUES (?, ?)').run(CASE, fp(n));
  return { db, adapter, items, root, binding: b, reader: d1EvidenceReader(adapter) };
}
export type Built = Awaited<ReturnType<typeof buildEvidence>>;

/** The expected aggregates, computed from the spec alone and never from the reader under test. */
export function expectedGroups(items: ReturnType<typeof observations>): EvidenceCountGroup[] {
  const map = new Map<string, EvidenceCountGroup>();
  for (const { observation: o } of items) {
    const group = { kind: o.kind as EvidenceCountGroup['kind'], subject: o.kind === 'section' ? o.key as string : null, state: (o.state as string | undefined) ?? null, reason: (o.reasonCode as string | undefined) ?? null, count: 1 };
    const k = canonicalJson({ ...group, count: 0 });
    map.set(k, { ...group, count: (map.get(k)?.count ?? 0) + 1 });
  }
  return [...map.values()];
}

export async function snapshotV2(built: Built): Promise<CandidateSnapshotV2> {
  const summary = await built.reader.summary({ clientId: CLIENT, caseId: CASE, candidateId: built.binding.candidateId, generation: built.binding.generation });
  if (!summary) throw new Error('no summary');
  const v1 = snapshot();
  return { format: 'clearcase.candidate-snapshot/2', link: v1.link, preparedBy: v1.preparedBy, snapshotRevision: v1.snapshotRevision,
    validation: { verdict: 'report', validatorVersion: v1.validation.validatorVersion, diagnosticsSha256: v1.validation.diagnosticsSha256 },
    evidence: { generation: built.binding.generation, root: summary.root, items: summary.items, groups: summary.groups, newWarnings: summary.newWarnings } };
}
/** Synthetic fence for unit ports (the D1 fence for v2 is not part of U4): compares the observation to the live one, as syntheticFence does for v1. */
export function evidenceFence(current: () => CandidateSnapshotV2): ReadinessFence {
  return { protocol: 'coherent-readiness/1', evidence: 'coherent-evidence/1',
    async check(o) { return canonicalJson(current()) === canonicalJson(o.snapshot) ? 'current' : 'stale'; } };
}
export function worldV2(built: Built, options: { pageSize?: number; snapshot?: CandidateSnapshotV2 } = {}) {
  const w = world();
  let current = options.snapshot;
  let reads = 0;
  const load = async () => (current ??= await snapshotV2(built));
  const ports: PublicationReadinessPorts = { ...w.ports, candidates: { read: async () => { reads++; return structuredClone(await load()); } },
    readinessFence: evidenceFence(() => current!), evidence: built.reader, evidencePageSize: options.pageSize ?? 100 };
  const request = (params: Record<string, string> = {}) => {
    const r = w.request();
    for (const [k, v] of Object.entries(params)) r.url.searchParams.set(k, v);
    return { ...r, request: new Request(r.url) };
  };
  return { w, ports, request, get reads() { return reads; }, set current(s: CandidateSnapshotV2) { current = s; }, get current() { return current!; } };
}
