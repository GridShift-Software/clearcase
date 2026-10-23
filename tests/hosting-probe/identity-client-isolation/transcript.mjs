// Reviewed GRS-201 contract. Assertions describe observations, not runner-supplied expectations.
import { rows, pathOf, ownInstance } from '../identity/matrix.ts';

export const CLIENTS = ['a', 'c'];
export const INSTANCES = {
	a: { name: 'Clear-Case-Dev-A', issuer: 'https://deciding-rabbit-6243.clerk.accounts.dev' },
	c: { name: 'Clear-Case-Dev-C', issuer: 'https://outgoing-walrus-1020.clerk.accounts.dev' },
	staff: { name: 'Clear-Case-Dev-B', issuer: 'https://renewed-moth-1294.clerk.accounts.dev' },
};
export const HOLD = ['Original-file downloads: the reused probe has no original route.', 'JWT aud validation: the reused verifier configures authorizedParties (azp), not audience.', 'Production Clerk, sibling-subdomain cookies, CSP and Cloudflare deployment remain unproved.'];
export const TABLES = ['members', 'invitations', 'cases', 'documents', 'notes', 'assignments', 'operator_grants'];
export const protectedRows = () => rows().filter((r) => r.app === 'client' && r.gate !== 'public');
export const positives = [
	{ method: 'GET', path: '/cases/case-1', actor: 'own', status: 200, marker: 'CC108-CASE1-META' },
	{ method: 'GET', path: '/cases/case-1/documents/doc-1', actor: 'own', status: 200, marker: 'CC108-CASE1-TEXT' },
	{ method: 'GET', path: '/cases/case-1/assets/summary.txt', actor: 'own', status: 200, marker: 'CC108-CASE1-PUBLISHED' },
	{ method: 'POST', path: '/cases/case-1/notes', actor: 'own', status: 201, marker: 'CC201-NOTE' },
	{ method: 'GET', path: '/cases/case-1/notes', actor: 'own', status: 200, marker: 'CC201-NOTE' },
	{ method: 'GET', path: '/operator/cases/case-1/drafts/candidate.txt', actor: 'operator', status: 200, marker: 'CC108-CASE1-DRAFT' },
];
export function requests() {
	const out = [];
	for (const target of CLIENTS) {
		for (const p of positives) out.push({ target, ...p, denial: null });
		for (const actor of ['foreign', 'wrong-party']) for (const r of protectedRows()) {
			out.push({ target, method: r.method, path: pathOf(r), actor, status: 401, marker: null,
				denial: actor === 'foreign' ? 'token-invalid' : 'wrong-party', staff: ownInstance(r) === 'staff' });
		}
	}
	return out;
}
export function transcript() {
	return requests().map((r) => ({ command: `${r.target}: ${r.actor} ${r.method} ${r.path}`,
		assertion: r.marker ? `status ${r.status}; contains ${r.marker}; no case-2 marker` : `status 401 ${r.denial}; no case content`, ...r }));
}
export const LIFECYCLE = [
	'Pinned Bun build and native local workerd; both client worlds serve sourceSha.',
	'Three distinct named development instances; invite-only and MFA disabled.',
	'Real signed sessions: own issuer/party, other issuer at recipient party, own issuer at other party.',
	'Both client stores preserve all non-audit tables after hostile requests.',
	'Every run-owned user/invitation removed and session ended; unrelated identities untouched.',
	'No secret canary or credential shape in logs, local state, build or summary.',
];
