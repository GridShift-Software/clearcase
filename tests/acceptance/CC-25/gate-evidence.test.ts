// PR #76 review, GRS-24 item 1: the gate summaries count as v5 evidence only when they record a passing outcome, not
// only that the run was eligible evidence. Scorecard and lanes fixtures are invented; field names are the real ones
// (scripts/parity/lib/compare.mjs, tests/e2e/pilot/v5-lanes.mjs).
import { describe, expect, it } from 'vitest';
import { gateEvidenceProblems } from './gate-evidence.ts';

const HEAD = 'a'.repeat(40);
const SCORECARD = 'parity --all --strict-register';
const LANES = 'verify:pilot:v5';
const passingScorecard = () => ({
  evidence: true, freshBuild: { head: HEAD }, result: 'PASS', exit: 0, aborted: null, register: { strict: true },
  total: { views: 42, viewsExtractedV5: 42, viewsComparedApp: 42, viewsNotImplemented: 0, viewsExtractError: 0, viewsFailed: 0, unregistered: 0 },
});
const passingLanes = () => ({ ok: true, evidence: true, freshBuild: { head: HEAD }, aborted: null, lanes: [{ id: 1, status: 'PASS' }, { id: 2, status: 'PASS' }] });
const without = (doc: any, ...keys: string[]) => { const d = structuredClone(doc); for (const k of keys) delete d[k]; return d; };

describe('gate-v5 evidence: the parity scorecard', () => {
  it('accepts a passing strict scorecard for HEAD (positive control)', () => {
    expect(gateEvidenceProblems(SCORECARD, passingScorecard(), HEAD)).toEqual([]);
  });

  it('rejects a current-head scorecard that records result FAIL and exit 1', () => {
    const doc = { ...passingScorecard(), result: 'FAIL', exit: 1 };
    expect(gateEvidenceProblems(SCORECARD, doc, HEAD)).not.toEqual([]);
  });

  it('rejects a scorecard with no recorded outcome (neither result nor exit)', () => {
    expect(gateEvidenceProblems(SCORECARD, without(passingScorecard(), 'result', 'exit'), HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(SCORECARD, without(passingScorecard(), 'result'), HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(SCORECARD, without(passingScorecard(), 'exit'), HEAD)).not.toEqual([]);
  });

  it('rejects an incomplete scorecard: fewer than 42 views, extracted or compared; any not implemented, failed or unregistered', () => {
    const t = passingScorecard().total;
    for (const total of [
      { ...t, views: 41 }, { ...t, viewsExtractedV5: 41 }, { ...t, viewsComparedApp: 41 }, { ...t, viewsNotImplemented: 1 },
      { ...t, viewsExtractError: 1 }, { ...t, viewsFailed: 1 }, { ...t, unregistered: 1 },
    ]) expect(gateEvidenceProblems(SCORECARD, { ...passingScorecard(), total }, HEAD), JSON.stringify(total)).not.toEqual([]);
    expect(gateEvidenceProblems(SCORECARD, without(passingScorecard(), 'total'), HEAD)).not.toEqual([]);
  });

  it('rejects a scorecard from a run that was not strict about the register, or was aborted', () => {
    expect(gateEvidenceProblems(SCORECARD, { ...passingScorecard(), register: { strict: false } }, HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(SCORECARD, without(passingScorecard(), 'register'), HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(SCORECARD, { ...passingScorecard(), aborted: { reason: 'invented' } }, HEAD)).not.toEqual([]);
  });

  it('still rejects a passing scorecard for another head, or one that is not evidence', () => {
    expect(gateEvidenceProblems(SCORECARD, { ...passingScorecard(), freshBuild: { head: 'b'.repeat(40) } }, HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(SCORECARD, { ...passingScorecard(), evidence: false }, HEAD)).not.toEqual([]);
  });
});

describe('gate-v5 evidence: the pilot lanes summary', () => {
  it('accepts a passing lanes summary for HEAD (positive control)', () => {
    expect(gateEvidenceProblems(LANES, passingLanes(), HEAD)).toEqual([]);
  });

  it('rejects a lanes summary with no ok, ok false, a failed lane, no lanes, or an abort', () => {
    expect(gateEvidenceProblems(LANES, without(passingLanes(), 'ok'), HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(LANES, { ...passingLanes(), ok: false }, HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(LANES, { ...passingLanes(), lanes: [{ id: 1, status: 'PASS' }, { id: 2, status: 'FAIL' }] }, HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(LANES, { ...passingLanes(), lanes: [] }, HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(LANES, without(passingLanes(), 'lanes'), HEAD)).not.toEqual([]);
    expect(gateEvidenceProblems(LANES, { ...passingLanes(), aborted: { reason: 'invented' } }, HEAD)).not.toEqual([]);
  });
});
