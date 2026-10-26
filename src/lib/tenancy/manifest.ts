import type { ClientId } from '../server/runtime/contracts.ts';
import { id } from '../server/runtime/ids.ts';

// The per-client resource identity (ADR-0007, ADR-0008): every client instance has its own Worker, D1 database, R2
// bucket, hostname and client identity issuer, and one internal staff issuer spans them. This module only validates a
// checked manifest and the tuple one deployment is configured with. It makes no provider call and sets no client count.

export interface ClientResources {
  readonly clientId: ClientId;
  readonly hostname: string;
  readonly worker: string;
  readonly d1DatabaseId: string;
  readonly d1DatabaseName: string;
  readonly r2Bucket: string;
  /** The client identity application's issuer; only principals of kind "client" from it belong to this client. */
  readonly clientIssuer: string;
}
export interface ClientManifest { readonly staffIssuer: string; readonly clients: readonly ClientResources[] }
/** What one Worker is configured with by its deployment; never read from a request. */
export interface DeploymentTuple { clientId: string; worker: string; d1DatabaseId: string; r2Bucket: string; hostname?: string; d1DatabaseName?: string }
/** The full tuple a production deployment is configured with. resolveExactDeployment requires every field. */
export interface ExactDeploymentTuple { clientId: string; hostname: string; worker: string; d1DatabaseId: string; d1DatabaseName: string; r2Bucket: string }
/** The validated identity of the client instance this deployment serves. */
export type ClientResourceIdentity = ClientResources & { readonly staffIssuer: string };

export type ManifestCode = 'invalid-manifest' | 'duplicate-resource' | 'unknown-client' | 'resource-mismatch';
export class ManifestError extends Error {
  readonly code: ManifestCode;
  constructor(code: ManifestCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const CLIENT = /^[a-z0-9][a-z0-9-]{0,62}$/; // as bindings.ts reads CLEARCASE_CLIENT_ID
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const WORKER = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const D1_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const KEYS = ['clientId', 'hostname', 'worker', 'd1DatabaseId', 'd1DatabaseName', 'r2Bucket', 'clientIssuer'] as const;

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function issuer(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new ManifestError('invalid-manifest', `${where} is not an issuer`);
  let url: URL;
  try { url = new URL(v); } catch { throw new ManifestError('invalid-manifest', `${where} is not an issuer`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || v !== url.origin) throw new ManifestError('invalid-manifest', `${where} must be a bare https origin`);
  return v;
}
function text(v: unknown, pattern: RegExp, where: string): string {
  if (typeof v !== 'string' || !pattern.test(v)) throw new ManifestError('invalid-manifest', `${where} is invalid`);
  return v;
}

/** Validates a client manifest: exact fields, and no Worker, database, bucket, hostname or issuer shared between entries. */
export function validateClientManifest(input: unknown): ClientManifest {
  if (!record(input) || Object.keys(input).sort().join() !== 'clients,staffIssuer' || !Array.isArray(input.clients) || input.clients.length === 0) throw new ManifestError('invalid-manifest', 'expected { staffIssuer, clients: [...] }');
  const staffIssuer = issuer(input.staffIssuer, 'staffIssuer');
  const seen = new Map<string, string>([[`issuer:${staffIssuer}`, 'staffIssuer']]);
  const claim = (kind: string, value: string, where: string) => {
    const key = `${kind}:${value}`, prior = seen.get(key);
    if (prior) throw new ManifestError('duplicate-resource', `${where} repeats ${prior}`);
    seen.set(key, where);
  };
  const clients = input.clients.map((c: unknown, i): ClientResources => {
    const at = `clients[${i}]`;
    if (!record(c) || Object.keys(c).sort().join() !== [...KEYS].sort().join()) throw new ManifestError('invalid-manifest', `${at} must have exactly ${KEYS.join(', ')}`);
    const entry: ClientResources = {
      clientId: id('client', text(c.clientId, CLIENT, `${at}.clientId`)),
      hostname: text(c.hostname, HOST, `${at}.hostname`),
      worker: text(c.worker, WORKER, `${at}.worker`),
      d1DatabaseId: text(c.d1DatabaseId, UUID, `${at}.d1DatabaseId`),
      d1DatabaseName: text(c.d1DatabaseName, D1_NAME, `${at}.d1DatabaseName`),
      r2Bucket: text(c.r2Bucket, BUCKET, `${at}.r2Bucket`),
      clientIssuer: issuer(c.clientIssuer, `${at}.clientIssuer`),
    };
    claim('client', entry.clientId, `${at}.clientId`);
    claim('host', entry.hostname, `${at}.hostname`);
    claim('worker', entry.worker, `${at}.worker`);
    claim('d1', entry.d1DatabaseId, `${at}.d1DatabaseId`);
    claim('d1-name', entry.d1DatabaseName, `${at}.d1DatabaseName`);
    claim('r2', entry.r2Bucket, `${at}.r2Bucket`);
    claim('issuer', entry.clientIssuer, `${at}.clientIssuer`);
    return Object.freeze(entry);
  });
  return Object.freeze({ staffIssuer, clients: Object.freeze(clients) });
}

/**
 * The manifest entry a deployment serves, only when its configured Worker, D1 and R2 are exactly that client's. A hostname
 * or D1 name, when supplied, must match too; their absence is tolerated here only for callers that predate them.
 * Production composition uses resolveExactDeployment, which fails closed on any missing resource.
 */
export function resolveDeployment(manifest: ClientManifest, tuple: DeploymentTuple): ClientResourceIdentity {
  const entry = manifest.clients.find((c) => c.clientId === tuple?.clientId);
  if (!entry) throw new ManifestError('unknown-client', 'the deployment client is not in the manifest');
  for (const key of ['worker', 'd1DatabaseId', 'r2Bucket'] as const) {
    if (entry[key] !== tuple[key]) throw new ManifestError('resource-mismatch', `${key} is not this client's`);
  }
  for (const key of ['hostname', 'd1DatabaseName'] as const) {
    if (tuple[key] !== undefined && entry[key] !== tuple[key]) throw new ManifestError('resource-mismatch', `${key} is not this client's`);
  }
  return Object.freeze({ ...entry, staffIssuer: manifest.staffIssuer });
}

const TUPLE_KEYS = ['clientId', 'hostname', 'worker', 'd1DatabaseId', 'd1DatabaseName', 'r2Bucket'] as const;
/**
 * The strict form: the deployment's own host, Worker, D1 id and name and R2 bucket, all required, compared exactly
 * (no case folding or trimming; the caller passes configuration, never request data). A missing, extra, non-string or
 * foreign resource refuses, so a half-configured deployment serves nobody. It names the bound resources but cannot prove
 * the platform bound them; that needs a provider check this module does not make.
 */
export function resolveExactDeployment(manifest: ClientManifest, tuple: ExactDeploymentTuple): ClientResourceIdentity {
  if (!record(tuple) || Object.keys(tuple).sort().join() !== [...TUPLE_KEYS].sort().join() || TUPLE_KEYS.some((k) => typeof tuple[k] !== 'string' || tuple[k] === '')) {
    throw new ManifestError('resource-mismatch', `the deployment tuple must have exactly ${TUPLE_KEYS.join(', ')}`);
  }
  const entry = manifest.clients.find((c) => c.clientId === tuple.clientId);
  if (!entry) throw new ManifestError('unknown-client', 'the deployment client is not in the manifest');
  for (const key of TUPLE_KEYS) {
    if (entry[key] !== tuple[key]) throw new ManifestError('resource-mismatch', `${key} is not this client's`);
  }
  return Object.freeze({ ...entry, staffIssuer: manifest.staffIssuer });
}
