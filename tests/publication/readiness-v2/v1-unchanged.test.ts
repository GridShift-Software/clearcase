import { describe, expect, it } from 'vitest';
import { createPublicationReadiness } from '../../../src/lib/publication/hosted/readiness.ts';
import { checkSnapshot, newWarnings, signoffBlocker } from '../../../src/lib/publication/hosted/rules.ts';
import { signoff, snapshot, syntheticFence, world } from '../../hosted-smoke/operator-workbench/fixtures.ts';

// The bodies below were captured from the v1 code at wave head 2f55a01a, before U4 changed any file. They are compared byte for byte.
const IDENTITY = '"identity":{"candidateId":"cand-synthetic","linkId":"link-synthetic","submissionRevisionId":"subrev-synthetic","submissionManifestSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","resultsVersion":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","manifestSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","packageInputRevisionId":"sha256:synthetic-input","diagnosticsSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","validatorVersion":"synthetic-validator/1","snapshotRevision":"d1:1"}';
const PLAIN = `{"caseId":"synthetic-case",${IDENTITY},"materialSha256":"546982b04918a0d9aa26ac2d1b9eba3a43a3a817842ea7389cbb51052578e3fc","blocker":null,"previewChecks":[{"assetId":"synthetic-pdf","state":"rendered"}],"requiredAcknowledgements":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"selfApprovalRequired":true,"signoff":null}`;
const SIGNED = `{"caseId":"synthetic-case",${IDENTITY},"materialSha256":"546982b04918a0d9aa26ac2d1b9eba3a43a3a817842ea7389cbb51052578e3fc","blocker":null,"previewChecks":[{"assetId":"synthetic-pdf","state":"rendered"}],"requiredAcknowledgements":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"selfApprovalRequired":true,"signoff":{"signoffId":"so-synthetic000000000",${IDENTITY},"state":"audited","invalidated":false,"blockers":[]}}`;
const BLOCKED = `{"caseId":"synthetic-case",${IDENTITY},"materialSha256":"9629be1f7106669be87ad62b0bc356f2a9959063d49f77c65eb00ea1ffc6c6d1","blocker":{"code":"preview-not-ready","detail":["synthetic:failed"]},"previewChecks":[{"assetId":"synthetic","state":"failed","reasonCode":"render-timeout","stage":"navigation"}],"requiredAcknowledgements":["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],"selfApprovalRequired":true,"signoff":null}`;

describe('v1 readiness is untouched by snapshot v2', () => {
  it('returns byte-identical bodies for a plain, a signed and a blocked v1 candidate', async () => {
    const w = world();
    expect(await (await createPublicationReadiness(w.ports).read(w.request())).text()).toBe(PLAIN);
    const so = signoff();
    const ports = { ...w.ports, readinessFence: syntheticFence(() => w.current, () => so), ledger: { ...w.ports.ledger!, signoff: async () => structuredClone(so) } };
    const r = w.request(); r.url.searchParams.set('signoffId', so.signoffId);
    expect(await (await createPublicationReadiness(ports).read(r)).text()).toBe(SIGNED);
    w.current = { ...w.current, requiredPreviews: [{ assetId: 'synthetic', state: 'failed', reasonCode: 'render-timeout', stage: 'navigation' }] };
    expect(await (await createPublicationReadiness(w.ports).read(w.request())).text()).toBe(BLOCKED);
  });
  it('keeps the v1 caps and v1 state vocabulary: v2-only states and the v2 format are unreadable as v1', () => {
    expect(checkSnapshot(snapshot())).not.toBeNull();
    for (const state of ['records-rendered', 'disagrees']) expect(checkSnapshot({ ...snapshot(), requiredSections: [{ key: 'matter', state }] })).toBeNull();
    expect(checkSnapshot({ ...snapshot(), format: 'clearcase.candidate-snapshot/2' })).toBeNull();
    expect(signoffBlocker({ ...snapshot(), requiredSections: [{ key: 'matter', state: 'records-rendered' as 'valid' }] })).toEqual({ code: 'required-section', detail: ['matter:records-rendered'] });
    expect(newWarnings(snapshot())).toEqual(['b'.repeat(32)]);
  });
  it('still answers 503 for a v1 candidate over 200 entries', async () => {
    const w = world();
    w.current = { ...w.current, trustedBaseline: Array.from({ length: 201 }, (_, n) => n.toString(16).padStart(32, '0')) };
    expect((await createPublicationReadiness(w.ports).read(w.request())).status).toBe(503);
  });
});
