import { afterEach, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { createPublicationReadiness, setReadinessComposition } from '../../../src/lib/publication/hosted/readiness.ts';
import { GET } from '../../../deploy/client/routes/operator/publication/[caseId]/readiness/+server.ts';
import { id } from '../../../src/lib/server/runtime/ids.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { canonicalJson } from '../../../src/lib/case-package/canonical.ts';
import { sha256Canonical } from '../../../src/lib/results-review/native/digest.ts';
import { CASE, FP, signoff, syntheticFence, world } from './fixtures.ts';

afterEach(() => setReadinessComposition(null));
describe('publication readiness observations', () => {
  it('defaults unavailable and binds composition to the ORIGINAL request, not a clone', async () => {
    const w = world(), r = w.request();
    const e = { request: r.request, url: r.url, params: r.params, locals: { identity: w.identity }, platform: undefined } as unknown as RequestEvent;
    expect((await GET(e)).status).toBe(503);
    const requests = new WeakMap([[r.request, w.ports]]);
    setReadinessComposition(({ request }) => requests.get(request) ?? null);
    const response = await GET(e);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await GET({ ...e, request: r.request.clone() })).status).toBe(503);
  });
  it('returns exact identity, the pure-rule warnings and canonical material digest, not snapshot content or approval', async () => {
    const w = world();
    const response = await createPublicationReadiness(w.ports).read(w.request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ caseId: CASE, blocker: null, requiredAcknowledgements: [FP], selfApprovalRequired: true, signoff: null });
    expect(body.materialSha256).toBe(await sha256Canonical(w.current));
    expect(body.identity.snapshotRevision).toBe('d1:1');
    expect(canonicalJson(body)).not.toMatch(/preparedBy|issuer|subject|coverage|ready|signed-off|published/);
    // One material read; both capabilities are decided (audited) once at admission, then fenced in SQL at release.
    expect(w.reads).toBe(1);
    expect(w.grants).toBe(1);
    expect(w.previews).toBe(w.grants);
    expect(w.events.map((e) => e.action)).toEqual(['publication.readiness.intent', 'publication.readiness.release-intent']);
  });
  it.each(['publish', 'preview'] as const)('reads no snapshot or ledger metadata without current explicit %s access', async (capability) => {
    const w = world();
    const deny = async () => { throw contractError('forbidden'); };
    if (capability === 'publish') w.ports = { ...w.ports, authorize: deny };
    else w.identity.authorize = deny;
    const response = await createPublicationReadiness(w.ports).read(w.request());
    expect(response.status).toBe(403);
    expect(w.reads).toBe(0);
    expect(w.events).toHaveLength(1);
    expect(w.events[0].outcome).toBe('denied');
  });
  it('refuses nonstaff and wrong-client identities before metadata', async () => {
    const w = world(), r = w.request();
    const identity = { ...w.identity, kind: 'verified' as const, principal: { ...w.identity.principal!, kind: 'client' as const } };
    expect((await createPublicationReadiness(w.ports).read({ ...r, identity })).status).toBe(403);
    expect((await createPublicationReadiness(w.ports).read({ ...r, identity: { ...w.identity, clientId: id('client', 'another-client') } })).status).toBe(401);
    expect(w.reads).toBe(0);
  });
  it('required audit failure releases no snapshot', async () => {
    const w = world();
    const ports = { ...w.ports, audit: { append: async (): Promise<never> => { throw new Error('synthetic outage'); } } };
    const response = await createPublicationReadiness(ports).read(w.request());
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('audit-unavailable');
    expect(w.reads).toBe(0);
  });
  it('ADVERSE: a warning/material edit during the awaited release audit refuses stale readiness, even if the identity is unchanged', async () => {
    const w = world();
    const audit = w.ports.audit!;
    const ports = { ...w.ports, audit: { async append(e: Parameters<typeof audit.append>[0]) {
      const out = await audit.append(e);
      if (e.action === 'publication.readiness.release-intent') w.current = { ...w.current, trustedBaseline: [FP] };
      return out;
    } } };
    const response = await createPublicationReadiness(ports).read(w.request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'readiness-stale', message: 'The candidate or sign-off changed during the read. Refresh and review again.' });
  });
  it('revocation after awaited audit is rechecked before release', async () => {
    const w = world(); let revoked = false;
    w.identity.checkRevocation = async () => { if (revoked) throw contractError('invalid-session'); };
    const audit = w.ports.audit!;
    const ports = { ...w.ports, audit: { async append(e: Parameters<typeof audit.append>[0]) { const out = await audit.append(e); if (e.action === 'publication.readiness.release-intent') revoked = true; return out; } } };
    expect((await createPublicationReadiness(ports).read(w.request())).status).toBe(401);
  });
  it('uses the actual hard blocker, never acknowledges errors or truncates excess warnings', async () => {
    const w = world();
    w.current = { ...w.current, requiredPreviews: [{ assetId: 'synthetic', state: 'failed' }] };
    const response = await createPublicationReadiness(w.ports).read(w.request());
    expect((await response.json()).blocker).toEqual({ code: 'preview-not-ready', detail: ['synthetic:failed'] });
    w.current = { ...w.current, validation: { ...w.current.validation, errorFingerprints: ['e'.repeat(32)] } };
    expect((await (await createPublicationReadiness(w.ports).read(w.request())).json()).blocker.code).toBe('validation-failed');
    w.current = { ...w.current, trustedBaseline: Array.from({ length: 201 }, (_, n) => n.toString(16).padStart(32, '0')) };
    expect((await createPublicationReadiness(w.ports).read(w.request())).status).toBe(503);
  });
  it('observes only the requested sign-off; recorded, invalidated and changed-warning records cannot appear effective', async () => {
    const w = world(); let so = signoff();
    const ports = { ...w.ports, readinessFence: syntheticFence(() => w.current, () => so), ledger: { ...w.ports.ledger!, signoff: async () => structuredClone(so) } };
    const r = w.request(); r.url.searchParams.set('signoffId', so.signoffId);
    const read = async () => (await (await createPublicationReadiness(ports).read(r)).json()).signoff;
    expect(await read()).toMatchObject({ state: 'audited', invalidated: false, blockers: [] });
    so = { ...so, state: 'recorded' };
    expect((await read()).blockers).toContain('signoff-not-effective');
    so = { ...so, state: 'audited', invalidatedAt: '2026-10-25T11:00:00.000Z' };
    expect((await read()).blockers).toContain('signoff-not-effective');
    so = { ...so, invalidatedAt: null, warningFingerprints: [] };
    expect((await read()).blockers).toContain('signoff-stale');
  });
});
