import type { AssetsAccess, AuditSink, ClientId } from '../../server/runtime/contracts.ts';
import type { AuthorizeCapability } from '../../tenancy/authorizer.ts';
import type { SubmissionRepository } from '../ports.ts';

/**
 * The reads the operator download needs from the intake's own durable records. Structurally the intake's
 * `SubmissionRepository`; nothing here writes. The parent passes the same D1 repository over the client's `DB`.
 */
export type OperatorSubmissionReader = Pick<SubmissionRepository, 'upload' | 'revision' | 'list'>;

/**
 * The original bytes, through the assets service (GRS-115/118): `metadata` names the stored size and digest, `get` answers
 * an integrity-checked whole 200, a 206 or a 416 and a HEAD with no body. The parent hands in a request-scoped handle that
 * authorizes through the same identity as this request; this module still checks everything it is told against the manifest.
 */
export type OperatorAssets = Pick<AssetsAccess, 'metadata' | 'get'>;

/**
 * Everything the operator download needs, composed per request by the parent from trusted configuration. A null port
 * answers 503: nothing here supplies a default, a double, an allow or an in-memory substitute.
 *
 * `authorizeOperate` is the tenancy authorizer's explicit capability check with capability `operate` (a grant row for this
 * case; client membership, a management role, a staff or Global Admin identity alone grant nothing). It is checked in
 * addition to the identity's own `read-original` access to the case, both initially and again at release after awaited
 * storage/audit work. It must read current grants on every call, not cache the first decision for the request.
 */
export interface OperatorDownloadPorts {
  readonly clientId: ClientId;
  readonly authorizeOperate: AuthorizeCapability | null;
  readonly repository: OperatorSubmissionReader | null;
  readonly assets: OperatorAssets | null;
  readonly audit: AuditSink | null;
  now(): Date;
  /** Parent binds the request's execution context on Workers, retaining metadata/download terminal audits after EOF/cancel/refusal. */
  waitUntil?(work: Promise<void>): void;
  /** A unique audit id; defaults to a random UUID. Every release needs 1–118 identifier characters to reserve a terminal suffix. */
  newEventId?(): string;
}
