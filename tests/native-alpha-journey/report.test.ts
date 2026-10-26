import { describe, expect, it } from 'vitest';
import { canon, sha256Hex } from './common.ts';
import { runJourney, SHA } from './harness.ts';
import { parseReadback, serializeReadback } from './readback.ts';
import { FILE, parseReport, parseState, sealReport, serializeReport, verifyJourney, type Files } from './report.ts';
import type { Phase } from './config.ts';

async function goodFiles(): Promise<Files> {
  const j = await runJourney([], { foreign: true });
  const common = { deployedSha: SHA, host: 'native.example.invalid', caseId: 'case-journey-1', runId: '0123456789ab' };
  const human = sha256Hex(canon({ candidateId: j.p1.state!.candidateId, identity: j.p1.state!.identity }));
  const rep = (phase: Phase, obs: typeof j.p1.obs, extra: Partial<Parameters<typeof sealReport>[0]> = {}) => serializeReport(sealReport({ phase, ...common, observations: obs, readbackDigest: null, humanIdentitySha256: null, reviewerRef: null, verdictIfClean: 'PASS', ...extra }));
  const afterReadback = { ...j.p3!.readback! };
  return {
    [FILE.state]: `${JSON.stringify(j.p1.state, null, 1)}\n`,
    [FILE.readback]: serializeReadback(j.p2!.readback!), [FILE.after]: serializeReadback(afterReadback),
    [FILE.report('upload-import')]: rep('upload-import', j.p1.obs, { verdictIfClean: 'AWAITING-HUMAN-SIGNOFF' }),
    [FILE.report('signoff-publish')]: rep('signoff-publish', j.p2!.obs, { readbackDigest: j.p2!.readback!.digest, humanIdentitySha256: human, reviewerRef: 'Reviewer One' }),
    [FILE.report('after-restart')]: rep('after-restart', j.p3!.obs, { readbackDigest: afterReadback.digest }),
  };
}
const reseal = (o: Record<string, unknown>, patch: Record<string, unknown>) => { const { digest: _d, ...b } = { ...o, ...patch }; return { ...b, digest: sha256Hex(canon(b)) }; };
const edit = (files: Files, name: string, f: (o: Record<string, unknown>) => Record<string, unknown>) => {
  const doc = f(JSON.parse(files[name]!));
  return { ...files, [name]: name.startsWith('report') || name.startsWith('readback') ? `${canon(doc)}\n` : `${JSON.stringify(doc, null, 1)}\n` };
};

describe('the final journey verdict', () => {
  it('passes only when every phase file is present, exact and consistent', async () => {
    const v = verifyJourney(await goodFiles(), SHA);
    expect(v.kind).toBe('pass');
  });
  it('a missing phase file is a HOLD, never a pass', async () => {
    const files = await goodFiles();
    for (const name of Object.keys(files)) expect(verifyJourney({ ...files, [name]: null }, SHA).kind).toBe('hold');
  });
  it('another expected commit fails', async () => {
    expect(verifyJourney(await goodFiles(), 'b'.repeat(40)).kind).toBe('fail');
  });
  it('a hand-edited PASS over a failed observation is refused', async () => {
    const files = await goodFiles();
    const name = FILE.report('signoff-publish');
    const doc = JSON.parse(files[name]!);
    doc.observations[0].ok = false;
    const { digest: _d, ...body } = doc;
    const forged = { ...body, digest: sha256Hex(canon(body)) }; // resealed, still saying PASS
    const p = parseReport(`${canon(forged)}\n`);
    expect(p.ok).toBe(false);
    expect(!p.ok && p.problems.join()).toContain('verdict is not FAIL');
  });
  it('a failed observation makes a FAIL report, and a FAIL phase fails the journey', async () => {
    const j = await runJourney(['wrongOriginalBytes']);
    const r = sealReport({ phase: 'signoff-publish', deployedSha: SHA, host: 'native.example.invalid', caseId: 'case-journey-1', runId: '0123456789ab', observations: j.p2!.obs, readbackDigest: null, humanIdentitySha256: null, reviewerRef: null, verdictIfClean: 'PASS' });
    expect(r.verdict).toBe('FAIL');
    const files = { ...(await goodFiles()), [FILE.report('signoff-publish')]: serializeReport(r) };
    expect(verifyJourney(files, SHA).kind).toBe('fail');
  });
  it.each([
    ['the human confirmed a different identity', (f: Files) => edit(f, FILE.report('signoff-publish'), (o) => reseal(o, { humanIdentitySha256: '9'.repeat(64) }))],
    ['phase 2 names no reviewer', (f: Files) => edit(f, FILE.report('signoff-publish'), (o) => reseal(o, { reviewerRef: null }))],
    ['phase 3 ran against another host', (f: Files) => edit(f, FILE.report('after-restart'), (o) => reseal(o, { host: 'other.example.invalid' }))],
    ['phase 2 reports another run', (f: Files) => edit(f, FILE.report('signoff-publish'), (o) => reseal(o, { runId: 'ffffffffffff' }))],
  ])('refuses when %s', async (_n, mutate) => {
    expect(verifyJourney(mutate(await goodFiles()), SHA).kind).toBe('fail');
  });
  it('a state whose identity digest does not match its identity is refused', async () => {
    const files = await goodFiles();
    const bad = edit(files, FILE.state, (o) => ({ ...o, identity: { ...(o.identity as object), snapshotRevision: 'other' } }));
    expect(parseState(bad[FILE.state]!).ok).toBe(false);
    expect(verifyJourney(bad, SHA).kind).toBe('fail');
  });
  it('lost notes after the restart fail the journey even if both readbacks parse', async () => {
    const j = await runJourney(['notesLostOnRestart']);
    expect(j.failed).toContain('p3.readback-equal');
    expect(j.p3?.readback).toBeNull(); // a failed phase 3 writes no readback, so verification can only HOLD or FAIL
  });
  it('reports are refused whole when any text looks like a secret', () => {
    const r = sealReport({ phase: 'upload-import', deployedSha: SHA, host: 'native.example.invalid', caseId: 'case-1', runId: '0123456789ab', observations: [{ id: 'x', ok: true, status: 200, detail: 'sk_test_abcdefghijklmnop1234' }], readbackDigest: null, humanIdentitySha256: null, reviewerRef: null, verdictIfClean: 'PASS' });
    expect(parseReport(serializeReport(r)).ok).toBe(false);
  });
  it('the two readbacks of the good set parse', async () => {
    const f = await goodFiles();
    expect(parseReadback(f[FILE.readback]!).ok && parseReadback(f[FILE.after]!).ok).toBe(true);
  });
});
