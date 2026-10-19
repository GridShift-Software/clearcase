// TEST DOUBLE (hosted-gate profile only): see ./services.ts.
import type { CaseInfo, CaseReader, ClientId, Publication, Scope } from '../../contracts.ts';
import { contractError, isDenial } from '../../errors.ts';
import { id, resultsVersion } from '../../ids.ts';
import { freeze } from '../../data.ts';
import type { D1 } from '../bindings.ts';
import type { d1Audit } from './audit.ts';
import type { testIdentity } from './identity.ts';

type CaseRow = { case_id: string; case_label: string | null; publication: 'none' | 'withdrawn' | 'published'; results_version: string | null };
const failed = (): never => {
	throw contractError('storage-unavailable', true);
};
const info = (r: CaseRow): CaseInfo => {
	const publication: Publication = r.publication === 'published' && r.results_version ? { kind: 'published', resultsVersion: resultsVersion(r.results_version) } : { kind: r.publication === 'withdrawn' ? 'withdrawn' : 'none' };
	return { caseId: id('case', r.case_id), caseLabel: r.case_label, publication, href: `/cases/${encodeURIComponent(r.case_id)}`, documents: null };
};

/**
 * Case identity and publication state from the fixture's D1 tables, standing in for GRS-117's storage. Results
 * themselves (versions, documents, datasets) are not part of the bootstrap and stay unavailable.
 */
export function fixtureStore(a: { db: D1; clientId: ClientId; base: CaseReader; identity: Awaited<ReturnType<typeof testIdentity>>; audit: ReturnType<typeof d1Audit> }): CaseReader {
	const { db, clientId, audit } = a;
	const row = (scope: Scope) => db.prepare('SELECT case_id, case_label, publication, results_version FROM gate_case WHERE client_id = ? AND case_id = ?').bind(clientId, scope.caseId).first<CaseRow>().catch(failed);
	return {
		...a.base,
		async listCases() {
			let subject: string;
			try {
				subject = (await a.identity.current()).subject;
			} catch (e) {
				if (isDenial(e)) await audit.record({ action: 'case.list', object: { kind: 'client', id: clientId, caseId: null }, version: null, outcome: 'denied' }).catch(() => undefined);
				throw e;
			}
			const { results } = await db
				.prepare('SELECT c.case_id, c.case_label, c.publication, c.results_version FROM gate_case c JOIN gate_grant g ON g.client_id = c.client_id AND g.case_id = c.case_id WHERE c.client_id = ? AND g.subject = ? ORDER BY c.case_id')
				.bind(clientId, subject)
				.all<CaseRow>()
				.catch(failed);
			return freeze(results.map(info));
		},
		async getCase(scope) {
			await audit.authorized(scope, 'read', 'case.read');
			const r = await row(scope);
			return r ? freeze(info(r)) : null;
		},
		async activeVersionId(scope) {
			await audit.authorized(scope, 'read', 'case.read');
			const r = await row(scope);
			return r?.publication === 'published' && r.results_version ? resultsVersion(r.results_version) : null;
		},
	};
}
