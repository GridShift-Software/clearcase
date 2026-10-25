import type { CaseId, Identity } from '../../server/runtime/contracts.ts';
import { id } from '../../server/runtime/ids.ts';
import type { SubmissionManifest } from '../ports.ts';
import type { OperatorDownloadPorts } from './ports.ts';

export interface OperatorRequest { request: Request; url: URL; params: Partial<Record<'caseId' | 'operationId', string>>; identity: Identity }
export interface OperatorSubmissionView { operationId: string; manifest: SubmissionManifest; manifestHref: string; downloadHref: string }

// RED skeleton: the naive happy path only (identity read access, whatever row exists, no capability, no audit).
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export function createOperatorDownloadController(ports: OperatorDownloadPorts | null) {
  async function scope(r: OperatorRequest) {
    if (!ports || !ports.repository || !ports.assets) return null;
    if (r.identity.kind !== 'verified') return null;
    const caseId = id('case', r.params.caseId ?? '') as CaseId;
    await r.identity.authorize({ caseId, operation: 'read-original' });
    return { caseId, s: { clientId: ports.clientId, caseId } };
  }
  const view = (m: SubmissionManifest): OperatorSubmissionView => ({ operationId: m.operationId, manifest: m, manifestHref: `/operator/submissions/${m.caseId}/finalized/${m.operationId}/manifest`, downloadHref: `/operator/submissions/${m.caseId}/finalized/${m.operationId}/download` });
  return {
    list: async (r: OperatorRequest) => {
      const a = await scope(r).catch(() => null);
      if (!a || !ports) return json(503, { code: 'operator-download-unavailable' });
      const rows = await ports.repository!.list(a.s);
      return json(200, { submissions: rows.filter((x) => x.manifest).map((x) => view(x.manifest!)) });
    },
    read: async (r: OperatorRequest) => {
      const a = await scope(r).catch(() => null);
      if (!a || !ports) return json(503, { code: 'operator-download-unavailable' });
      const m = await ports.repository!.revision({ ...a.s, operationId: r.params.operationId ?? '' });
      return m ? json(200, view(m)) : json(404, { code: 'not-found' });
    },
    manifest: async (r: OperatorRequest) => {
      const a = await scope(r).catch(() => null);
      if (!a || !ports) return json(503, { code: 'operator-download-unavailable' });
      const m = await ports.repository!.revision({ ...a.s, operationId: r.params.operationId ?? '' });
      return m ? json(200, m) : json(404, { code: 'not-found' });
    },
    download: async (r: OperatorRequest) => {
      const a = await scope(r).catch(() => null);
      if (!a || !ports) return json(503, { code: 'operator-download-unavailable' });
      const m = await ports.repository!.revision({ ...a.s, operationId: r.params.operationId ?? '' });
      if (!m) return json(404, { code: 'not-found' });
      return ports.assets!.get({ asset: { kind: 'original', caseId: a.caseId, assetId: m.files[0].assetId }, request: { method: r.request.method === 'HEAD' ? 'HEAD' : 'GET', range: r.request.headers.get('range'), ifRange: r.request.headers.get('if-range') } });
    },
  };
}
export type OperatorDownloadController = ReturnType<typeof createOperatorDownloadController>;
