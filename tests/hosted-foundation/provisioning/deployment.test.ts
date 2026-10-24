// GRS-114 fix round 1: the strict deployment tuple (host, Worker, D1 id and name, R2 bucket) fails closed.
import { describe, expect, it } from 'vitest';
import { resolveDeployment, resolveExactDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { MANIFEST } from './world.ts';

const A = MANIFEST.clients[0]!, C = MANIFEST.clients[1]!, m = validateClientManifest(MANIFEST);
const tuple = { clientId: A.clientId, hostname: A.hostname, worker: A.worker, d1DatabaseId: A.d1DatabaseId, d1DatabaseName: A.d1DatabaseName, r2Bucket: A.r2Bucket };
const code = (c: string) => expect.objectContaining({ code: c });

describe('resolveExactDeployment', () => {
  it('resolves only the full, exact tuple', () => {
    expect(resolveExactDeployment(m, tuple)).toMatchObject({ clientId: 'client-a', hostname: A.hostname, d1DatabaseName: A.d1DatabaseName, clientIssuer: A.clientIssuer });
  });
  it('refuses any foreign host, Worker, D1 id or name, or bucket, and any case or whitespace variant', () => {
    for (const key of ['hostname', 'worker', 'd1DatabaseId', 'd1DatabaseName', 'r2Bucket'] as const) {
      expect(() => resolveExactDeployment(m, { ...tuple, [key]: C[key] }), key).toThrow(code('resource-mismatch'));
    }
    for (const bad of [{ hostname: A.hostname.toUpperCase() }, { hostname: ` ${A.hostname}` }, { worker: `${A.worker} ` }]) expect(() => resolveExactDeployment(m, { ...tuple, ...bad })).toThrow(code('resource-mismatch'));
  });
  it('refuses a missing, empty, extra or non-string resource, and an unknown client', () => {
    for (const key of Object.keys(tuple)) {
      const { [key]: _gone, ...rest } = tuple as Record<string, string>;
      expect(() => resolveExactDeployment(m, rest as never), key).toThrow(code('resource-mismatch'));
      expect(() => resolveExactDeployment(m, { ...tuple, [key]: '' }), key).toThrow(code('resource-mismatch'));
      expect(() => resolveExactDeployment(m, { ...tuple, [key]: 1 as never }), key).toThrow(code('resource-mismatch'));
    }
    expect(() => resolveExactDeployment(m, { ...tuple, extra: 'x' } as never)).toThrow(code('resource-mismatch'));
    expect(() => resolveExactDeployment(m, null as never)).toThrow(code('resource-mismatch'));
    expect(() => resolveExactDeployment(m, { ...tuple, clientId: 'client-z' })).toThrow(code('unknown-client'));
  });
  it('the lenient resolver still refuses a foreign host or D1 name when one is supplied', () => {
    const { hostname, d1DatabaseName, ...legacy } = tuple;
    expect(resolveDeployment(m, legacy)).toMatchObject({ clientId: 'client-a' });
    expect(() => resolveDeployment(m, { ...legacy, hostname: C.hostname })).toThrow(code('resource-mismatch'));
    expect(() => resolveDeployment(m, { ...legacy, d1DatabaseName: C.d1DatabaseName })).toThrow(code('resource-mismatch'));
    expect([hostname, d1DatabaseName]).toHaveLength(2);
  });
});
