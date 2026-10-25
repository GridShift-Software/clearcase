import { expect, it } from 'vitest';
import { createPublicationReadiness } from '../../../src/lib/publication/hosted/readiness.ts';
import { contractError } from '../../../src/lib/server/runtime/errors.ts';
import { world, FP, signoff, syntheticFence } from './fixtures.ts';

it('probe 1: refuses material changed during the final awaited authority check', async () => {
  const w = world(); let previews = 0;
  w.identity.authorize = async () => {
    previews++;
    if (previews === 4) w.current = { ...w.current, trustedBaseline: [FP] };
  };
  const r = await createPublicationReadiness(w.ports).read(w.request());
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ code: 'readiness-stale', message: 'The candidate or sign-off changed during the read. Refresh and review again.' });
});

it('probe 2: deny before metadata and fail closed on the release audit', async () => {
  const denied = world();
  denied.identity.authorize = async () => { throw contractError('forbidden'); };
  expect((await createPublicationReadiness(denied.ports).read(denied.request())).status).toBe(403);
  expect(denied.reads).toBe(0);
  expect(denied.events.at(-1)?.outcome).toBe('denied');
  const w = world(), original = w.ports.audit!;
  const ports = { ...w.ports, audit: { async append(e: Parameters<typeof original.append>[0]) {
    if (e.action === 'publication.readiness.release-intent') throw new Error('synthetic audit outage');
    return original.append(e);
  } } };
  const r = await createPublicationReadiness(ports).read(w.request());
  expect(r.status).toBe(503);
  expect(w.reads).toBe(1);
});

it('observes the requested sign-off after the last authority await, including invalidation without identity change', async () => {
  const w = world(); let so = signoff(), previews = 0;
  w.identity.authorize = async () => { if (++previews === 4) so = { ...so, invalidatedAt: '2026-10-25T11:00:00.000Z' }; };
  const r = w.request(); r.url.searchParams.set('signoffId', so.signoffId);
  const ports = { ...w.ports, readinessFence: syntheticFence(() => w.current, () => so), ledger: { ...w.ports.ledger!, signoff: async () => structuredClone(so) } };
  expect((await createPublicationReadiness(ports).read(r)).status).toBe(409);
});

it('takes the final material observation after awaited sign-off storage, not before it', async () => {
  const w = world(); let reads = 0;
  const so = signoff(), r = w.request(); r.url.searchParams.set('signoffId', so.signoffId);
  const ports = { ...w.ports, readinessFence: syntheticFence(() => w.current, () => so), ledger: { ...w.ports.ledger!, signoff: async () => {
    if (++reads === 2) w.current = { ...w.current, trustedBaseline: [FP] };
    return structuredClone(so);
  } } };
  expect((await createPublicationReadiness(ports).read(r)).status).toBe(409);
});
