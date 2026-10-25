import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import Workbench, * as WorkbenchExports from '../../../src/lib/views/hosted/OperatorWorkbench.svelte';
import type { LinkedCandidate } from '../../../src/lib/results-review/native/ports.ts';
import type { OperatorSubmissionView } from '../../../src/lib/submissions/download/controller.ts';
import type { PublicationState, SignoffAcknowledgement, SignoffIdentity } from '../../../src/lib/publication/hosted/ports.ts';

// Plain tsc sees only Svelte's wildcard default declaration. svelte-check additionally checks the real component.
const assertReadiness: (v: ReadinessView, caseId: string, c: LinkedCandidate, s: OperatorSubmissionView) => void = Reflect.get(WorkbenchExports, 'assertReadiness');
const requireUnchangedReadiness: (a: ReadinessView, b: ReadinessView) => void = Reflect.get(WorkbenchExports, 'requireUnchangedReadiness');
const signoffPayload: (v: ReadinessView, operationId: string, reasons: Record<string, string>, selfApproval: boolean, rv: string) => { operationId: string; candidateId: string; identity: Omit<SignoffIdentity, 'candidateId'>; acknowledgements: SignoffAcknowledgement[]; selfApproval: boolean } = Reflect.get(WorkbenchExports, 'signoffPayload');
const publishPayload: (v: ReadinessView, operationId: string, expected: PublicationState, rv: string) => unknown = Reflect.get(WorkbenchExports, 'publishPayload');
import Page from '../../../deploy/client/routes/operator/cases/[caseId]/+page.svelte';
import { createNativePublication } from '../../../src/lib/publication/hosted/controller.ts';
import { createPublicationReadiness, type ReadinessView } from '../../../src/lib/publication/hosted/readiness.ts';
import { CASE, FP, RV, candidate, signoff, submission, world } from './fixtures.ts';

async function readiness(): Promise<ReadinessView> {
  const w = world();
  const r = await createPublicationReadiness(w.ports).read(w.request());
  return r.json();
}
const OP = 'synthetic-operation0000';
describe('operator workbench exact controller payloads', () => {
  it('binds readiness to finalized submission, full candidate identity, material and warnings', async () => {
    const v = await readiness(), c = candidate(), s = submission();
    expect(() => assertReadiness(v, CASE, c, s)).not.toThrow();
    expect(() => assertReadiness(v, CASE, c, { ...s, revisionId: 'another-revision' })).toThrow(/does not match/);
    expect(() => assertReadiness(v, CASE, { ...c, current: false }, s)).toThrow(/does not match/);
    expect(() => requireUnchangedReadiness(v, { ...v, materialSha256: 'd'.repeat(64) })).toThrow(/changed/);
    expect(() => requireUnchangedReadiness(v, { ...v, requiredAcknowledgements: [] })).toThrow(/changed/);
    expect(() => requireUnchangedReadiness(v, { ...v, identity: { ...v.identity, snapshotRevision: 'd1:2' } })).toThrow(/changed/);
  });
  it('requires version review, reasoned exact warnings and deliberate self-approval without altering draft reasons on refusal', async () => {
    const v = await readiness(), reasons = { [FP]: 'Synthetic reason' };
    expect(() => signoffPayload(v, OP, reasons, true, '')).toThrow(/exact/);
    expect(() => signoffPayload(v, OP, {}, true, RV)).toThrow(/reason/);
    expect(() => signoffPayload(v, OP, reasons, false, RV)).toThrow(/self-approval/);
    expect(reasons).toEqual({ [FP]: 'Synthetic reason' });
    const out = signoffPayload(v, OP, reasons, true, RV);
    expect(Object.keys(out).sort()).toEqual(['acknowledgements', 'candidateId', 'identity', 'operationId', 'selfApproval']);
    expect(Object.keys(out.identity)).not.toContain('candidateId');
    expect(out.acknowledgements).toEqual([{ fingerprint: FP, reason: 'Synthetic reason' }]);
  });
  it('the sign-off DTO is accepted by the real existing controller and Origin enforcement is retained', async () => {
    const w = world(), view = await readiness();
    const body = signoffPayload(view, OP, { [FP]: 'Synthetic warning reviewed' }, true, RV);
    let recorded = false;
    const ports = { ...w.ports, ledger: { ...w.ports.ledger!, recordSignoff: async (record: ReturnType<typeof signoff>) => {
      recorded = true;
      return { kind: 'recorded' as const, record, repeated: false };
    }, settleSignoff: async () => {} } };
    const url = new URL(`https://synthetic.invalid/operator/publication/${CASE}/signoffs`);
    const request = (origin: string) => ({ request: new Request(url, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }), url, params: { caseId: CASE }, identity: w.identity });
    const controller = createNativePublication(ports);
    const denied = await controller.signOff(request('https://other.invalid'));
    expect(denied.status).toBe(403);
    expect(recorded).toBe(false);
    const response = await controller.signOff(request(url.origin));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ signoffId: `so-${OP}`, state: 'signed-off', resultsVersion: RV, selfApproval: true });
    expect(recorded).toBe(true);
  });
  it('does not publish a recorded or mismatched sign-off and sends only the exact existing publish DTO', async () => {
    const v = await readiness();
    expect(() => publishPayload(v, OP, { kind: 'none' }, RV)).toThrow(/audited/);
    const so = signoff();
    v.signoff = { signoffId: so.signoffId, identity: v.identity, state: 'recorded', invalidated: false, blockers: [] };
    expect(() => publishPayload(v, OP, { kind: 'none' }, RV)).toThrow(/audited/);
    v.signoff.state = 'audited';
    v.signoff.identity = { ...v.identity, snapshotRevision: 'old' };
    expect(() => publishPayload(v, OP, { kind: 'none' }, RV)).toThrow(/audited/);
    v.signoff.identity = v.identity;
    expect(publishPayload(v, OP, { kind: 'none' }, RV)).toEqual({ operationId: OP, signoffId: so.signoffId, expected: { kind: 'none' } });
  });
});

describe('synthetic operator workbench server render', () => {
  it('renders usable explicit controls, no-JavaScript refusal and honest unavailable status; all imported text is escaped', () => {
    const c = candidate();
    const hostile = '<img src=x onerror=alert(1)>';
    const data = { caseId: hostile, submissions: [submission()], candidates: [{ ...c, candidateId: hostile }],
      submissionFailure: { status: 503, code: 'operator-download-unavailable', message: hostile }, candidateFailure: null };
    for (const component of [Workbench, Page]) {
      const html = render(component, { props: { data } }).body;
      expect(html).toContain('data-operator-workbench="synthetic"');
      expect(html).toContain('Import privately — do not publish');
      expect(html).toContain('Record exact sign-off — do not publish');
      expect(html).toContain('Publish this exact audited sign-off');
      expect(html).toContain('requires JavaScript');
      expect(html).toContain('HTTP 503 operator-download-unavailable');
      expect(html).toContain('&lt;img src=x onerror=alert(1)>');
      expect(html).not.toContain('<img');
      expect(html).toContain('disabled');
    }
  });
});
