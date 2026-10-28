// Sprint ticket 06, review finding M3: sign-offs are attestations. An exact replay reports idempotent success; another
// signer, or the same signer with another acknowledgement set, appends a separately identified attestation and never
// disturbs the first. This is how the owner signs a version an agent signed first.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { publish, register } from '../../../scripts/publish/publish.ts';
import { signoff } from '../../../scripts/publish/signoff.ts';
import { acksFor, AT, builtCase, client, manifestOf, missing, SIGNER, type BuiltCase } from './world.ts';

const OWNER = 'owner@example.invalid';
let b: BuiltCase;
beforeAll(async () => { b = await builtCase(); }, 120_000);
afterAll(() => b?.cleanup());
async function registered() {
  const dep = client();
  await register(dep.d1, b.built.record, { at: AT, acknowledgedMissing: missing(b.built), manifest: manifestOf(b) });
  return dep;
}
const rows = (dep: ReturnType<typeof client>) => dep.db.sqlite.prepare('SELECT signoff_id, signer, acknowledgements_json, signed_at FROM pub_shard_signoff ORDER BY signoff_id').all() as { signoff_id: number; signer: string; acknowledgements_json: string; signed_at: string }[];

describe('06 sign-off attestations', () => {
  test('an exact replay reports idempotent success and records nothing new', async () => {
    const dep = await registered(), r = b.built.record;
    const first = await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT });
    const again = await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: '2001-05-05T00:00:00.000Z' });
    expect(first.replayed).toBe(false);
    expect(again).toEqual({ ...first, replayed: true });
    expect(rows(dep)).toEqual([expect.objectContaining({ signoff_id: first.id, signer: SIGNER, signed_at: AT })]);
  });

  test('another signer on the same manifest appends a separately identified attestation; the first stays', async () => {
    const dep = await registered(), r = b.built.record;
    const agent = await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT });
    const owner = await signoff(dep.d1, r, { signer: OWNER, acks: acksFor(b.built).map((a) => `${a.split('=')[0]}=reviewed by the owner`), at: '2001-06-06T00:00:00.000Z' });
    expect(owner.replayed).toBe(false);
    expect(owner.id).not.toBe(agent.id);
    expect(owner.signers).toEqual([SIGNER, OWNER]);
    expect(rows(dep).map((x) => [x.signoff_id, x.signer])).toEqual([[agent.id, SIGNER], [owner.id, OWNER]]);
    expect(JSON.parse(rows(dep)[0]!.acknowledgements_json)).toEqual(agent.acknowledgements);
    await publish(dep.d1, r, { remoteManifest: manifestOf(b), at: AT });
  });

  test('the same signer with another acknowledgement set appends its own attestation', async () => {
    const dep = await registered(), r = b.built.record;
    const one = await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built), at: AT });
    const two = await signoff(dep.d1, r, { signer: SIGNER, acks: acksFor(b.built).map((a) => `${a.split('=')[0]}=a second reading`), at: AT });
    expect([two.replayed, two.id === one.id, rows(dep).length]).toEqual([false, false, 2]);
  });
});
