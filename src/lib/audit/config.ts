import type { ClientId } from '../server/runtime/contracts.ts';

// Trusted deployment configuration for one client's audit log. It comes from the deployment (the parent composes it
// from the resolved per-client resources), never from a request. Every limit is a finite bound under a hard ceiling; no
// limit here is a spending cap, and none is global across clients.

export interface AuditLimits {
  /** Largest canonical event envelope accepted, in UTF-8 bytes. */
  maxEventBytes: number;
  /** Most events this client's table holds; at the bound every append refuses (and the protected action with it). */
  maxRows: number;
  /** Most events one query page returns. */
  maxPageRows: number;
  /** Most query pages one audit log instance (one request) serves. */
  maxPagesPerRequest: number;
}
export interface AuditConfig {
  clientId: ClientId;
  /** Exact issuer URLs of this client's (and the internal staff) identity providers, as GRS-113 verifies them. */
  trustedIssuers: readonly string[];
  limits: AuditLimits;
}

export const CEILINGS: AuditLimits = { maxEventBytes: 4096, maxRows: 50_000_000, maxPageRows: 200, maxPagesPerRequest: 20 };
const CLIENT = /^[a-z0-9][a-z0-9-]{0,62}$/;

const bounded = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;
function issuer(v: unknown) {
  if (typeof v !== 'string' || v.length > 256) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.username === '' && u.password === '' && u.search === '' && u.hash === '' && u.href.replace(/\/$/, '') === v.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/** Validates trusted configuration; throws TypeError (a deployment fault, not a request outcome) when it is not usable. */
export function auditConfig(input: { clientId: unknown; trustedIssuers: unknown; limits: unknown }): AuditConfig {
  const fail = (what: string) => { throw new TypeError(`audit config: ${what}`); };
  if (typeof input.clientId !== 'string' || !CLIENT.test(input.clientId)) fail('clientId');
  const issuers = input.trustedIssuers;
  if (!Array.isArray(issuers) || issuers.length < 1 || issuers.length > 8 || !issuers.every(issuer) || new Set(issuers).size !== issuers.length) fail('trustedIssuers must be 1 to 8 distinct https issuer URLs');
  const l = input.limits as Record<string, unknown> | null;
  if (typeof l !== 'object' || l === null) fail('limits');
  const limits = {} as AuditLimits;
  for (const k of Object.keys(CEILINGS) as (keyof AuditLimits)[]) {
    if (!bounded(l![k], CEILINGS[k])) fail(`limits.${k} must be an integer from 1 to ${CEILINGS[k]}`);
    limits[k] = l![k] as number;
  }
  return Object.freeze({ clientId: input.clientId as ClientId, trustedIssuers: Object.freeze([...(issuers as string[])]), limits: Object.freeze(limits) });
}
