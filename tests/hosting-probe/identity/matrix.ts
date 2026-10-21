// The route-and-gate matrix (GRS-108): for every route each app serves (src/lib/gates.json) and every class of caller,
// the one response the gate must give. probe.ts sends each request and records what came back; check.ts recomputes the
// expectations from this table, so a summary cannot carry its own. A refusal must also carry none of either case's
// markers; an allowed case-1 read must carry case 1's and none of case 2's.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export type App = 'client' | 'staff';
export type Gate = 'public' | 'session' | 'member' | 'case-read' | 'case-write' | 'firm-admin' | 'staff-session' | 'instance-admin' | 'operator-grant' | 'global-admin';
export type Class = 'anonymous' | 'expired' | 'revoked' | 'wrong-app' | 'wrong-party' | 'non-member' | 'wrong-case' | 'firm-admin' | 'viewer' | 'editor' | 'operator' | 'global-admin';
export type Row = { app: App; method: string; route: string; gate: Gate };
export type Expect = { status: number; reason: string; marker: string | null };

export const MARKERS = ['CC108-CASE1-META', 'CC108-CASE1-TEXT', 'CC108-CASE1-PUBLISHED', 'CC108-CASE1-DRAFT', 'CC108-CASE2-META', 'CC108-CASE2-TEXT', 'CC108-CASE2-PUBLISHED', 'CC108-CASE2-DRAFT'] as const;

/** Every (app, method, route) in gates.json with its gate, sign-out last within each app (an allowed sign-out ends the caller's session). */
export function rows(gatesFile = path.join(import.meta.dirname, 'src/lib/gates.json')): Row[] {
	const gates = JSON.parse(readFileSync(gatesFile, 'utf8')) as Record<string, unknown>;
	const out: Row[] = [];
	for (const app of ['client', 'staff'] as const) {
		const table = gates[app] as Record<string, Record<string, Gate>>;
		for (const [route, methods] of Object.entries(table)) for (const [method, gate] of Object.entries(methods)) out.push({ app, method, route, gate });
	}
	const last = (r: Row) => (r.route === '/auth/sign-out' ? 1 : 0);
	return out.sort((a, b) => (a.app === b.app ? last(a) - last(b) : a.app === 'client' ? -1 : 1));
}

/** The gates a client app verifies against the staff instance: gates.json's `staffGates`, the one definition (the hook reads it too). */
export const STAFF_GATES = new Set<string>((JSON.parse(readFileSync(path.join(import.meta.dirname, 'src/lib/gates.json'), 'utf8')) as { staffGates: string[] }).staffGates);

/** The Clerk instance whose session a row's protected request carries: the client's own, unless the row is a staff app route or a staff gate on the client app. */
export const ownInstance = (r: Row): App => (r.app === 'client' && !STAFF_GATES.has(r.gate) ? 'client' : 'staff');

/** The order the classes are swept in: the operator last, because its sweep ends with an allowed sign-out. */
export const CLASS_ORDER: Class[] = ['anonymous', 'expired', 'revoked', 'wrong-app', 'wrong-party', 'non-member', 'wrong-case', 'firm-admin', 'viewer', 'editor', 'global-admin', 'operator'];

/** The classes a row is checked with, in CLASS_ORDER. */
export function classesOf(r: Row): Class[] {
	const refused: Class[] = ['anonymous', 'expired', 'revoked', 'wrong-app', 'wrong-party'];
	const pick = (extra: Class[]) => CLASS_ORDER.filter((c) => refused.includes(c) || extra.includes(c));
	if (r.gate === 'public') return ['anonymous', 'expired', 'revoked'];
	if (r.route === '/auth/sign-out') return pick([r.app === 'client' ? 'non-member' : 'operator']);
	if (ownInstance(r) === 'client') return pick(['non-member', 'wrong-case', 'firm-admin', 'viewer', 'editor']);
	return pick(['global-admin', 'operator']);
}

/** The concrete request path of a row: case 1, its document, its published asset and its draft. */
export function pathOf(r: Row): string {
	return r.route
		.replace('[case]', 'case-1')
		.replace('[doc]', 'doc-1')
		.replace('/assets/[...name]', '/assets/summary.txt')
		.replace('/drafts/[...name]', '/drafts/candidate.txt')
		.concat(r.route === '/cases/[case]' && r.method === 'POST' ? '?/note' : '');
}

const ok = (status: number, marker: string | null = null): Expect => ({ status, reason: '', marker });
const no = (status: number, reason: string): Expect => ({ status, reason, marker: null });

/** Created (201) on first write; the routes below create a row or a Clerk invitation each time. */
const CREATES = new Set(['POST /admin/invitations', 'POST /admin/assignments', 'POST /manage/firm-admin-invitations', 'POST /manage/operator-grants', 'POST /manage/staff-invitations', 'POST /cases/[case]/notes']);

/** What an allowed caller's request returns, and the case-1 marker its body must hold. */
function allowed(r: Row): Expect {
	const key = `${r.method} ${r.route}`;
	if (CREATES.has(key)) return ok(201);
	const marker: Record<string, string> = {
		'GET /cases/[case]': 'CC108-CASE1-META',
		'GET /cases/[case]/documents/[doc]': 'CC108-CASE1-TEXT',
		'GET /cases/[case]/assets/[...name]': 'CC108-CASE1-PUBLISHED',
		'GET /operator/cases/[case]': 'CC108-CASE1-META',
		'GET /operator/cases/[case]/documents/[doc]': 'CC108-CASE1-TEXT',
		'GET /operator/cases/[case]/drafts/[...name]': 'CC108-CASE1-DRAFT',
	};
	return ok(200, marker[key] ?? null);
}

/** The one response `cls` must get on `r`. */
export function expectFor(r: Row, cls: Class): Expect {
	const key = `${r.method} ${r.route}`;
	if (r.gate === 'public') return ok(200);
	switch (cls) {
		case 'anonymous':
			return no(401, 'signed-out');
		case 'expired':
			return no(401, 'token-expired');
		case 'revoked':
			return no(401, 'session-revoked');
		case 'wrong-app':
			return no(401, 'token-invalid');
		case 'wrong-party':
			return no(401, 'wrong-party');
	}
	if (key === 'POST /invite/accept' || key === 'POST /manage/accept') {
		const enrolled = (r.app === 'client' && r.route === '/invite/accept' && cls !== 'non-member') || (r.app === 'staff' && (cls === 'operator' || cls === 'global-admin')) || (r.route === '/manage/accept' && cls === 'global-admin');
		return enrolled ? no(409, 'already-a-member') : no(403, 'no-invitation');
	}
	if (r.gate === 'session') return ok(200);
	switch (r.gate) {
		case 'member':
			return cls === 'non-member' ? no(403, 'not-a-member') : ok(200, cls === 'viewer' || cls === 'editor' ? 'CC108-CASE1-META' : null);
		case 'case-read':
		case 'case-write':
			if (cls === 'non-member') return no(403, 'not-a-member');
			if (cls === 'wrong-case' || cls === 'firm-admin') return no(404, 'no-case-access');
			if (r.gate === 'case-write' && cls === 'viewer') return no(403, 'editor-required');
			return allowed(r);
		case 'firm-admin':
			return cls === 'non-member' ? no(403, 'not-a-member') : cls === 'firm-admin' ? allowed(r) : no(403, 'firm-admin-required');
		case 'instance-admin':
			return cls === 'global-admin' ? allowed(r) : no(403, 'instance-admin-required');
		case 'operator-grant':
			return cls === 'operator' ? allowed(r) : no(403, 'no-operator-grant');
		case 'global-admin':
			return cls === 'global-admin' ? allowed(r) : no(403, 'global-admin-required');
	}
	return no(500, 'unknown-gate');
}

/** "<status> <reason>", the form a check records. */
export const label = (e: { status: number; reason: string }) => `${e.status}${e.reason ? ` ${e.reason}` : ''}`;

const CASE1 = MARKERS.filter((m) => m.startsWith('CC108-CASE1'));

/**
 * The markers a response to `cls` on `r` may carry: case 1's (not its draft) for an assigned user, case 1's with its draft
 * for an operator with a grant, case 2's title in the case list of the wrong-case caller (assigned to case 2 only), none
 * otherwise.
 */
export function mayShow(r: Row, cls: Class): string[] {
	if (expectFor(r, cls).reason) return [];
	if (cls === 'wrong-case' && r.gate === 'member') return ['CC108-CASE2-META'];
	if ((cls === 'viewer' || cls === 'editor') && ['member', 'case-read', 'case-write'].includes(r.gate)) return CASE1.filter((m) => !m.endsWith('DRAFT'));
	if (cls === 'operator' && r.gate === 'operator-grant') return CASE1;
	return [];
}
