import { it, expect } from 'vitest';
import { createOperatorDownloadController } from '../../../src/lib/submissions/download/controller.ts';
import type { OperatorDownloadPorts } from '../../../src/lib/submissions/download/ports.ts';
import { CASE_A, identity, seed, world } from './doubles.ts';

function request(operationId: string, headers: Record<string, string> = {}) {
 const url = new URL('https://client-a.clearcase.test/operator/submissions/' + CASE_A + '/finalized/' + operationId + '/download');
 return { request: new Request(url, {headers}), url, params: {caseId: CASE_A, operationId}, identity: identity() };
}

it('rejects a valid-length 206 whose interval differs from the requested interval', async () => {
 const w = world(); const s = await seed(w);
 w.assets.tamper.contentRange = 'bytes 30-39/' + s.bytes.length;
 const r = await createOperatorDownloadController(w.ports as unknown as OperatorDownloadPorts).download(request(s.operationId, {range: 'bytes=0-9'}));
 console.log('range mismatch:', r.status, r.headers.get('content-range'));
 await r.body?.cancel();
 expect(r.status).toBe(503);
});

it('does not release a submission after operate is revoked during the original read', async () => {
 const w = world(); const s = await seed(w);
 let granted = true;
 let calls = 0;
 const get = w.assets.get.bind(w.assets);
 w.assets.get = async (a) => {
   // Model revocation while the slow original store is reading. Original access remains granted.
   granted = false;
   await identity().authorize({caseId: CASE_A, operation: 'read-original'});
   return get(a);
 };
 const ports = { ...w.ports, authorizeOperate: async () => {
   calls++; if (!granted) throw Object.assign(new Error('revoked'), {code:'forbidden'});
 }};
 const r = await createOperatorDownloadController(ports as unknown as OperatorDownloadPorts).download(request(s.operationId));
 const bytes = await r.arrayBuffer();
 console.log('revoked operate:', r.status, 'released bytes:', bytes.byteLength, 'capability checks:', calls);
 expect(r.status).toBe(404);
});

it('records failed delivery when the streamed original terminates short', async () => {
 const w = world(); const s = await seed(w);
 w.assets.tamper.shortBytes = 7;
 const r = await createOperatorDownloadController(w.ports as unknown as OperatorDownloadPorts).download(request(s.operationId));
 await expect(r.arrayBuffer()).rejects.toThrow();
 console.log('short-stream audit:', w.audit.events.map(e => e.outcome));
 expect(w.audit.events.some(e => e.action === 'operator.submission.download' && e.outcome === 'failed')).toBe(true);
});
