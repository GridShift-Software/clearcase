import type { CaseId, ClientId } from '../server/runtime/contracts.ts';
import type { SubmissionManifest } from './ports.ts';
import type { IntakeD1 } from './repository.ts';

export interface IntakeNotifications {
  /** Schedules best-effort delivery; never waits for a network call. */
  sealed(manifest: SubmissionManifest): void;
  /** Called only after the operator controller admits this case. */
  pending(scope: { clientId: ClientId; caseId: CaseId }): Promise<readonly string[]>;
}

/** Trusted composition supplies the database, secret and request lifetime hook.
 * No request parameter can select the destination. Failed deliveries remain new
 * on the operator page. This is one best-effort attempt, not a retry queue.
 */
export function intakeNotifications(o: {
  clientId: ClientId; db: IntakeD1; webhook?: unknown;
  waitUntil?: (work: Promise<void>) => void;
  now: () => Date; fetch?: typeof fetch;
}): IntakeNotifications {
  let target: string | null = null;
  if (typeof o.webhook === 'string') {
    try {
      const url = new URL(o.webhook);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.hash) target = url.href;
    } catch { /* Missing or invalid configuration leaves the durable notification pending. */ }
  }
  return {
    async pending(scope) {
      if (scope.clientId !== o.clientId) throw new Error('foreign notification scope');
      const rows = await o.db.prepare('SELECT submission_id FROM sub_notification WHERE client_id = ? AND case_id = ? AND delivered_at IS NULL')
        .bind(o.clientId, scope.caseId).all<{ submission_id: string }>();
      return rows.results.map((r) => r.submission_id);
    },
    sealed(manifest) {
      if (!target || !o.waitUntil || manifest.clientId !== o.clientId) return;
      const destination = target;
      // Claim atomically before sending: concurrent/replayed seals send at most
      // one message. A lost acknowledgement remains visibly undelivered.
      const work = Promise.resolve().then(async () => {
        const claimed = await o.db.prepare(`UPDATE sub_notification SET attempted_at = ?
          WHERE client_id = ? AND case_id = ? AND submission_id = ? AND attempted_at IS NULL AND delivered_at IS NULL
          RETURNING created_at`)
          .bind(o.now().toISOString(), o.clientId, manifest.caseId, manifest.operationId).first<{ created_at: string }>();
        if (!claimed) return;
        const response = await (o.fetch ?? fetch)(destination, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ caseId: manifest.caseId, submissionId: manifest.operationId,
            files: manifest.files.length, bytes: manifest.files.reduce((sum, f) => sum + f.size, 0), at: claimed.created_at }),
        });
        await response.body?.cancel();
        if (response.ok) await o.db.prepare(`UPDATE sub_notification SET delivered_at = ?
          WHERE client_id = ? AND case_id = ? AND submission_id = ? AND delivered_at IS NULL`)
          .bind(o.now().toISOString(), o.clientId, manifest.caseId, manifest.operationId).run();
      }).catch(() => undefined); // Never log a secret URL, response body or case details.
      try { o.waitUntil(work); } catch { /* Upload success does not depend on notification delivery. */ }
    },
  };
}
