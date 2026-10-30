import { describe, expect, it } from 'vitest';
import { createEvidenceEngine, d1EvidenceStore, type EvidenceBinding, type EvidenceProducer } from '../../../src/lib/publication/hosted/evidence/index.ts';
import { d1EvidenceReader } from '../../../src/lib/publication/hosted/readiness-evidence.ts';
import { checkEvidenceItem, checkSnapshotV2, metaDisagreementsOf, signoffBlockerV2, type AcknowledgementGroup, type CheckedEvidenceItem } from '../../../src/lib/publication/hosted/rules.ts';
import type { CandidateSnapshotV2, EvidenceItemRow } from '../../../src/lib/publication/hosted/ports.ts';
import { META_DISAGREEMENT_CODE, metaEvidenceItems, metaReconciles, metaSectionV2, type MetaBinding, type MetaSectionV2 } from '../../../src/lib/case-package/meta-integrity.ts';
import { d1, database } from '../evidence/harness.ts';
import { CASE, CLIENT, RV, SHA, snapshot } from '../../hosted-smoke/operator-workbench/fixtures.ts';
import { bothDiagnostics, diagnosticFingerprint, disagreeingMeta, groupDiagnosticFingerprint, pocDatasets } from './poc.ts';

// The acceptance for unit U12 (META `disagrees`, ADR-0014 Proposed). Synthetic poc-profile data: 1,689 documents whose META carries
// textNone 237 against 255 and emails 469 against 629. The gate derives the disagreements itself from the records, persists the
// derivation as evidence items through U3's real engine into the real tables, and reads them back through U4's real reader.

const v1 = snapshot();
const BINDING: MetaBinding = { resultsVersion: v1.link.candidate.resultsVersion, manifestSha256: v1.link.candidate.manifestSha256, validatorVersion: v1.validation.validatorVersion, diagnosticsSha256: v1.validation.diagnosticsSha256 };
const evidenceBinding: EvidenceBinding = { candidateId: 'cand-synthetic', generation: '1', clientId: CLIENT, caseId: CASE, resultsVersion: RV, manifestSha256: v1.link.candidate.manifestSha256,
  validatorVersion: BINDING.validatorVersion, rendererVersion: 'renderer/1' };
const REASON = 'Legacy v5 export: META is a source summary and the records are authoritative.';
const ack = (fingerprints: readonly string[], reason = REASON, code = META_DISAGREEMENT_CODE): AcknowledgementGroup => ({ code, reason, fingerprints });

const derive = (meta: Record<string, unknown> = disagreeingMeta, o: { binding?: MetaBinding; diagnostics?: string[]; diagnosticCount?: number; people?: unknown } = {}): MetaSectionV2 =>
  metaSectionV2(pocDatasets({ meta, people: o.people }), { binding: o.binding ?? BINDING, warningFingerprints: o.diagnostics ?? bothDiagnostics(), diagnostics: o.diagnosticCount ?? (o.diagnostics ?? bothDiagnostics()).length });
const disagreements = (s: MetaSectionV2) => { if (s.state !== 'disagrees') throw new Error(`state ${s.state}`); return s.disagreements; };

/** The derivation as a D1 evidence run beside ordinary items (as a later unit's composer would merge them), read back through the real reader. */
async function roundTrip(section: MetaSectionV2, o: { itemsPerStep?: number } = {}) {
  const items = [
    { key: 'preview/asset-1', observation: { kind: 'preview', assetId: 'asset-1', state: 'rendered' } },
    { key: 'section/chronology', observation: { kind: 'section', key: 'chronology', state: 'valid' } },
    ...bothDiagnostics().map((f) => ({ key: `warning/${f}`, observation: { kind: 'warning', fingerprint: f } })),
    { key: `warning/${'1'.repeat(32)}`, observation: { kind: 'warning', fingerprint: '1'.repeat(32) } },
    ...metaEvidenceItems(section),
  ].sort((a, b) => (a.key < b.key ? -1 : 1));
  const producer: EvidenceProducer = async (cursor) => { const n = cursor === null ? 0 : Number(cursor); const i = items[n]; return i ? { done: false, nextCursor: String(n + 1), key: i.key, observation: i.observation } : { done: true }; };
  const db = database(); db.exec('PRAGMA foreign_keys=OFF');
  const adapter = d1(db);
  let now = 0, root: string | null = null;
  const engine = createEvidenceEngine({ binding: evidenceBinding, store: d1EvidenceStore(adapter), producer, clock: () => now, leaseId: 'builder', leaseMs: 1_000_000, bounds: { itemsPerStep: o.itemsPerStep ?? 500, bytesPerStep: 1024 * 1024 } });
  for (let step = 0; step < 200 && root === null; step++, now++) { const r = await engine.step(); if (r.kind === 'complete') root = r.root; else if (r.kind !== 'progress') throw new Error(r.kind); }
  if (!root) throw new Error('evidence did not complete');
  const reader = d1EvidenceReader(adapter), where = { clientId: CLIENT, caseId: CASE, candidateId: evidenceBinding.candidateId, generation: evidenceBinding.generation };
  const summary = (await reader.summary(where))!;
  const s: CandidateSnapshotV2 = { format: 'clearcase.candidate-snapshot/2', link: v1.link, preparedBy: v1.preparedBy, snapshotRevision: v1.snapshotRevision,
    validation: { verdict: 'report', validatorVersion: BINDING.validatorVersion, diagnosticsSha256: BINDING.diagnosticsSha256 },
    evidence: { generation: '1', root: summary.root, items: summary.items, groups: summary.groups, newWarnings: summary.newWarnings } };
  const snap = checkSnapshotV2(s)!;
  const checked: CheckedEvidenceItem[] = [];
  for (let after: string | null = null; ;) {
    const page: readonly EvidenceItemRow[] = (await reader.page({ ...where, root: summary.root, after, kind: 'warning', limit: 3 }))!;
    for (const row of page) checked.push(checkEvidenceItem(row, { clientId: CLIENT, caseId: CASE, resultsVersion: RV, manifestSha256: evidenceBinding.manifestSha256 })!);
    if (page.length < 3) break;
    after = page.at(-1)!.key;
  }
  return { snap, checked, root: summary.root, evidence: metaDisagreementsOf(checked) };
}

describe('META disagrees: the decisive test', () => {
  it('derives exactly the two sample disagreements from the records, and the v1 gate still calls the same META invalid', async () => {
    const section = derive();
    expect(section.state).toBe('disagrees');
    expect(disagreements(section).map((d) => [d.subject, d.carried, d.derived]).sort()).toEqual([['META.emails', 469, 629], ['META.textNone', 237, 255]]);
    expect(disagreements(section).map((d) => d.diagnostic).sort()).toEqual(bothDiagnostics().sort());
    expect(metaReconciles(pocDatasets({ meta: disagreeingMeta }))).toBe(false);
    const run = await roundTrip(section);
    expect(run.evidence.map((d) => d.subject).sort()).toEqual(['META.emails', 'META.textNone']);
    expect(run.snap.evidence.groups.find((g) => g.kind === 'section' && g.subject === 'meta')?.state).toBe('disagrees');
  });

  it('clears only when exactly those fingerprints are acknowledged, with a reason per group', async () => {
    const { snap, evidence } = await roundTrip(derive());
    const [one, two] = evidence.map((d) => d.fingerprint);
    const blocker = (groups: AcknowledgementGroup[]) => signoffBlockerV2(snap, { disagreements: evidence, acknowledgements: groups });
    const held = { code: 'required-section', detail: ['meta:disagrees'] };
    expect(blocker([ack([one!, two!])])).toBeNull();
    expect(blocker([ack([one!]), ack([two!], 'A second reason for the e-mail count.')])).toBeNull();
    expect(blocker([])).toEqual(held);
    expect(signoffBlockerV2(snap)).toEqual(held);
    expect(blocker([ack([one!])])).toEqual(held);
    expect(blocker([ack([one!, two!], '')])).toEqual(held);
    expect(blocker([ack([one!, two!], '   ')])).toEqual(held);
    expect(blocker([ack([one!]), ack([two!], '')])).toEqual(held);
    expect(blocker([ack([one!, two!, 'f'.repeat(32)])])).toEqual(held);
    expect(blocker([ack([one!, two!]), ack([one!], 'Again.')])).toEqual(held);
    expect(blocker([ack([one!, two!], REASON, 'DS_DATE_INVALID')])).toEqual(held);
  });

  it('keeps it held when an acknowledgement no longer matches: a changed value, candidate or validation gives a new fingerprint', async () => {
    const before = disagreements(derive()), old = before.map((d) => d.fingerprint);
    const current = await roundTrip(derive());
    expect(signoffBlockerV2(current.snap, { disagreements: current.evidence, acknowledgements: [ack(old)] })).toBeNull();

    const changed = derive({ ...disagreeingMeta, emails: 470 }), now = disagreements(changed);
    const byField = (list: readonly { subject: string; fingerprint: string }[], s: string) => list.find((d) => d.subject === s)!.fingerprint;
    expect(byField(now, 'META.emails')).not.toBe(byField(before, 'META.emails'));
    expect(byField(now, 'META.textNone')).toBe(byField(before, 'META.textNone'));
    const afterChange = await roundTrip(changed);
    expect(signoffBlockerV2(afterChange.snap, { disagreements: afterChange.evidence, acknowledgements: [ack(old)] })).toEqual({ code: 'required-section', detail: ['meta:disagrees'] });

    for (const other of [{ ...BINDING, manifestSha256: 'd'.repeat(64) }, { ...BINDING, resultsVersion: `sha256:${'e'.repeat(64)}` }, { ...BINDING, diagnosticsSha256: 'f'.repeat(64) }, { ...BINDING, validatorVersion: 'synthetic-validator/2' }]) {
      const rebound = disagreements(derive(disagreeingMeta, { binding: other }));
      expect(rebound.map((d) => d.fingerprint).filter((f) => old.includes(f))).toEqual([]);
    }
  });

  it('holds when stored evidence was derived for another candidate or validation, even though its acknowledgement matches it', async () => {
    const stale = derive(disagreeingMeta, { binding: { ...BINDING, diagnosticsSha256: 'f'.repeat(64) } });
    const run = await roundTrip(stale);
    const acked = run.evidence.map((d) => d.fingerprint);
    expect(signoffBlockerV2(run.snap, { disagreements: run.evidence, acknowledgements: [ack(acked)] })).toEqual({ code: 'required-section', detail: ['meta:disagrees'] });
  });

  it('never clears a disagrees section on an empty or missing derivation, or on a section that is not META', async () => {
    const { snap } = await roundTrip(derive());
    expect(signoffBlockerV2(snap, { disagreements: [], acknowledgements: [ack([])] })).toEqual({ code: 'required-section', detail: ['meta:disagrees'] });
    const other = checkSnapshotV2({ ...snap, evidence: { ...snap.evidence, groups: snap.evidence.groups.map((g) => (g.kind === 'section' && g.subject === 'meta' ? { ...g, subject: 'quantum' } : g)) } })!;
    const { evidence } = await roundTrip(derive());
    expect(signoffBlockerV2(other, { disagreements: evidence, acknowledgements: [ack(evidence.map((d) => d.fingerprint))] })).toEqual({ code: 'required-section', detail: ['quantum:disagrees'] });
  });
});

describe('what stays invalid', () => {
  it('derives integrity-verified when the records agree with META and no diagnostic remains', () => {
    expect(derive({}, { diagnostics: [], diagnosticCount: 0 }).state).toBe('integrity-verified');
  });
  it('holds a diagnostic the records do not explain', () => {
    expect(derive({}, { diagnostics: [diagnosticFingerprint('textNone')], diagnosticCount: 1 }).state).toBe('invalid');
  });
  it('holds a disagreement with no matching diagnostic, whatever the diagnostic count says', () => {
    expect(derive(disagreeingMeta, { diagnostics: [diagnosticFingerprint('textNone')], diagnosticCount: 2 }).state).toBe('invalid');
    expect(derive(disagreeingMeta, { diagnostics: [diagnosticFingerprint('textNone'), 'a'.repeat(32)], diagnosticCount: 2 }).state).toBe('invalid');
    expect(derive(disagreeingMeta, { diagnostics: [], diagnosticCount: 0 }).state).toBe('invalid');
  });
  it('holds more diagnostics than the records explain', () => {
    expect(derive(disagreeingMeta, { diagnostics: [...bothDiagnostics(), 'a'.repeat(32)], diagnosticCount: 3 }).state).toBe('invalid');
  });
  it('holds a people count that cannot be verified', () => {
    expect(derive({ ...disagreeingMeta }, { people: { count: 80 } }).state).toBe('invalid');
    expect(derive({ ...disagreeingMeta, people: 79 }).state).toBe('invalid');
  });
  const metaData = () => structuredClone(pocDatasets().at(-1)!.data) as Record<string, unknown> & { bundles: Record<string, number>; docTypes: Record<string, number> };
  it.each([
    ['a missing total', (m: Record<string, unknown>) => { delete m.docCount; }],
    ['a total that is not a number', (m: Record<string, unknown>) => { m.invoices = '41'; }],
    ['a tally that is not an object', (m: Record<string, unknown>) => { m.bundles = 3; }],
    ['a tally value that is not a number', (m: Record<string, unknown>) => { (m.docTypes as Record<string, unknown>).email = 'many'; }],
  ])('holds %s', (_what, edit) => {
    const meta = { ...metaData(), ...disagreeingMeta };
    edit(meta);
    expect(metaSectionV2(pocDatasets({ replaceMeta: meta }), { binding: BINDING, warningFingerprints: bothDiagnostics(), diagnostics: 2 }).state).toBe('invalid');
  });
});

describe('the derivation is persisted and bounded', () => {
  it('names a bundle tally that is absent or wrong, as the validator does', () => {
    const bundles = { Correspondence: 700, Original: 1 };
    const diagnostics = [groupDiagnosticFingerprint('bundles', 'Original'), groupDiagnosticFingerprint('bundles', 'Supplementary')];
    const section = derive({ bundles }, { diagnostics });
    expect(disagreements(section).map((d) => [d.subject, d.carried, d.derived]).sort()).toEqual([['META.bundles["Original"]', 1, 900], ['META.bundles["Supplementary"]', null, 89]]);
    expect(derive({ bundles }, { diagnostics: [diagnostics[0]!], diagnosticCount: 1 }).state).toBe('invalid');
  });
  it('builds the same root in one step per item, killed and resumed, as in one pass', async () => {
    const section = derive();
    expect((await roundTrip(section, { itemsPerStep: 1 })).root).toBe((await roundTrip(section)).root);
  });
  it('emits its items in strictly ascending key order and only in the fixed vocabularies', () => {
    const items = metaEvidenceItems(derive());
    expect(items.map((i) => i.key)).toEqual([...items.map((i) => i.key)].sort());
    expect(items[0]).toEqual({ key: 'section/meta', observation: { kind: 'section', key: 'meta', state: 'disagrees' } });
    expect(items.slice(1).every((i) => (i.observation as { kind: string }).kind === 'warning' && i.key.startsWith('warning/'))).toBe(true);
    expect(metaEvidenceItems({ state: 'invalid' })).toEqual([{ key: 'section/meta', observation: { kind: 'section', key: 'meta', state: 'invalid' } }]);
  });
});

describe('a field that is deleted, nulled or retyped never clears or reads as a disagreement', () => {
  const bound = { clientId: CLIENT, caseId: CASE, resultsVersion: RV, manifestSha256: evidenceBinding.manifestSha256 };
  const stored = (observation: unknown) => ({ key: `warning/${'a'.repeat(32)}`, baseline: false, json: JSON.stringify({ observation, input: { caseId: CASE, clientId: CLIENT, manifestSha256: bound.manifestSha256, rendererVersion: 'r', resultsVersion: RV, validatorVersion: 'v' } }) });
  const item = { kind: 'warning', fingerprint: 'a'.repeat(32), meta: { diagnostic: 'b'.repeat(32), subject: 'META.emails', carried: 469, derived: 629 } };

  it('reads the exact stored item, and refuses every deleted, nulled or retyped leaf of it', () => {
    expect(checkEvidenceItem(stored(item), bound)?.meta).toEqual(item.meta);
    const paths = ['fingerprint', 'meta', ...Object.keys(item.meta).map((k) => `meta.${k}`)];
    for (const path of paths) {
      const leaf = path.split('.').at(-1)!;
      const at = (o: any) => path.split('.').slice(0, -1).reduce((x, k) => x[k], o);
      // A string is a valid subject, a count is a valid carried or derived value, and null is a valid carried count (META lacks the key).
      const count = path === 'meta.carried' || path === 'meta.derived';
      const values = [undefined, null, 7, 'x', {}, -1, 1.5].filter((v) => !(path === 'meta.subject' && v === 'x') && !(path === 'meta.carried' && v === null) && !(count && v === 7)
        && (count || (v !== -1 && v !== 1.5)));
      for (const value of values) {
        const o = structuredClone(item);
        if (value === undefined) delete at(o)[leaf]; else at(o)[leaf] = value;
        expect(checkEvidenceItem(stored(o), bound)?.meta, `${path}=${JSON.stringify(value)}`).toBeUndefined();
      }
    }
    expect(checkEvidenceItem(stored({ ...item, meta: { ...item.meta, carried: null } }), bound)?.meta?.carried).toBeNull();
    expect(checkEvidenceItem(stored({ ...item, extra: 1 }), bound)).toBeNull();
    expect(checkEvidenceItem(stored({ ...item, meta: { ...item.meta, extra: 1 } }), bound)).toBeNull();
    expect(checkEvidenceItem(stored({ ...item, meta: { ...item.meta, diagnostic: item.fingerprint } }), bound)).toBeNull();
    expect(checkEvidenceItem(stored({ ...item, kind: 'error' }), bound)).toBeNull();
    expect(checkEvidenceItem(stored({ ...item, meta: { ...item.meta, derived: 1.5 } }), bound)).toBeNull();
    expect(checkEvidenceItem(stored({ ...item, meta: { ...item.meta, derived: -1 } }), bound)).toBeNull();
  });

  it('refuses an acknowledgement group with a deleted, nulled or retyped field, and a malformed group in the list', async () => {
    const { snap, evidence } = await roundTrip(derive());
    const all = evidence.map((d) => d.fingerprint), held = { code: 'required-section', detail: ['meta:disagrees'] };
    const good = ack(all);
    const blocker = (g: unknown) => signoffBlockerV2(snap, { disagreements: evidence, acknowledgements: [g as AcknowledgementGroup] });
    expect(blocker(good)).toBeNull();
    for (const [field, values] of Object.entries({ reason: [undefined, null, 7, {}, ['r']], fingerprints: [undefined, null, 'x', 7, {}, [null], [7], [{}]], code: [undefined, null, 7, 'v5_meta_count_disagreement'] })) {
      for (const value of values) expect(blocker({ ...good, [field]: value }), `${field}=${JSON.stringify(value)}`).toEqual(held);
    }
    for (const g of [null, undefined, 7, 'x', []]) expect(blocker(g)).toEqual(held);
    expect(signoffBlockerV2(snap, { disagreements: evidence, acknowledgements: [null as never, good] })).toBeNull();
  });

  it('refuses a disagreement list with a deleted, nulled, retyped or doubled entry', async () => {
    const { snap, evidence } = await roundTrip(derive());
    const group = ack(evidence.map((d) => d.fingerprint)), held = { code: 'required-section', detail: ['meta:disagrees'] };
    const blocker = (disagreements: unknown) => signoffBlockerV2(snap, { disagreements: disagreements as never, acknowledgements: [group] });
    expect(blocker(evidence)).toBeNull();
    expect(blocker([evidence[0]])).toEqual(held);
    expect(blocker([...evidence, evidence[0]])).toEqual(held);
    for (const field of ['fingerprint', 'diagnostic', 'subject', 'carried', 'derived'] as const) {
      for (const value of [undefined, null, 7, 'x', {}]) {
        const changed = evidence.map((d, i) => (i === 0 ? { ...d, [field]: value } : d));
        expect(blocker(changed), `${field}=${JSON.stringify(value)}`).toEqual(held);
      }
    }
  });
});
