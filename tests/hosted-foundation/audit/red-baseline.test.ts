// GRS-116 adverse outcomes, first run against the base's existing request audit sink (the hosted-gate d1Audit double).
// A retried append after a lost acknowledgement must return the same acknowledgement; the same eventId carrying a
// different event must be refused as a conflict, never acknowledged and never mistaken for durability.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { AuditEvent, AuditSink, Identity } from '../../../src/lib/server/runtime/contracts.ts';
import { d1 } from './d1.ts';
import { subject } from './subject.ts';

const principal = { issuer: 'https://clerk.client-a.example', subject: 'user_a1', kind: 'client' as const };
const identity: Identity = { kind: 'verified', principal, sessionId: 'sess_a1' as never, clientId: 'client-a' as never, checkRevocation: async () => {}, authorize: async () => {} };
const event = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  eventId: 'grant-op:op-1', actor: { kind: 'verified', principal, sessionId: 'sess_a1' as never }, action: 'grant.create',
  object: { kind: 'case-grant', id: 'g-1', caseId: 'case-a1' as never }, version: null, outcome: 'succeeded', at: '2026-10-24T10:00:00.000Z', ...over,
});

describe('request audit adverse outcomes', () => {
  it('acknowledges a retried identical append after a lost acknowledgement with the same eventId', async () => {
    const db = new DatabaseSync(':memory:');
    const sink: AuditSink = await subject({ db, d1: d1(db), identity });
    await expect(sink.append(event())).resolves.toEqual({ eventId: 'grant-op:op-1' });
    await expect(sink.append(event())).resolves.toEqual({ eventId: 'grant-op:op-1' });
  });
  it('refuses the same eventId carrying a different event as a conflict', async () => {
    const db = new DatabaseSync(':memory:');
    const sink: AuditSink = await subject({ db, d1: d1(db), identity });
    await sink.append(event());
    await expect(sink.append(event({ outcome: 'failed' }))).rejects.toMatchObject({ code: 'audit-conflict' });
  });
});
