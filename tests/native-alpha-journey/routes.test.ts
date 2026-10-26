import { describe, expect, it } from 'vitest';
import { DEFAULT_PORTS, UNRESOLVED_PORTS, expand, pointer, resolveRoutes } from './routes.ts';
import { simRoutes } from './world.ts';

describe('the route contract never invents a route', () => {
  it('without a routes file, every port with no accepted document is unresolved', () => {
    const r = resolveRoutes(null);
    expect(r.problems).toEqual([]);
    expect(r.unresolved).toEqual([...UNRESOLVED_PORTS]);
    expect(Object.keys(r.ports)).toEqual(Object.keys(DEFAULT_PORTS));
  });
  it('a supplied file resolves the missing ports and keeps the defaults', () => {
    const r = resolveRoutes(simRoutes);
    expect(r.problems).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect(r.ports['case.page']?.path).toBe('/cases/{caseId}');
  });
  it.each([
    ['a route that looks like a test login', { 'operator.preview': { method: 'GET', path: '/dev-login/{caseId}/{candidateId}' } }],
    ['a route through an identity double', { 'operator.preview': { method: 'GET', path: '/test/double/{caseId}' } }],
    ['an absolute URL (another origin)', { 'operator.preview': { method: 'GET', path: 'https://evil.example/x' } }],
    ['a protocol-relative URL', { 'operator.preview': { method: 'GET', path: '//evil.example/x' } }],
    ['a path traversal', { 'operator.preview': { method: 'GET', path: '/operator/../health' } }],
    ['an unknown placeholder', { 'operator.preview': { method: 'GET', path: '/operator/{secret}' } }],
    ['a query that is not a form action', { 'operator.preview': { method: 'GET', path: '/operator/x?token=1' } }],
    ['an unknown port', { 'operator.magic': { method: 'GET', path: '/operator/magic' } }],
    ['an unknown field', { 'operator.preview': { method: 'GET', path: '/operator/{caseId}', headers: { cookie: 'x' } } }],
    ['a method outside the contract', { 'operator.preview': { method: 'DELETE', path: '/operator/{caseId}' } }],
  ])('refuses %s', (_name, ports) => {
    const r = resolveRoutes({ schema: 'clearcase.native-journey-routes/1', ports });
    expect(r.problems.length).toBeGreaterThan(0);
  });
  it('refuses a file of the wrong schema and a port that omits a required capture', () => {
    expect(resolveRoutes({ schema: 'x', ports: {} }).problems.length).toBeGreaterThan(0);
    const noCaps = resolveRoutes({ schema: 'clearcase.native-journey-routes/1', ports: { 'operator.import': { method: 'POST', path: '/operator/results/{caseId}/import' } } });
    expect(noCaps.problems.join()).toContain('capture candidateId');
    const noActor = resolveRoutes({ schema: 'clearcase.native-journey-routes/1', ports: { 'recovery.export': { method: 'GET', path: '/operator/recovery/{caseId}/export' } } });
    expect(noActor.problems.join()).toContain('must name its actor');
  });
});

describe('expand and pointer', () => {
  it('encodes each value as one segment and refuses a missing one', () => {
    expect(expand('/cases/{caseId}/originals/{assetId}', { caseId: 'c1', assetId: 'a/../b' })).toBe('/cases/c1/originals/a%2F..%2Fb');
    expect(() => expand('/cases/{caseId}', {})).toThrow('needs {caseId}');
  });
  it('reads RFC 6901 pointers and returns undefined for an absent one', () => {
    const doc = { a: { 'b/c': [1, { d: 'x' }] } };
    expect(pointer(doc, '/a/b~1c/1/d')).toBe('x');
    expect(pointer(doc, '/a/missing')).toBeUndefined();
    expect(pointer(doc, '/a/b~1c/9')).toBeUndefined();
  });
});
