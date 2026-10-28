import * as workers from 'cloudflare:workers';
import type { AssetRef, AssetsAccess, CaseId, CaseReader, CaseRevision, ClientId, Identity, ResultsVersion, Scope } from '../../server/runtime/contracts.ts';
import type { CloudBindings } from '../../storage/cloud/bindings.ts';
import type { StorageBudgets } from '../../storage/cloud/budgets.ts';
import { storageAccess } from '../../storage/cloud/access.ts';
import { createCloudReader } from './reader.ts';
import { createCloudAssets } from './assets.ts';

/** One protected storage event, appended through the audit owner's sink (GRS-116) by the composing caller. */
export interface StorageEvent { action: string; object: { kind: string; id: string; caseId: CaseId | null }; version: ResultsVersion | null; outcome: 'succeeded' | 'denied' | 'failed' | 'refused' }
export interface CloudResultsOptions {
  /** `cloudBindings(env)`; null when the deployment has no usable D1 or R2 binding. */
  bindings: CloudBindings | null;
  /** The deployment's client, from trusted configuration only (never a host header, route or body). */
  clientId: ClientId | null;
  /** `storageBudgets(...)` of trusted configuration; null keeps storage unavailable. */
  budgets: StorageBudgets | null;
  /** The request's identity (GRS-113). Every read authorizes through it. */
  identity: Identity;
  /** Appends one event; a delivery whose event cannot be appended is not released. */
  record(e: StorageEvent): Promise<void>;
  /** The user-work revision of a case, owned by GRS-117. */
  stateRevision(a: Scope): Promise<CaseRevision>;
  /**
   * The composing parent's in-app viewer route for an original or preview (for example the PDF view), or null. Storage serves
   * every byte as a sandboxed attachment; an inline-safe view is the parent's route and proof. `links` offers the returned path
   * only when it lies under the asset's own case (`/cases/<case>/...`), so a viewer link can never point at another case.
   */
  viewerRoute?(asset: AssetRef): string | null;
  /** The clock of the verification work window (`verifyVersion`); the system clock when absent. */
  now?(): Date;
}
/**
 * The hosted results reader and asset access for one request. With a missing binding, client id or budget, or a
 * storage identity that is not this client's, every call refuses (`storage-unavailable`, `asset-unavailable`) before a
 * row or object is read.
 */
export function createCloudResults(o: CloudResultsOptions): { store: CaseReader; assets: AssetsAccess } {
  return {
    store: createCloudReader({ open: storageAccess(o, 'storage-unavailable'), identity: o.identity, record: o.record, stateRevision: o.stateRevision, now: o.now ?? (() => new Date()) }),
    assets: createCloudAssets({ open: storageAccess(o, 'asset-unavailable'), identity: o.identity, record: o.record, fastOriginals: typeof workers.env.CLEARCASE_ASSET_TICKET_KEY === 'string', ticketBucket: o.bindings?.bucket, waitUntil: (p) => { if ('waitUntil' in workers && typeof workers.waitUntil === 'function') workers.waitUntil(p); else void p.catch(() => undefined); }, ...(o.viewerRoute ? { viewerRoute: o.viewerRoute } : {}) }),
  };
}
