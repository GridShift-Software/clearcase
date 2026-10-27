// Custom-domain bind plan for the approved sandbox clients. Pure data and checks: no transport, credentials, environment, files or
// network. A caller sends the operations and passes the provider's answers back in. Nothing here proves a binding; only a readback
// judged by customDomainBindProblems after the PUTs, on the parent's real requests, can.
//
// The binding is a free Workers Custom Domain (PUT /accounts/:a/workers/domains), never a route, so the zone needs no route entry.
// Each client hostname is bound only to its own Worker, one single label under the approved zone. A wildcard, a nested name, a
// hostname outside the zone and another client's Worker are all refused. The zone must read `active` before any bind is planned.
import { APPROVED_NATIVE_SCOPE } from './controls.ts';

export const CUSTOM_DOMAIN_BIND_SCHEMA = 'clearcase.native-custom-domain-bind/1';
const SDK = 'cloudflare-typescript 5.2.0 (vendored in wrangler 4.151.1)';
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export type BindScope = {
	readonly accountId: string;
	readonly zone: { readonly id: string; readonly name: string };
	readonly clients: readonly { readonly client: string; readonly worker: string; readonly hostname: string }[];
};
export type BindOperation = Readonly<{
	kind: 'bind-custom-domain';
	client: string;
	method: 'PUT';
	path: string;
	body: Readonly<{ environment: 'production'; hostname: string; service: string; zone_id: string }>;
	source: string;
}>;
export type UnbindOperation = Readonly<{ kind: 'unbind-custom-domain'; client: string; method: 'DELETE'; path: string; hostname: string; source: string }>;
export type ProviderDomain = { id: string; hostname: string; zoneId: string; service: string; environment: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const show = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v));
const freeze = <T>(value: T): T => {
	if (value !== null && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
	return value;
};

/** The reviewed scope, copied once so a later change to the caller's object can move nothing. */
const SCOPE: BindScope = freeze({
	accountId: APPROVED_NATIVE_SCOPE.accountId,
	zone: { id: APPROVED_NATIVE_SCOPE.zone.id, name: APPROVED_NATIVE_SCOPE.zone.name },
	clients: APPROVED_NATIVE_SCOPE.clients.map((c) => ({ client: c.client, worker: c.worker, hostname: c.hostname })),
});

/** Every way a scope differs from the approved one, named. Empty only for exactly the approved account, zone, clients and Workers. */
export function bindScopeProblems(scope: unknown): string[] {
	const problems: string[] = [];
	const fail = (message: string) => problems.push(message);
	if (!isObject(scope) || !Array.isArray(scope.clients) || !isObject(scope.zone)) return ['scope is not { accountId, zone, clients }'];
	if (scope.accountId !== SCOPE.accountId) fail(`account ${show(scope.accountId)} is not the approved account`);
	if (scope.zone.id !== SCOPE.zone.id || scope.zone.name !== SCOPE.zone.name) fail(`zone ${show(scope.zone)} is not exactly the approved zone ${SCOPE.zone.name}`);
	if (scope.clients.length !== SCOPE.clients.length) fail(`${scope.clients.length} clients, not the approved ${SCOPE.clients.length}`);
	const suffix = `.${SCOPE.zone.name}`;
	scope.clients.forEach((c: unknown, i) => {
		const approved = SCOPE.clients[i];
		if (!isObject(c) || typeof c.hostname !== 'string') return fail(`clients[${i}] is not { client, worker, hostname }`);
		const host = c.hostname;
		if (host.includes('*')) fail(`clients[${i}] hostname ${show(host)} is a wildcard`);
		else if (!host.endsWith(suffix)) fail(`clients[${i}] hostname ${show(host)} is outside the zone ${SCOPE.zone.name}`);
		else if (!LABEL.test(host.slice(0, -suffix.length))) fail(`clients[${i}] hostname ${show(host)} is not one label under the zone`);
		if (!approved) return;
		if (c.client !== approved.client || c.worker !== approved.worker || host !== approved.hostname) fail(`clients[${i}] is not exactly ${approved.client} on ${approved.worker} at ${approved.hostname}`);
	});
	if (new Set(scope.clients.map((c: unknown) => (isObject(c) ? c.hostname : c))).size !== scope.clients.length) fail('a hostname is listed more than once');
	if (new Set(scope.clients.map((c: unknown) => (isObject(c) ? c.worker : c))).size !== scope.clients.length) fail('a Worker is listed more than once');
	return problems;
}

/** The one zone read the bind waits on: GET /zones/:id. The zone must answer `active` before any PUT is planned. */
export function zoneReadOperation() {
	return freeze({ method: 'GET' as const, path: `/zones/${SCOPE.zone.id}`, source: `${SDK} zones.get` });
}
/** Empty only when the provider's zone is exactly the approved zone, in the approved account, `active`, not paused and a full zone. */
export function zoneActiveProblems(zone: unknown): string[] {
	if (!isObject(zone)) return ['zone answer is not an object'];
	const problems: string[] = [];
	if (zone.id !== SCOPE.zone.id) problems.push(`zone id ${show(zone.id)} is not the approved zone`);
	if (zone.name !== SCOPE.zone.name) problems.push(`zone name ${show(zone.name)} is not ${SCOPE.zone.name}`);
	if (!isObject(zone.account) || zone.account.id !== SCOPE.accountId) problems.push('zone is not in the approved account');
	if (zone.status !== 'active') problems.push(`zone status ${show(zone.status)} is not active; the nameserver change has not been accepted, so no bind is planned`);
	if (zone.paused === true) problems.push('zone is paused');
	if (zone.type !== 'full') problems.push(`zone type ${show(zone.type)} is not full`);
	return problems;
}

/** One Workers Custom Domain PUT per client, each hostname to its own Worker in the approved zone. Throws on any scope difference. */
export function planCustomDomainBind(scope: unknown = SCOPE): readonly BindOperation[] {
	const problems = bindScopeProblems(scope);
	if (problems.length) throw new Error(`custom-domain bind refused: ${problems.join('; ')}`);
	return freeze(SCOPE.clients.map((c): BindOperation => ({
		kind: 'bind-custom-domain', client: c.client, method: 'PUT', path: `/accounts/${SCOPE.accountId}/workers/domains`,
		body: { environment: 'production', hostname: c.hostname, service: c.worker, zone_id: SCOPE.zone.id },
		source: `${SDK} workers.domains.update ("Attaches a Worker to a zone and hostname")`,
	})));
}

/** The GET of the account's Workers Custom Domains: read before the bind (nothing foreign on these hostnames) and after (the readback). */
export function domainsReadOperation() {
	return freeze({ method: 'GET' as const, path: `/accounts/${SCOPE.accountId}/workers/domains`, source: `${SDK} workers.domains.list` });
}

function readDomains(list: unknown, problems: string[]): ProviderDomain[] {
	if (!Array.isArray(list)) { problems.push('domain list is not a list'); return []; }
	const rows: ProviderDomain[] = [];
	list.forEach((d: unknown, i) => {
		const ok = isObject(d) && ['id', 'hostname', 'zone_id', 'service', 'environment'].every((k) => typeof d[k] === 'string');
		if (!ok) problems.push(`domains[${i}] is not { id, hostname, zone_id, service, environment }`);
		else rows.push({ id: d.id as string, hostname: d.hostname as string, zoneId: d.zone_id as string, service: d.service as string, environment: d.environment as string });
	});
	return rows;
}
const ownedHosts = new Set(SCOPE.clients.map((c) => c.hostname));
const ownedWorkers = new Set(SCOPE.clients.map((c) => c.worker));

/** Before the bind: an approved hostname already bound, or either Worker already holding another domain in the zone, is a HOLD. */
export function customDomainPrebindProblems(list: unknown): string[] {
	const problems: string[] = [];
	for (const d of readDomains(list, problems)) {
		if (ownedHosts.has(d.hostname)) problems.push(`${d.hostname} is already bound (to ${d.service}); a bind would override it`);
		else if (ownedWorkers.has(d.service) && d.zoneId === SCOPE.zone.id) problems.push(`${d.service} already has an unreviewed domain ${d.hostname} in the zone`);
	}
	return problems;
}

/** After the bind: each approved hostname bound exactly once, in production, in the approved zone, to its own Worker only. */
export function customDomainBindProblems(list: unknown): string[] {
	const problems: string[] = [];
	const rows = readDomains(list, problems);
	for (const c of SCOPE.clients) {
		const bound = rows.filter((d) => d.hostname === c.hostname);
		if (bound.length !== 1) problems.push(`${c.hostname} is bound ${bound.length} times, not once`);
		for (const d of bound) {
			if (d.service !== c.worker) problems.push(`${c.hostname} is bound to ${d.service}, not its own Worker ${c.worker}`);
			if (d.zoneId !== SCOPE.zone.id) problems.push(`${c.hostname} is bound in zone ${d.zoneId}, not the approved zone`);
			if (d.environment !== 'production') problems.push(`${c.hostname} is bound in environment ${d.environment}, not production`);
		}
		const others = rows.filter((d) => d.service === c.worker && d.hostname !== c.hostname && d.zoneId === SCOPE.zone.id);
		if (others.length) problems.push(`${c.worker} also serves ${others.map((d) => d.hostname).join(', ')}`);
	}
	return problems;
}

/** The rollback: DELETE only the two reviewed bindings, found in a fresh list by hostname AND their own Worker AND zone. Throws otherwise. */
export function planCustomDomainUnbind(list: unknown): readonly UnbindOperation[] {
	const problems: string[] = [];
	const rows = readDomains(list, problems);
	const ops = SCOPE.clients.flatMap((c): UnbindOperation[] => {
		const bound = rows.filter((d) => d.hostname === c.hostname);
		if (!bound.length) return [];
		if (bound.length !== 1 || bound[0]!.service !== c.worker || bound[0]!.zoneId !== SCOPE.zone.id || !/^[0-9a-f]{32}$/.test(bound[0]!.id)) {
			problems.push(`${c.hostname} is not exactly one binding of ${c.worker} in the approved zone; not detached`);
			return [];
		}
		return [{ kind: 'unbind-custom-domain', client: c.client, method: 'DELETE', path: `/accounts/${SCOPE.accountId}/workers/domains/${bound[0]!.id}`, hostname: c.hostname, source: `${SDK} workers.domains.delete ("Detaches a Worker from a zone and hostname")` }];
	});
	if (problems.length) throw new Error(`custom-domain unbind refused: ${problems.join('; ')}`);
	return freeze(ops);
}
