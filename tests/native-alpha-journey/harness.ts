// Test harness: build a journey context over the self-test world. Used only by this directory's unit tests.
import { randomHex } from './common.ts';
import { makeActor } from './http.ts';
import { buildFixture, type JourneyFixture } from './fixtures.ts';
import { resolveRoutes } from './routes.ts';
import { afterRestart, signoffPublish, uploadImport, type Ctx, type Obs, type State } from './scenario.ts';
import { SIM_COOKIE, createWorld, simRoutes, type Defect } from './world.ts';
import type { Readback } from './readback.ts';
import { serializeReadback, parseReadback } from './readback.ts';
import type { SessionProof } from './session.ts';

export const SHA = 'a'.repeat(40);
export const ORIGIN = 'https://native.example.invalid';
export const CASE = 'case-journey-1';
let fixture: JourneyFixture | null = null;
export async function fixtureOnce() { return (fixture ??= await buildFixture('0123456789ab')); }

const proof = (actor: string): SessionProof => ({ cookies: [{ name: SIM_COOKIE, value: actor, domain: 'native.example.invalid', path: '/', secure: true, expires: -1 }], names: [SIM_COOKIE] });

export async function makeCtx(defects: Defect[] = [], opts: { reviewer?: boolean; foreign?: boolean } = {}) {
  const f = await fixtureOnce();
  const world = createWorld(f, { sha: SHA, caseId: CASE, foreignCaseId: opts.foreign !== false ? 'case-foreign-1' : undefined, origin: ORIGIN, defects });
  const base = new URL(ORIGIN), mk = (n: string, p: string | null) => makeActor(n, base, p ? proof(p) : null, world.fetch);
  const resolved = resolveRoutes(simRoutes);
  if (resolved.problems.length || resolved.unresolved.length) throw new Error(`sim routes: ${resolved.problems.join('; ')} ${resolved.unresolved.join(',')}`);
  let n = 0;
  const ctx: Ctx = {
    plan: { origin: ORIGIN, expectedSha: SHA, caseId: CASE, foreignCaseId: opts.foreign !== false ? 'case-foreign-1' : null, ports: resolved.ports },
    actors: { anon: mk('anon', null), clientA: mk('clientA', 'clientA'), operatorB: mk('operatorB', 'operatorB'), otherClient: mk('otherClient', 'otherClient'), revoked: mk('revoked', 'revoked'), reviewer: opts.reviewer ? mk('reviewer', 'reviewer') : null },
    fixture: f, newId: () => `op-${String(++n).padStart(4, '0')}-${randomHex(8)}`,
  };
  return { ctx, world };
}

export interface Journey { p1: { obs: Obs[]; state: State | null }; p2: { obs: Obs[]; readback: Readback | null } | null; p3: { obs: Obs[]; readback: Readback | null } | null; failed: string[] }
export async function runJourney(defects: Defect[] = [], opts: { reviewer?: boolean; foreign?: boolean } = {}): Promise<Journey> {
  const { ctx, world } = await makeCtx(defects, opts);
  const p1 = await uploadImport(ctx);
  const p2 = p1.state ? await signoffPublish(ctx, p1.state, { reviewerRef: 'Reviewer One' }) : null;
  let p3: Journey['p3'] = null;
  if (p2?.readback) {
    const parsed = parseReadback(serializeReadback(p2.readback)); // the report really round-trips through the exact parser
    if (!parsed.ok) throw new Error(parsed.problems.join(';'));
    world.restart();
    p3 = await afterRestart(ctx, parsed.readback);
  }
  const failed = [...p1.obs, ...(p2?.obs ?? []), ...(p3?.obs ?? [])].filter((o) => !o.ok).map((o) => o.id);
  return { p1, p2, p3, failed };
}
