import { afterEach, expect, it } from 'vitest';
import { world, CASE, CLIENT } from './fixture.ts';
import { signoffBlocker, newWarnings } from '../../../src/lib/publication/hosted/rules.ts';
import { createPublicationMaterialReader } from '../../../src/lib/server/runtime/hosted/publication-material.ts';

const worlds: Awaited<ReturnType<typeof world>>[] = [];
async function setup(o?: Parameters<typeof world>[0]) { const w = await world(o); worlds.push(w); return w; }
afterEach(() => { for (const w of worlds.splice(0)) w.close(); });
const dataset = (key: string, data: unknown, kind: 'generated' | 'authored' = 'authored') => ({ key, data, kind,
  schema: `v5.${key}@1`, required: true, provenance: { source: 'synthetic', sourcePath: 'invented', adapter: 'test@1' } });

it.each([
  { name: 'structured refs array', options: { refs: ['OD-999'] } },
  { name: 'also_in array', options: { row: { also_in: ['OD-999'] } } },
  { name: 'generated inline file-level token', options: { excerpt: 'See [[OD-999]]' } },
  { name: 'generated inline page token', options: { excerpt: 'See [[OD-999#p1]]' } },
  { name: 'authored inline file-level token', options: { datasets: [dataset('witnesses', [{ name: 'Synthetic', role: '', willsay: 'See [[OD-999]]' }])] } },
  { name: 'structured refs string', options: { datasets: [dataset('defence-matrix', [{ point: '', dcs: '', rebuttal: '', evidence: '', refs: 'See OD-999', docs: [] }])] } },
  { name: 'structured ref field', options: { datasets: [dataset('timeline-events', [{ date: '', kind: '', note: '', ref: 'OD-999', title: '', url: '' }])] } },
  { name: 'schema-specific citation array', options: { datasets: [dataset('lit-recon', [{ month: '', invoice: ['OD-999'], statement: [], supporting: [], charging: [], amountdue: [], pod: [] }])] } },
  { name: 'structured headline_ref', options: { datasets: [dataset('quantum', { amountDueSeries: [], statementSeries: [], interestSeries: [], invoiceLedger: [], chargingCount: 0, invoiceCount: 0, grossInvoiced: '', headline_date: '', headline_due: '', headline_ref: 'OD-999', headline_url: '' }, 'generated')] } },
  { name: 'registered target with no indexed asset', options: { row: { ref: 'OD-999' }, refs: ['OD-999'] } },
  { name: 'missing target original', options: { missing: true, refs: ['OD-003'] } },
  { name: 'indirect embedded target with missing root original', options: { missing: true, embedded: true, refs: ['OD-003.a1'] } },
])('adds non-waivable display evidence for $name without changing diagnostic severity/digest', async ({ options }) => {
  const w = await setup(options), s = await w.read();
  if (!s) throw new Error('fixture snapshot');
  expect(s.requiredSections).toContainEqual({ key: 'supplied-references', state: 'invalid' });
  expect(s.validation).toEqual({ verdict: w.validation.result.verdict, validatorVersion: w.validation.result.validatorVersion,
    diagnosticsSha256: w.validation.result.diagnosticsSha256, warningFingerprints: w.validation.result.warningFingerprints, errorFingerprints: [] });
  expect(signoffBlocker(s)?.code).toBe('required-section');
  // Even treating every actual warning as already accepted cannot waive required display evidence.
  // This exercises the genuine rules, not the separately owned controller guard or a fabricated error fingerprint.
  const allWarningsAccepted = { ...s, trustedBaseline: s.validation.warningFingerprints };
  expect(newWarnings(allWarningsAccepted)).toEqual([]);
  expect(signoffBlocker(allWarningsAccepted)?.code).toBe('required-section');
});

it('uses uncapped canonical citation counts when diagnostic details are truncated', async () => {
  const w = await setup({ refs: Array.from({ length: 2001 }, (_, n) => `OD-${10000 + n}`) }), s = await w.read();
  if (!s) throw new Error('fixture snapshot');
  expect(w.validation.result.counts.CITE_UNRESOLVED).toBe(2001);
  expect(s.validation.warningFingerprints).toEqual(w.validation.result.warningFingerprints);
  expect(s.requiredSections).toContainEqual({ key: 'supplied-references', state: 'invalid' });
});

it('retains valid file-level references and real page counts without inventing precision', async () => {
  const w = await setup({ refs: ['OD-001'], excerpt: 'File [[OD-001]] and page [[ OD-001#p1 ]]' }), s = await w.read();
  if (!s) throw new Error('fixture snapshot');
  expect(s.requiredSections).toEqual([{ key: 'chronology', state: 'valid' }]);
  expect(s.requiredPreviews).toEqual([{ assetId: 'OD-001', state: 'rendered' }]);
  expect(signoffBlocker(s)).toBeNull();
  expect(w.checkerCalls).toHaveLength(1);
});

it.each(['session-open', 'revision-query', 'first-case-query'] as const)('audits the first metadata %s fault with no material release', async (fault) => {
  const w = await setup(), reader = createPublicationMaterialReader(w.options)!, before = w.bucket.gets;
  if (fault === 'session-open') w.db.withSession = () => { throw new Error('synthetic session-open fault'); };
  else w.db.failNext = fault === 'revision-query' ? /SELECT 'd1:'/ : /SELECT EXISTS \(SELECT 1 FROM rs_case WHERE/;
  await expect(reader.read(w.scope)).rejects.toThrow();
  // The case check shares one statement with the row bounds, after the candidate pins its version and before any package read.
  expect(w.events.at(-1)).toMatchObject({ action: 'publication.material.read', outcome: 'failed', version: fault === 'first-case-query' ? w.rv : null,
    object: { kind: 'candidate', id: w.scope.candidateId, caseId: CASE }, actor: { kind: 'verified', principal: { kind: 'staff' } } });
  expect(w.events.some((e) => e.outcome === 'succeeded')).toBe(false);
  expect(w.bucket.gets - before).toBe(fault === 'first-case-query' ? 1 : 0); // identity object only
});

it.each([false, true])('audits absent/noncurrent candidate refusal (settled=%s) without protected bytes', async (settled) => {
  const w = await setup({ settled }), before = w.bucket.gets;
  const s = await createPublicationMaterialReader(w.options)!.read({ ...w.scope, candidateId: settled ? 'absent' : w.scope.candidateId });
  expect(s).toBeNull();
  expect(w.events.at(-1)).toMatchObject({ action: 'publication.material.read', outcome: 'refused', version: null });
  expect(w.bucket.gets).toBe(before);
});

it('records release intent, never completed read success before a late grant denial', async () => {
  const w = await setup();
  w.state.auditHook = (e) => { if (e.outcome === 'succeeded') w.state.grant = false; };
  await expect(w.read()).rejects.toMatchObject({ code: 'forbidden' });
  expect(w.events.some((e) => e.action === 'publication.material.read.intent' && e.outcome === 'succeeded')).toBe(true);
  expect(w.events.some((e) => e.action === 'publication.material.read' && e.outcome === 'succeeded')).toBe(false);
  expect(w.events.at(-1)).toMatchObject({ action: 'publication.material.read', outcome: 'denied', version: w.rv });
});

it('fails closed when an early-refusal audit cannot persist or returns the wrong event id', async () => {
  const w = await setup({ settled: false });
  w.state.audit = false;
  await expect(w.read()).rejects.toMatchObject({ code: 'audit-unavailable' });
  const reader = createPublicationMaterialReader({ ...w.options, audit: { async append() { return { eventId: 'wrong-id' }; } } })!;
  await expect(reader.read({ clientId: CLIENT, caseId: CASE, candidateId: 'absent' })).rejects.toMatchObject({ code: 'storage-unavailable' });
});
