// GRS-114 approved supplemental correction: a request audit port never accepts a system producer. node:sqlite stand-in.
// These adverse cases already held at f8d2b7b3 (a system actor matched no requester); they pin that it stays so.
import { describe, expect, it } from 'vitest';
import { requestAuditSink } from '../../../src/lib/audit/index.ts';
import { trustedGrantAuditPort } from '../../../src/lib/audit/trusted.ts';
import { anonymous, config, event, NOW, viewer, world } from './world.ts';

const system = { kind: 'system', component: 'provisioning', operator: 'provisioning-run-1' } as never;

describe('request audit ports refuse a forged system producer', () => {
  for (const requester of [viewer, anonymous]) {
    it(`requestAuditSink and the grant port reject a system actor for a ${requester.kind} requester and store nothing`, async () => {
      const w = world(); await w.ready;
      const a = { db: w.d1, config: config(), requester, now: NOW };
      for (const port of [requestAuditSink(a), trustedGrantAuditPort(a)]) {
        await expect(port.append(event({ action: 'grant.bootstrap', object: { kind: 'case-grant', id: 'g-1', caseId: null } }, system))).rejects.toMatchObject({ code: 'invalid-event' });
      }
      expect(w.rows()).toEqual([]);
    });
  }
});
