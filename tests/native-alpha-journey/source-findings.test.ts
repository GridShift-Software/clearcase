// Semantic regressions for native24-journey-source-source-review M1–M4. Self-tests, not live acceptance evidence.
import { describe, expect, it } from 'vitest';
import { makeCtx } from './harness.ts';
import { afterRestart, signoffPublish, uploadImport } from './scenario.ts';
import type { Actor, Reply } from './http.ts';
import { sha256Hex } from './common.ts';

function intercept(actor: Actor, change: (r: Reply, path: string) => Reply): Actor {
  return { name: actor.name, send: async (method, path, init) => change(await actor.send(method, path, init), path) };
}
function body(r: Reply, text: string): Reply {
  const bytes = new TextEncoder().encode(text);
  return { ...r, text, bytes, sha256: sha256Hex(bytes) };
}
async function published() {
  const { ctx, world } = await makeCtx([], { foreign: true });
  const p1 = await uploadImport(ctx);
  expect(p1.state).not.toBeNull();
  const p2 = await signoffPublish(ctx, p1.state!, { reviewerRef: 'Reviewer One' });
  expect(p2.readback).not.toBeNull();
  return { ctx, world, before: p2.readback! };
}

describe('written source findings cannot produce false acceptance', () => {
  it.each(['originals', 'chronology', 'notes', 'all'])('M1: phase 3 rejects HTTP 500 with unchanged %s bodies', async (target) => {
    const { ctx, world, before } = await published();
    world.restart();
    ctx.actors.clientA = intercept(ctx.actors.clientA, (r, path) => {
      const match = path.includes('/originals/') ? 'originals' : path.endsWith('/chronology') ? 'chronology' : path.endsWith('/notes') ? 'notes' : null;
      return match && (target === 'all' || target === match) ? { ...r, status: 500 } : r;
    });
    const p3 = await afterRestart(ctx, before);
    expect(p3.readback).toBeNull();
    expect(p3.obs.some((o) => !o.ok && o.id.startsWith('p3.client'))).toBe(true);
  });
  it('M1: phase 2 rejects a failed snapshot even with its healthy body', async () => {
    const { ctx } = await makeCtx([], { foreign: true });
    const p1 = await uploadImport(ctx);
    ctx.actors.clientA = intercept(ctx.actors.clientA, (r, path) => path.endsWith('/chronology') && r.status === 200 ? { ...r, status: 500 } : r);
    const p2 = await signoffPublish(ctx, p1.state!, { reviewerRef: 'Reviewer One' });
    expect(p2.readback).toBeNull();
    for (const label of ['p2.client', 'p2.notes', 'p2.post-sweep']) expect(p2.obs.some((o) => !o.ok && o.id.startsWith(label))).toBe(true);
  });
  it('M2: nonempty HTTP 200 junk is not a complete export, even without containsOriginal', async () => {
    const { ctx } = await makeCtx([], { foreign: true });
    const p1 = await uploadImport(ctx);
    delete ctx.plan.ports['recovery.export']!.containsOriginal;
    ctx.actors.operatorB = intercept(ctx.actors.operatorB, (r, path) => path.endsWith('/export') && r.status === 200 ? body(r, 'not an export') : r);
    const p2 = await signoffPublish(ctx, p1.state!, { reviewerRef: 'Reviewer One' });
    expect(p2.readback).toBeNull();
    expect(p2.obs.some((o) => o.id === 'p2.export' && !o.ok)).toBe(true);
  });
  it('M3: no foreign case fails before sending any request, including the preserved unknown-case defect', async () => {
    const { ctx } = await makeCtx(['unknownDiffersFromForeign'], { foreign: false });
    let requests = 0;
    for (const actor of Object.values(ctx.actors)) if (actor) actor.send = async () => { requests++; throw new Error('must not request'); };
    const p1 = await uploadImport(ctx);
    expect(requests).toBe(0);
    expect(p1.state).toBeNull();
    expect(p1.obs.some((o) => !o.ok && o.id === 'p1.prerequisites')).toBe(true);
  });
  it.each(['submissionRevisionId', 'submissionManifestSha256'])('M4: an unrelated nonempty %s fails import before human sign-off', async (key) => {
    const { ctx } = await makeCtx([], { foreign: true });
    ctx.actors.operatorB = intercept(ctx.actors.operatorB, (r, path) => {
      if (!path.endsWith('/import') || r.status !== 201) return r;
      const j = JSON.parse(r.text);
      j.identity[key] = key === 'submissionRevisionId' ? 'wrong-submission' : 'f'.repeat(64);
      return body(r, JSON.stringify(j));
    });
    const p1 = await uploadImport(ctx);
    expect(p1.state).toBeNull();
    expect(p1.obs.some((o) => o.id === 'p1.import' && !o.ok)).toBe(true);
  });
});
