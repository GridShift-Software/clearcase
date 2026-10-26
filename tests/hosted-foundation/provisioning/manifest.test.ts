import { describe, expect, it } from 'vitest';
import { resolveDeployment, validateClientManifest } from '../../../src/lib/tenancy/manifest.ts';
import { MANIFEST } from './world.ts';

const entry = (n: string) => ({ clientId: `client-${n}`, hostname: `${n}.clearcase.example.test`, worker: `clearcase-client-${n}`, d1DatabaseId: `00000000-0000-4000-8000-0000000000${n.padStart(2, '0')}`, d1DatabaseName: `clearcase-client-${n}`, r2Bucket: `clearcase-client-${n}`, clientIssuer: `https://client-${n}.example.test` });
const A = MANIFEST.clients[0]!;
const tuple = { clientId: A.clientId, worker: A.worker, d1DatabaseId: A.d1DatabaseId, r2Bucket: A.r2Bucket };

describe('client resource manifest', () => {
  it('validates any number of fully separate clients', () => {
    const many = { staffIssuer: MANIFEST.staffIssuer, clients: ['1', '2', '3', '4', '5'].map(entry) };
    expect(validateClientManifest(many).clients).toHaveLength(5);
    expect(validateClientManifest(MANIFEST).clients.map((c) => c.clientId)).toEqual(['client-a', 'client-c']);
  });
  it('refuses any Worker, database, bucket, hostname or issuer shared between clients, or with staff', () => {
    for (const key of ['clientId', 'hostname', 'worker', 'd1DatabaseId', 'd1DatabaseName', 'r2Bucket', 'clientIssuer'] as const) {
      const clients = [entry('1'), { ...entry('2'), [key]: entry('1')[key] }];
      expect(() => validateClientManifest({ staffIssuer: MANIFEST.staffIssuer, clients }), key).toThrow(expect.objectContaining({ code: 'duplicate-resource' }));
    }
    expect(() => validateClientManifest({ staffIssuer: entry('1').clientIssuer, clients: [entry('1')] })).toThrow(expect.objectContaining({ code: 'duplicate-resource' }));
  });
  it('refuses malformed and extra fields, non-https or pathful issuers and an empty list', () => {
    for (const bad of [{ ...entry('1'), extra: 1 }, { ...entry('1'), clientIssuer: 'http://client-1.example.test' }, { ...entry('1'), clientIssuer: 'https://client-1.example.test/x' }, { ...entry('1'), d1DatabaseId: 'not-a-uuid' }, { ...entry('1'), clientId: 'Client_1' }]) {
      expect(() => validateClientManifest({ staffIssuer: MANIFEST.staffIssuer, clients: [bad] })).toThrow(expect.objectContaining({ code: 'invalid-manifest' }));
    }
    expect(() => validateClientManifest({ staffIssuer: MANIFEST.staffIssuer, clients: [] })).toThrow(expect.objectContaining({ code: 'invalid-manifest' }));
    expect(() => validateClientManifest({ staffIssuer: MANIFEST.staffIssuer, clients: [entry('1')], more: true })).toThrow(expect.objectContaining({ code: 'invalid-manifest' }));
  });
  it('resolves a deployment only when its Worker, D1 and R2 are exactly its own client\'s', () => {
    const m = validateClientManifest(MANIFEST), C = MANIFEST.clients[1]!;
    expect(resolveDeployment(m, tuple)).toMatchObject({ clientId: 'client-a', clientIssuer: A.clientIssuer, staffIssuer: MANIFEST.staffIssuer });
    for (const key of ['worker', 'd1DatabaseId', 'r2Bucket'] as const) {
      expect(() => resolveDeployment(m, { ...tuple, [key]: C[key] }), key).toThrow(expect.objectContaining({ code: 'resource-mismatch' }));
    }
    expect(() => resolveDeployment(m, { ...tuple, clientId: 'client-z' })).toThrow(expect.objectContaining({ code: 'unknown-client' }));
  });
});
