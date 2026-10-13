import { describe, expect, it } from 'vitest';
import { isAssetKey, isRef, parseCitationToken, REF_IN_TEXT } from '../../src/lib/case-package/refs.ts';

describe('ref grammar', () => {
  it('accepts the v5 refs and the newer two-segment refs', () => {
    for (const r of ['OD-001', 'EM-0001', 'DC-FLX-001', 'CO-CLA-1078', 'DC-CT2-001']) expect(isRef(r), r).toBe(true);
    for (const r of ['DC-FLX-001', 'DC-CT2-001']) expect(isAssetKey(r), r).toBe(true);
    expect(isAssetKey('DC-FLX-001.a2')).toBe(true);
  });
  it('refuses lower case, a digit-led middle segment, a third segment and package-file keys', () => {
    for (const r of ['dc-flx-001', 'DC-2CT-001', 'DC-FLX-SUB-001', 'DC-FLX-', 'P-0123456789abcdef', 'DC-FLX-001 ']) expect(isRef(r), r).toBe(false);
    expect(isAssetKey('P-0123456789abcdef')).toBe(true);
  });
  it('reads whole two-segment refs out of free text and citation tokens', () => {
    // free text is a heuristic: inside a three-segment token the last two segments still read as a ref
    expect('see DC-FLX-001 and OD-002, not DC-FLX-SUB-003'.match(REF_IN_TEXT)).toEqual(['DC-FLX-001', 'OD-002', 'FLX-SUB-003']);
    expect(parseCitationToken('DC-FLX-001#p3')).toEqual({ ref: 'DC-FLX-001', page: 3 });
    expect(parseCitationToken('DC-FLX-001')).toEqual({ ref: 'DC-FLX-001', page: null });
  });
});
