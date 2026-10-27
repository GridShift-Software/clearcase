import { describe, expect, it } from 'vitest';
import { checkEvidenceItem, checkSnapshotV2, PREVIEW_STATES_V2, SECTION_STATES_V2, signoffBlockerV2 } from '../../../src/lib/publication/hosted/rules.ts';
import type { CandidateSnapshotV2, EvidenceCountGroup } from '../../../src/lib/publication/hosted/ports.ts';
import { snapshot } from '../../hosted-smoke/operator-workbench/fixtures.ts';

const group = (g: Partial<EvidenceCountGroup> & Pick<EvidenceCountGroup, 'kind'>): EvidenceCountGroup => ({ subject: null, state: null, reason: null, count: 1, ...g });
function v2(groups: EvidenceCountGroup[], extra: { verdict?: 'accept' | 'report' | 'reject'; newWarnings?: number } = {}): CandidateSnapshotV2 {
  const v1 = snapshot();
  return { format: 'clearcase.candidate-snapshot/2', link: v1.link, preparedBy: v1.preparedBy, snapshotRevision: v1.snapshotRevision,
    validation: { verdict: extra.verdict ?? 'report', validatorVersion: v1.validation.validatorVersion, diagnosticsSha256: v1.validation.diagnosticsSha256 },
    evidence: { generation: '1', root: 'a'.repeat(64), items: groups.reduce((n, g) => n + g.count, 0), groups, newWarnings: extra.newWarnings ?? 0 } };
}
const section = (subject: string, state: string) => group({ kind: 'section', subject, state });

describe('the v2 state set', () => {
  it('names records-rendered (U6) and disagrees (U12) next to the v1 states', () => {
    expect([...SECTION_STATES_V2].sort()).toEqual(['disagrees', 'integrity-verified', 'invalid', 'missing', 'records-rendered', 'unsupported', 'valid']);
    expect([...PREVIEW_STATES_V2].sort()).toEqual(['failed', 'pending', 'rendered']);
  });
  it('clears valid and records-rendered, clears integrity-verified only for an integrity key, and holds the rest', () => {
    const blocker = (...sections: [string, string][]) => signoffBlockerV2(checkSnapshotV2(v2(sections.map(([k, s]) => section(k, s))))!);
    expect(blocker(['quantum', 'valid'], ['interest', 'records-rendered'])).toBeNull();
    expect(blocker(['meta', 'integrity-verified'])).toBeNull();
    expect(blocker(['quantum', 'integrity-verified'])).toEqual({ code: 'required-section', detail: ['quantum:integrity-verified'] });
    for (const state of ['disagrees', 'invalid', 'unsupported', 'missing']) expect(blocker(['quantum', state])).toEqual({ code: 'required-section', detail: [`quantum:${state}`] });
  });
  it('orders its blockers as v1 does: validation, then sections, then previews', () => {
    const groups = [group({ kind: 'error', count: 2 }), section('quantum', 'invalid'), group({ kind: 'preview', state: 'failed', reason: 'render-timeout', count: 3 })];
    const s = checkSnapshotV2(v2(groups))!;
    expect(signoffBlockerV2(s)).toEqual({ code: 'validation-failed', detail: ['errors=2'] });
    expect(signoffBlockerV2(checkSnapshotV2(v2(groups.slice(1)))!)).toEqual({ code: 'required-section', detail: ['quantum:invalid'] });
    expect(signoffBlockerV2(checkSnapshotV2(v2(groups.slice(2)))!)).toEqual({ code: 'preview-not-ready', detail: ['failed:render-timeout=3'] });
    expect(signoffBlockerV2(checkSnapshotV2(v2([], { verdict: 'reject' }))!)).toEqual({ code: 'validation-failed', detail: ['errors=0'] });
    expect(signoffBlockerV2(checkSnapshotV2(v2([group({ kind: 'preview', state: 'rendered', count: 1689 }), group({ kind: 'warning', count: 2500 })], { newWarnings: 2500 }))!)).toBeNull();
  });
});

describe('checkSnapshotV2', () => {
  it('accepts exactly the documented shape and nothing beside it', () => {
    const ok = v2([section('quantum', 'valid')]);
    expect(checkSnapshotV2(ok)).toEqual(ok);
    expect(checkSnapshotV2({ ...ok, ready: true })).toBeNull();
    expect(checkSnapshotV2({ ...ok, trustedBaseline: [] })).toBeNull();
    expect(checkSnapshotV2({ ...ok, evidence: { ...ok.evidence, extra: 1 } })).toBeNull();
    expect(checkSnapshotV2({ ...ok, format: 'clearcase.candidate-snapshot/1' })).toBeNull();
    expect(checkSnapshotV2(snapshot())).toBeNull();
  });
  it.each([
    ['an unknown section state', [section('quantum', 'approved')]],
    ['an unknown preview state', [group({ kind: 'preview', state: 'approved' })]],
    ['a rendered preview with a reason', [group({ kind: 'preview', state: 'rendered', reason: 'render-timeout' })]],
    ['a preview reason outside the fixed list', [group({ kind: 'preview', state: 'failed', reason: 'because I said so' })]],
    ['a section with no subject', [group({ kind: 'section', state: 'valid' })]],
    ['a preview with a subject', [group({ kind: 'preview', state: 'failed', subject: 'asset' })]],
    ['a warning with a state', [group({ kind: 'warning', state: 'valid' })]],
    ['an unknown kind', [group({ kind: 'original' as 'warning' })]],
    ['a zero count', [group({ kind: 'warning', count: 0 })]],
    ['a fractional count', [group({ kind: 'warning', count: 1.5 })]],
    ['a repeated group', [group({ kind: 'warning' }), group({ kind: 'warning' })]],
  ])('refuses %s', (_name, groups) => {
    const s = v2(groups);
    expect(checkSnapshotV2({ ...s, evidence: { ...s.evidence, items: groups.reduce((n, g) => n + (Number.isInteger(g.count) ? g.count : 1), 0) } })).toBeNull();
  });
  it('refuses counts that do not add up to the item total, new warnings beyond the warnings, and a malformed root', () => {
    const ok = v2([group({ kind: 'warning', count: 5 })], { newWarnings: 5 });
    expect(checkSnapshotV2(ok)).not.toBeNull();
    expect(checkSnapshotV2({ ...ok, evidence: { ...ok.evidence, items: 6 } })).toBeNull();
    expect(checkSnapshotV2({ ...ok, evidence: { ...ok.evidence, newWarnings: 6 } })).toBeNull();
    expect(checkSnapshotV2({ ...ok, evidence: { ...ok.evidence, root: 'xyz' } })).toBeNull();
  });
});

describe('checkEvidenceItem', () => {
  const input = { caseId: 'c', clientId: 'k', manifestSha256: 'm', rendererVersion: 'r', resultsVersion: 'v', validatorVersion: 'x' };
  const row = (key: string, observation: unknown, i: unknown = input) => ({ key, json: JSON.stringify({ input: i, observation }), baseline: null });
  const bound = { resultsVersion: 'v', manifestSha256: 'm', clientId: 'k', caseId: 'c' };
  it('accepts each kind under its own key prefix and nothing else', () => {
    expect(checkEvidenceItem(row('preview/a1', { kind: 'preview', assetId: 'a1', state: 'rendered' }), bound)).toEqual({ key: 'preview/a1', observation: { kind: 'preview', assetId: 'a1', state: 'rendered' } });
    expect(checkEvidenceItem({ ...row('warning/' + 'b'.repeat(32), { kind: 'warning', fingerprint: 'b'.repeat(32) }), baseline: false }, bound)?.observation.kind).toBe('warning');
    expect(checkEvidenceItem(row('preview/a1', { kind: 'warning', fingerprint: 'b'.repeat(32) }), bound)).toBeNull();
    expect(checkEvidenceItem(row('preview/a2', { kind: 'preview', assetId: 'a1', state: 'rendered' }), bound)).toBeNull();
    expect(checkEvidenceItem(row('preview/a1', { kind: 'preview', assetId: 'a1', state: 'rendered', extra: 1 }), bound)).toBeNull();
    expect(checkEvidenceItem(row('preview/a1', { kind: 'preview', assetId: 'a1', state: 'rendered' }, { ...input, resultsVersion: 'other' }), bound)).toBeNull();
  });
  it('marks a warning absent from the baseline as needing an acknowledgement', () => {
    const w = (baseline: boolean | null) => ({ ...row('warning/' + 'b'.repeat(32), { kind: 'warning', fingerprint: 'b'.repeat(32) }), baseline });
    expect(checkEvidenceItem(w(false), bound)?.acknowledgementRequired).toBe(true);
    expect(checkEvidenceItem(w(true), bound)?.acknowledgementRequired).toBe(false);
    expect(checkEvidenceItem(w(null), bound)).toBeNull();
    expect(checkEvidenceItem({ ...row('preview/a1', { kind: 'preview', assetId: 'a1', state: 'rendered' }), baseline: true }, bound)).toBeNull();
  });
});
