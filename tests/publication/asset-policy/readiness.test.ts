import { describe, expect, it } from 'vitest';
import { createPublicationReadiness } from '../../../src/lib/publication/hosted/readiness.ts';
import { assetPolicySummary, assetPolicyWording } from '../../../src/lib/publication/hosted/asset-policy.ts';
import { worldV2 } from '../readiness-v2/harness.ts';
import { CITED_MISSING, DOCX_NO_PREVIEW, EMBEDDED, PDF_RENDERED, UNCITED_MISSING, buildAssetEvidence } from './harness.ts';
import type { AssetPolicyInput } from '../../../src/lib/publication/hosted/asset-policy.ts';

// Unit U10, the readiness view: what the publisher reads for each policy state, and that no acknowledgement is ever counted as an observation.
type Line = { key: string; title: string; detail: string; clearsBy: string; count: number };
type Note = { key: string; title: string; assetId: string; clearsBy: string };
type Body = { blocker: { code: string; detail: string[] } | null; acknowledgementsRequired: number; assets: Line[];
  evidence: { groups: { kind: string; state: string | null; reason: string | null; count: number }[]; items: number };
  page: { items: { key: string; observation: Record<string, unknown>; acknowledgementRequired?: boolean; policy?: Note }[]; next: string | null } };

async function read(inputs: readonly AssetPolicyInput[], params: Record<string, string> = {}): Promise<Body> {
  const w = worldV2(await buildAssetEvidence(inputs), { pageSize: 100 });
  const response = await createPublicationReadiness(w.ports).read(w.request(params));
  expect(response.status).toBe(200);
  return await response.json() as Body;
}

describe('the readiness view says what each policy state means', () => {
  it('lists every state present, once, with its count and the wording the publisher reads', async () => {
    const body = await read([UNCITED_MISSING, CITED_MISSING, EMBEDDED, DOCX_NO_PREVIEW, PDF_RENDERED]);
    expect(body.assets.map((l) => [l.key, l.count, l.clearsBy])).toEqual([
      ['original-not-supplied', 1, 'acknowledgement'], ['preview-required', 1, 'upstream-fix'], ['embedded-not-extracted', 1, 'upstream-fix'], ['supplied-references', 1, 'upstream-fix']]);
    expect(body.assets.map((l) => l.title)).toEqual(['Original not supplied', 'Preview required', 'Attachment not extracted', 'Required original not available']);
    for (const line of body.assets) expect(line).toMatchObject({ detail: assetPolicyWording(line.key as never).detail });
    expect(body.assets[0]!.detail).toBe('The converter found no original for this document and nothing in the results cites it. The client will not be able to open it. Acknowledge each with a reason to publish without it.');
    expect(body.assets[1]!.detail).toContain('cannot be acknowledged');
    expect(body.assets[2]!.detail).toContain('extract it as a file');
    expect(body.assets[3]!.detail).toContain('The original for this asset is not available');
    expect(body.assets[3]!.detail).toContain('may point at it');
  });

  it('holds with the three reasons named, and does not hold for the uncited missing original', async () => {
    const all = await read([UNCITED_MISSING, CITED_MISSING, EMBEDDED, DOCX_NO_PREVIEW, PDF_RENDERED]);
    expect(all.blocker?.code).toBe('preview-not-ready');
    expect([...all.blocker!.detail].sort()).toEqual(['failed:embedded-not-extracted=1', 'failed:preview-required=1', 'failed:supplied-references=1']);
    const only = await read([UNCITED_MISSING, PDF_RENDERED]);
    expect(only.blocker).toBeNull();
    // The sign-off still asks for a reason for it: the validator's own warning and the policy's bound one.
    expect(only.acknowledgementsRequired).toBe(2);
    expect(only.assets).toEqual([expect.objectContaining({ key: 'original-not-supplied', count: 1, clearsBy: 'acknowledgement' })]);
  });

  it('says nothing about a candidate whose assets are all shown', async () => {
    const body = await read([PDF_RENDERED]);
    expect(body.assets).toEqual([]);
    expect(body.blocker).toBeNull();
    expect(body.acknowledgementsRequired).toBe(0);
  });

  it('annotates the items: the held preview and the missing original each say which asset and what to do', async () => {
    const inputs = [UNCITED_MISSING, CITED_MISSING, EMBEDDED, DOCX_NO_PREVIEW, PDF_RENDERED];
    const previews = (await read(inputs, { kind: 'preview' })).page.items;
    expect(previews.map((i) => [i.key, i.policy?.key ?? null])).toEqual([
      ['preview/SY-0002', 'supplied-references'], ['preview/SY-0003.a1', 'embedded-not-extracted'], ['preview/SY-0004', 'preview-required'], ['preview/SY-0005', null]]);
    expect(previews.find((i) => i.key === 'preview/SY-0003.a1')!.policy).toMatchObject({ assetId: 'SY-0003.a1', title: 'Attachment not extracted', clearsBy: 'upstream-fix' });
  });

  it('puts the cited missing original in the held set, not among the originals that were not supplied', async () => {
    const body = await read([CITED_MISSING]);
    expect(body.page.items.find((i) => i.key === 'preview/SY-0002')).toMatchObject({ observation: { state: 'failed', reasonCode: 'supplied-references' }, policy: { key: 'supplied-references', assetId: 'SY-0002' } });
    expect(body.assets.map((l) => l.key)).toEqual(['supplied-references']);
  });

  it('annotates the warning of a missing original with its asset, and no other warning', async () => {
    const warnings = (await read([UNCITED_MISSING, PDF_RENDERED], { kind: 'warning' })).page.items;
    expect(warnings).toHaveLength(2);
    const [bound] = warnings.filter((i) => i.policy);
    expect(bound).toMatchObject({ acknowledgementRequired: true, policy: { key: 'original-not-supplied', title: 'Original not supplied', assetId: 'SY-0001', clearsBy: 'acknowledgement' } });
    expect(warnings.filter((i) => !i.policy)).toHaveLength(1);
  });
});

describe('an acknowledgement is not an observation', () => {
  it('the uncited missing original leaves the preview set: no preview item or preview count stands for it', async () => {
    const body = await read([UNCITED_MISSING, PDF_RENDERED]);
    expect(body.evidence.groups.filter((g) => g.kind === 'preview')).toEqual([{ kind: 'preview', subject: null, state: 'rendered', reason: null, count: 1 }]);
    expect(body.evidence.groups.filter((g) => g.kind === 'original')).toEqual([]);
  });

  it('counts its warning as a missing original, apart from every ordinary warning', async () => {
    const body = await read([UNCITED_MISSING, PDF_RENDERED]);
    expect(body.evidence.groups.filter((g) => g.kind === 'warning')).toEqual([
      { kind: 'warning', subject: null, state: null, reason: null, count: 1 }, { kind: 'warning', subject: null, state: 'original-not-supplied:warned', reason: null, count: 1 }]);
  });

  it('summarises from counts alone, so a state with a different kind or reason is never read as a policy state', () => {
    const g = (kind: string, state: string | null, reason: string | null, count: number) => ({ kind, subject: null, state, reason, count }) as never;
    expect(assetPolicySummary([g('preview', 'failed', 'render-timeout', 4), g('preview', 'pending', 'preview-required', 2), g('preview', 'rendered', null, 9), g('section', 'failed', null, 1), g('warning', null, null, 7), g('original', null, null, 3)])).toEqual([]);
    expect(assetPolicySummary([g('preview', 'failed', 'preview-required', 2), g('preview', 'failed', 'preview-required', 3)])).toEqual([expect.objectContaining({ key: 'preview-required', count: 5 })]);
  });
});
