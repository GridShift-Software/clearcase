// Fresh per-visit services over the production one-lookup path (09b), as 13-analysis.test.ts builds them: a new counted D1,
// case lookup, authorizer and request audit sink for every visit; only the Cache API is shared. The audit insert is deferred
// to `pending`, so a test flushes it and asserts its one D1 insert apart from the foreground counts.
import { requestReadAudit } from '../../../src/lib/audit/facades.ts';
import { auditConfig } from '../../../src/lib/audit/config.ts';
import { createCaseAuthorizer, d1GrantRepository } from '../../../src/lib/tenancy/index.ts';
import { d1CaseDirectory } from '../../../src/lib/tenancy/case-directory.ts';
import { requestCaseLookup } from '../../../src/lib/tenancy/request-case.ts';
import { bindPageReads } from '../../../src/lib/tenancy/page-reads.ts';
import type { ShardCache } from '../../../src/lib/results/hosted/shards.ts';
import { ids } from '../storage/fixture.ts';
import { locals, realAuthority, type Deployment } from '../../publication/shards/world.ts';
import { countedD1, countedR2, type Counters } from './harness.ts';

const deployment = { clientId: ids.clientA, hostname: 'client-a.example.invalid', worker: 'client-a', d1DatabaseId: '00000000-0000-4000-8000-00000000000a', d1DatabaseName: 'client-a',
  r2Bucket: 'client-a', clientIssuer: 'https://clerk.client-a.example.invalid', staffIssuer: 'https://clerk.staff.example.invalid' };
const config = auditConfig({ clientId: ids.clientA, trustedIssuers: [deployment.clientIssuer, deployment.staffIssuer],
  limits: { maxEventBytes: 4096, maxRows: 100_000, maxReadRows: 100_000, maxDenialRows: 1000, maxDenialsPerActor: 100, maxPageRows: 50, maxPagesPerRequest: 5 } });

/** The `locals` of one visit, and how many times the page asked to authorize the case. */
export async function oneLookupLocals(dep: Deployment, c: Counters, cache: ShardCache, pending: Promise<void>[], profile: 'case' | 'overview' = 'case') {
  const db = countedD1(dep.db, c);
  const authority = await realAuthority(dep, db);
  const lookup = requestCaseLookup(db, deployment, null, profile);
  const schedule = requestReadAudit({ db, config, waitUntil: work => { pending.push(work); } });
  const authorizer = createCaseAuthorizer({ deployment, grants: d1GrantRepository(db), cases: d1CaseDirectory({ db, deployment }), lookup,
    audit: { append: async event => { schedule(event); return { eventId: event.eventId }; } }, readAudit: schedule,
    now: () => new Date('2001-01-01T00:00:00Z') });
  const identity = authority.identity;
  let authorizations = 0;
  identity.authorize = scope => { authorizations++; return authorizer.authorizeCase({ ...scope, principal: identity.principal!, sessionId: identity.sessionId! }); };
  const l = locals(dep, { db, identity, audit: authority.audit, bucket: countedR2(dep.bucket, c), r2: countedR2(dep.r2, c), cache });
  bindPageReads(l, lookup);
  return { l, authorizations: () => authorizations };
}
