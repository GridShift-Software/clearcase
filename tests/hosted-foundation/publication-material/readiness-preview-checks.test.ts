// Real material reader, real sign-off ledger and the real final release fence over one SQLite-backed D1 double. The render
// checker is a UNIT DOUBLE returning raw, private-looking reasons; this is not renderer acceptance.
import { afterEach, describe, expect, it } from 'vitest';
import { world, CASE, CLIENT, NOW } from './fixture.ts';
import { createPublicationMaterialReader } from '../../../src/lib/server/runtime/hosted/publication-material.ts';
import { createPublicationReadiness, type PublicationReadinessPorts } from '../../../src/lib/publication/hosted/readiness.ts';
import { d1PublicationLedger } from '../../../src/lib/publication/hosted/ledger.ts';
import { d1PublicationPublisher } from '../../../src/lib/publication/hosted/d1-publisher.ts';
import { d1ReadinessFence } from '../../../src/lib/publication/hosted/readiness-fence.ts';
import { checkSnapshot } from '../../../src/lib/publication/hosted/rules.ts';
import type { NativePreviewRenderChecker } from '../../../src/lib/viewer/hosted/render-check-contract.ts';

const worlds: Awaited<ReturnType<typeof world>>[] = [];
afterEach(() => { calls.n = 0; for (const w of worlds.splice(0)) w.close(); });

const RAW = 'TypeError at https://client-a.example/__session?token=abc123 cookie=__session=eyJhbGciOi sess_2abcDEF blob:1f2e3d4c';
const calls = { n: 0 };
const checker = (state: 'pending' | 'failed' | 'rendered', reason: string | null, stage?: string): NativePreviewRenderChecker =>
  ({ async verify() { calls.n++; return { state, rendererVersion: 'UNIT-DOUBLE-NOT-ACCEPTANCE', pages: state === 'rendered' ? 1 : null, reason, ...(stage === undefined ? {} : { stage }) } as never; } });

/** One readiness GET as a distinct staff reviewer holding both the publisher and the content grant. */
async function readiness(o: Parameters<typeof world>[0], renderChecker: NativePreviewRenderChecker | null) {
  const w = await world(o); worlds.push(w);
  w.options.renderChecker = renderChecker;
  w.db.exec(`INSERT INTO tenant_case_grants (grant_id, client_id, scope, case_id, issuer, subject, principal_kind, role, slot, state, version, created_operation_id, request, created_by_issuer, created_by_subject, created_at)
    VALUES ('g-publisher', ?, 'case', ?, 'synthetic', 'distinct-reviewer', 'staff', 'publisher', 'publisher', 'active', 1, 'op-publisher', '{}', 'synthetic', 'provisioner', ?)`, CLIENT, CASE, NOW);
  const identity = w.options.identity;
  const ports: PublicationReadinessPorts = { clientId: CLIENT, candidates: createPublicationMaterialReader(w.options)!, now: () => new Date(NOW),
    authorize: async () => {}, publisher: d1PublicationPublisher({ db: w.db, clientId: CLIENT, checkSession: async () => {} }),
    ledger: d1PublicationLedger(w.db), readinessFence: d1ReadinessFence({ db: w.db, clientId: CLIENT }), audit: w.options.audit };
  const url = new URL(`https://synthetic.invalid/operator/publication/${CASE}/readiness?candidateId=${w.scope.candidateId}`);
  const response = await createPublicationReadiness(ports).read({ request: new Request(url), url, params: { caseId: CASE }, identity });
  return { w, response, text: await response.clone().text(), body: await response.json() };
}

describe('readiness preview-check diagnostics (synthetic component evidence, NOT native renderer acceptance)', () => {
  it.each(['failed', 'pending'] as const)('shows a %s preview even while a required section is the first blocker', async (state) => {
    const r = await readiness({ section: true }, checker(state, RAW));
    expect(r.response.status).toBe(200);
    expect(r.body.blocker).toEqual({ code: 'required-section', detail: ['risk-matrix:unsupported'] });
    expect(r.body.previewChecks).toEqual([{ assetId: 'OD-001', state }]);
  });

  it('shows a pending preview when no internal checker exists', async () => {
    const r = await readiness({ section: true }, null);
    expect(r.body.blocker.code).toBe('required-section');
    expect(r.body.previewChecks).toEqual([{ assetId: 'OD-001', state: 'pending' }]);
  });

  it('never releases a raw render reason, URL, session id, cookie or blob reference', async () => {
    const r = await readiness({ section: true }, checker('failed', RAW));
    for (const leak of ['TypeError', 'https://', '__session', 'token=', 'cookie', 'eyJhbGciOi', 'sess_', 'blob:', 'UNIT-DOUBLE']) expect(r.text).not.toContain(leak);
    expect(Object.keys(r.body.previewChecks[0]).sort()).toEqual(['assetId', 'state']);
  });

  it('adds no render, no event and no fence-order change, and never fabricates a rendered state', async () => {
    const pending = await readiness({ section: true }, checker('pending', null));
    expect(calls.n).toBe(1);
    expect(pending.w.events.map((e) => e.action)).toContain('publication.readiness.release-intent');
    expect(pending.body.previewChecks.every((p: { state: string }) => p.state !== 'rendered')).toBe(true);
    const clean = await readiness({}, checker('rendered', null));
    expect(calls.n).toBe(2);
    expect(clean.body.blocker).toBeNull();
    expect(clean.body.previewChecks).toEqual([{ assetId: 'OD-001', state: 'rendered' }]);
    expect(clean.body.materialSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pending.w.events.map((e) => e.action)).toEqual(clean.w.events.map((e) => e.action));
  });

  it('keeps the authority fields and every HOLD alongside the projection', async () => {
    const r = await readiness({ section: true }, checker('failed', null));
    expect(r.body).toMatchObject({ caseId: CASE, selfApprovalRequired: false, signoff: null, requiredAcknowledgements: expect.any(Array),
      identity: { candidateId: r.w.scope.candidateId } });
  });
});

describe('safe render outcome codes in readiness (synthetic component evidence, NOT native renderer acceptance)', () => {
  const SOURCE_CODES = ['invalid-render-input', 'unsupported-media-type', 'file-budget-exceeded', 'input-integrity-mismatch', 'unsupported-pdf',
    'render-receipt-integrity', 'render-receipt-unavailable', 'render-admission-unavailable', 'render-admission-refused', 'render-timeout',
    'render-failed', 'render-cleanup-failed', 'incomplete-render-transcript'];
  it.each(SOURCE_CODES)('shows the source-owned code %s while a required section is the first blocker', async (code) => {
    const r = await readiness({ section: true }, checker('failed', code));
    expect(r.response.status).toBe(200);
    expect(r.body.blocker.code).toBe('required-section');
    expect(r.body.previewChecks).toEqual([{ assetId: 'OD-001', state: 'failed', reasonCode: code }]);
  });

  it.each(['launch', 'page-setup', 'navigation', 'inspection', 'cleanup'])('shows the allowlisted diagnostic stage %s beside render-failed', async (stage) => {
    const r = await readiness({ section: true }, checker('failed', 'render-failed', stage));
    expect(r.body.previewChecks).toEqual([{ assetId: 'OD-001', state: 'failed', reasonCode: 'render-failed', stage }]);
  });

  it('turns an unknown or private-looking reason into the generic unavailable code and drops an unknown stage', async () => {
    for (const reason of [RAW, 'render-timeout ', 'RENDER-TIMEOUT', 'sess_2abcDEF', '', 'constructor']) {
      const r = await readiness({ section: true }, checker('failed', reason, RAW));
      expect(r.body.previewChecks).toEqual([{ assetId: 'OD-001', state: 'failed', reasonCode: 'render-unavailable' }]);
      for (const leak of ['TypeError', 'https://', '__session', 'token=', 'cookie', 'eyJhbGciOi', 'sess_', 'blob:', 'UNIT-DOUBLE']) expect(r.text).not.toContain(leak);
    }
  });

  it('never carries a code or stage for a rendered preview, and a rendered result with a reason is not rendered', async () => {
    const clean = await readiness({}, checker('rendered', null, 'inspection'));
    expect(clean.body.blocker).toBeNull();
    expect(clean.body.previewChecks).toEqual([{ assetId: 'OD-001', state: 'rendered' }]);
    const contradictory = await readiness({}, checker('rendered', 'render-timeout', 'cleanup'));
    expect(contradictory.body.previewChecks).toEqual([{ assetId: 'OD-001', state: 'pending', reasonCode: 'render-timeout', stage: 'cleanup' }]);
    expect(contradictory.body.blocker.code).toBe('preview-not-ready');
  });

  it('keeps the checker call count, audit actions and final fence unchanged, and the digest follows the pinned code', async () => {
    const coded = await readiness({ section: true }, checker('failed', 'render-timeout', 'navigation'));
    const plain = await readiness({ section: true }, checker('failed', null));
    expect(calls.n).toBe(2);
    expect(coded.response.status).toBe(200);
    expect(coded.w.events.map((e) => e.action)).toEqual(plain.w.events.map((e) => e.action));
    expect(coded.body.materialSha256).not.toBe(plain.body.materialSha256);
    expect(coded.body.blocker).toEqual(plain.body.blocker);
  });

  it('checkSnapshot accepts omitted optional keys and allowlisted values only, with no extra key', async () => {
    const w = await world({ section: true }); worlds.push(w);
    w.options.renderChecker = checker('failed', 'render-timeout', 'launch');
    const base = await w.read() as unknown as { requiredPreviews: Record<string, unknown>[] };
    const withPreview = (p: Record<string, unknown>) => ({ ...base, requiredPreviews: [p] });
    expect(base.requiredPreviews).toEqual([{ assetId: 'OD-001', state: 'failed', reasonCode: 'render-timeout', stage: 'launch' }]);
    expect(checkSnapshot(withPreview({ assetId: 'OD-001', state: 'failed' }))).not.toBeNull();
    expect(checkSnapshot(withPreview({ assetId: 'OD-001', state: 'failed', reasonCode: 'render-timeout', stage: 'cleanup' }))).not.toBeNull();
    for (const bad of [{ reasonCode: RAW }, { reasonCode: 'render-timeout ' }, { reasonCode: 7 }, { reasonCode: null }, { reasonCode: undefined }, { stage: 'boot' },
      { stage: null }, { stage: ['launch'] }, { reason: 'render-timeout' }, { detail: 'x' }]) {
      expect(checkSnapshot(withPreview({ assetId: 'OD-001', state: 'failed', ...bad }))).toBeNull();
    }
  });
});
