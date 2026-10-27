// Native alpha custom-domain controls: a new native capability, not a repair of GRS-203. GRS-203's stop disables only
// workers.dev/previews and refuses any public route, so it proves closed ingress, not a stop of the sbx-a/sbx-b custom
// domains. This module adds a data-only, exact native target, a non-destructive custom-domain-aware stop plan, an
// orchestrator over an INJECTED transport and a post-stop negative-proof contract.
//
// It has no default transport, credentials, environment reads, network calls, timers, hooks or imports, and it never
// deletes a Worker, version, D1 database, R2 bucket or object, secret or route. The only DELETE it emits detaches one
// reviewed Workers custom-domain binding (hostname -> Worker); its re-attach is the reviewed PUT in buildReenablePlan.
//
// Evidence states: these functions reach LOCAL-PLAN-VERIFIED at most. A readback or canary passed in here is data, not
// provider proof. REMOTE CONTROL-READY needs the parent's funded manifest, scoped apply and authenticated real requests
// bound to receipts at an exact SHA; funding is decided elsewhere. Retained storage keeps billing after ingress stops.
//
// Fix round r1 (review findings H1, H2, M1-M4): the after-state must follow the LAST completed action on a valid monotonic
// clock; a StopResult is re-validated from its records and never trusted as a label; a 'network' transport label is
// data without provenance; hostnames and route patterns are matched case-free and fail closed; the readback needs the
// complete account zone inventory and every zone's route list; and the domain detach dispatches only under an explicit
// KNOWN DNS/certificate side-effect policy (default UNKNOWN, so HOLD). A satisfied contract is structural only.
//
// API source: the official cloudflare-typescript SDK 5.2.0 resources (generated from Cloudflare's API spec) as vendored
// in wrangler 4.151.1's wrangler-dist/cli.js. No account request was used to discover or confirm these paths.

const SDK = 'cloudflare-typescript 5.2.0 (vendored in wrangler 4.151.1)';
export const NATIVE_CONTROLS_SCHEMA = 'clearcase.native-alpha-controls/1';
/** How old a provider readback may be when it is judged. */
export const READBACK_MAX_AGE_MS = 60_000;

/** The approved account, zone and per-client names. Adding a client is a reviewed change here, not a request field. */
export const APPROVED_NATIVE_SCOPE = deepFreeze({
	accountId: 'fb4c31b91c5d89b7a54afbdc34823170',
	zone: { id: '1c82369e826ebe0afded65c295198fcd', name: 'clearcase.co.za' },
	clients: [
		{ client: 'client-a', worker: 'cc-sbx-a-20261023', hostname: 'sbx-a.clearcase.co.za', d1Name: 'cc-sbx-a-20261023-db', r2Bucket: 'cc-sbx-a-20261023-files' },
		{ client: 'client-b', worker: 'cc-sbx-b-20261023', hostname: 'sbx-b.clearcase.co.za', d1Name: 'cc-sbx-b-20261023-db', r2Bucket: 'cc-sbx-b-20261023-files' },
	],
});

export type NativeClient = {
	client: string;
	worker: string;
	domain: { id: string; hostname: string; zoneId: string; service: string; environment: 'production' };
	versionIds: string[];
	secretNames: string[];
	d1: { binding: 'DB'; name: string; id: string; jurisdiction: 'eu' };
	r2: { binding: 'BUCKET'; bucket: string; jurisdiction: 'eu' };
	release: { sourceSha: string; artifactSha256: string; profileRevision: string };
	canary: { appPath: string; assetPath: string; assetSha256: string };
};
export type NativeManifest = { schema: typeof NATIVE_CONTROLS_SCHEMA; accountId: string; zone: { id: string; name: string }; clients: NativeClient[] };

export type StopOperation = Readonly<{
	kind: 'disable-workers-dev' | 'detach-custom-domain';
	client: string;
	method: 'POST' | 'DELETE';
	path: string;
	body?: Readonly<{ enabled: false; previews_enabled: false }>;
	source: string;
	/** Domain detaches only: the hostname being unbound. */
	hostname?: string;
}>;
export type ReadOperation = Readonly<{
	method: 'GET';
	path: string;
	headers?: Readonly<Record<string, string>>;
	/** Query parameters of the GET. */
	query?: Readonly<Record<string, string | number>>;
	/** 'page-until-total': read page 1.. until page * per_page >= result_info.total_count; a missing total is incomplete. */
	pagination?: 'page-until-total';
	source: string;
}>;
export type ReenableOperation = Readonly<{ method: 'PUT'; path: string; body: Readonly<{ environment: 'production'; hostname: string; service: string; zone_id: string }>; source: string }>;

/** Fresh provider state as the injected reader assembled it from readOperations(). Data only, never proof by itself. */
export type ProviderReadback = {
	accountId: string;
	zoneId: string;
	/** Milliseconds, on the same clock as the injected now(). */
	observedAt: number;
	/** The account's unfiltered Workers custom-domain list. */
	domains: { id: string; hostname: string; zoneId: string; service: string; environment: string }[];
	/** The approved zone's Workers route list. */
	routes: { id: string; pattern: string; script: string | null }[];
	/** True only when every page of the approved zone's route list was read. */
	routesComplete: boolean;
	/** Every zone of the account (all pages of GET /zones for the account). `complete` is false if any page is missing. */
	accountZones: { complete: boolean; items: { id: string; name: string }[] };
	/** One entry for every account zone other than the approved zone: its complete Workers route list. */
	otherZoneRoutes: { zoneId: string; complete: boolean; routes: { id: string; pattern: string; script: string | null }[] }[];
	workers: { worker: string; workersDev: boolean; previews: boolean; versionIds: string[]; secretNames: string[] }[];
	d1: { id: string; name: string; jurisdiction: string }[];
	r2: { bucket: string; jurisdiction: string; managedDomainEnabled: boolean; customDomains: string[] }[];
};

export type StopState = 'HOLD' | 'STOP-READBACK-CONSISTENT';
export type StopResult = {
	state: StopState;
	problems: string[];
	/** One record per dispatched action: its start and the completion taken after its await, on the injected clock. */
	dispatched: { op: StopOperation; outcome: 'accepted' | 'failed'; startedAt?: number; completedAt?: number }[];
	/** The start of the first dispatch. */
	dispatchedAt?: number;
	/** The completion of the LAST dispatch; the after-state must be observed strictly later. */
	completedAt?: number;
	before?: ProviderReadback;
	/** When the before-state was judged. */
	beforeCheckedAt?: number;
	after?: ProviderReadback;
	/** When the after-state was judged. */
	afterCheckedAt?: number;
	/** Always false: injected readbacks are not provider proof. */
	providerProof: false;
	/** Always false: only the parent's real negative proof at an exact SHA can make the control ready. */
	controlReady: false;
	/** Always true: D1/R2/Worker versions are retained and keep billing after ingress stops. */
	retainedStorageBills: true;
};

export type CanaryObservation = {
	client: string;
	hostname: string;
	path: string;
	kind: 'app' | 'asset';
	phase: 'before' | 'after';
	requestedAt: number;
	/** When the response (or the error) was complete; never before requestedAt. */
	respondedAt: number;
	/** 'injected' for anything a test or stub produced. 'network' is a LABEL: it needs `provenance` and is still data. */
	transport: 'injected' | 'network';
	/** Required for 'network': the receipt that binds the request, the resolver and the verified TLS result. Data, not trust. */
	provenance?: { receiptSha256: string; resolver: 'public-dns'; tlsVerified: boolean };
	/** A real request resolved through public DNS and TLS for the hostname; host-header emulation is refused. */
	route: 'public-dns';
	identity: { authenticated: boolean; client: string | null };
	outcome:
		| { type: 'response'; status: number; tlsHostname: string; servedSourceSha: string | null; bodySha256: string; cache: 'miss' | 'hit' | 'unknown' }
		| { type: 'network-error'; code: 'dns-nxdomain' | 'connection-refused' | 'connection-reset' | 'tls-handshake' | 'timeout' };
};
export type ProofState = 'HOLD' | 'UNIT-CONTRACT-ONLY' | 'NETWORK-LABELLED-STRUCTURALLY-CONSISTENT';

const HEX32 = /^[0-9a-f]{32}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BINDING = /^[A-Z][A-Z0-9_]{0,62}$/;
const URL_PATH = /^\/[A-Za-z0-9._~/-]{0,256}$/;
const HOST_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const ROUTE_HOST = /^[a-z0-9*]([a-z0-9.*-]*[a-z0-9*])?$/;
const NETWORK_ERRORS = ['dns-nxdomain', 'connection-refused', 'connection-reset', 'tls-handshake', 'timeout'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const zoneLabel = (v: unknown) => (typeof v === 'string' ? v : show(v));
const show = (v: unknown) => (v === undefined ? 'missing' : JSON.stringify(v));
/** A canonical JSON string with object keys sorted, so provider key order never decides a comparison. */
const canonical = (v: unknown): string =>
	Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}` : JSON.stringify(v) ?? 'undefined';
const sameSet = (a: unknown, b: readonly string[]) => Array.isArray(a) && a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** A provider hostname in canonical form (lowercase, one trailing root dot removed), or null for a wildcard or any unreadable shape. */
function normHost(h: unknown): string | null {
	if (typeof h !== 'string') return null;
	const x = (h.endsWith('.') ? h.slice(0, -1) : h).toLowerCase();
	return HOST_NAME.test(x) ? x : null;
}
/** The host part of a Workers route pattern (scheme optional, host case-free), or null for any syntax this module does not know. */
function routeHost(pattern: unknown): string | null {
	if (typeof pattern !== 'string' || pattern === '' || pattern !== pattern.trim()) return null;
	const rest = pattern.replace(/^https?:\/\//i, '');
	const host = rest.split('/')[0]!.toLowerCase();
	const x = host.endsWith('.') ? host.slice(0, -1) : host;
	return ROUTE_HOST.test(x) ? x : null;
}
/** Whether a route host pattern (`*` matches any run of characters) covers `hostname`. */
function hostPatternCovers(hostPattern: string, hostname: string): boolean {
	const re = hostPattern.split('*').map((p) => p.replace(/[.\\^$+?()[\]{}|-]/g, '\\$&')).join('.*');
	return new RegExp(`^${re}$`).test(hostname);
}

function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null) {
		for (const v of Object.values(value)) deepFreeze(v);
		Object.freeze(value);
	}
	return value;
}
/** A JSON copy: drops functions, getters and prototypes so a callback cannot keep a live handle on what is judged. */
function snapshot<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], at: string, problems: string[]) {
	for (const k of Object.keys(value)) if (!allowed.includes(k)) problems.push(`${at}.${k} is not a key the native control reads`);
	for (const k of allowed) if (!(k in value)) problems.push(`${at}.${k} is missing`);
}

/**
 * The reviewed manifest as a deep-frozen copy, or a throw listing every problem. Each client must be an approved native
 * client with its approved Worker, hostname, D1 name and R2 bucket in the approved account and zone; unknown keys,
 * wildcards, foreign hosts, non-EU storage, public R2 settings and shared identifiers are refused.
 */
export function parseNativeManifest(value: unknown): NativeManifest {
	const problems: string[] = [];
	const fail = (m: string) => problems.push(m);
	if (!isObject(value)) throw new Error('manifest is not an object');
	const m = snapshot(value);
	onlyKeys(m, ['schema', 'accountId', 'zone', 'clients'], 'manifest', problems);
	if (m.schema !== NATIVE_CONTROLS_SCHEMA) fail(`schema is ${show(m.schema)}, not ${NATIVE_CONTROLS_SCHEMA}`);
	if (m.accountId !== APPROVED_NATIVE_SCOPE.accountId) fail(`account ${show(m.accountId)} is not the approved account`);
	if (!isObject(m.zone) || m.zone.id !== APPROVED_NATIVE_SCOPE.zone.id || m.zone.name !== APPROVED_NATIVE_SCOPE.zone.name) fail(`zone ${show(m.zone)} is not the approved zone`);
	else onlyKeys(m.zone, ['id', 'name'], 'manifest.zone', problems);
	if (!Array.isArray(m.clients) || m.clients.length === 0) fail('clients is not a non-empty list');
	const seen = new Map<string, string>();
	const unique = (kind: string, v: unknown, client: string) => {
		const key = `${kind}:${String(v)}`;
		const prior = seen.get(key);
		if (prior !== undefined) fail(`${kind} ${show(v)} is named by both ${prior} and ${client}`);
		seen.set(key, client);
	};
	for (const [i, c] of (Array.isArray(m.clients) ? m.clients : []).entries()) {
		const at = `clients[${i}]`;
		if (!isObject(c)) {
			fail(`${at} is not an object`);
			continue;
		}
		onlyKeys(c, ['client', 'worker', 'domain', 'versionIds', 'secretNames', 'd1', 'r2', 'release', 'canary'], at, problems);
		const name = typeof c.client === 'string' ? c.client : at;
		const approved = APPROVED_NATIVE_SCOPE.clients.find((a) => a.client === c.client);
		if (!approved) {
			fail(`${at}: client ${show(c.client)} is not an approved native client`);
			continue;
		}
		unique('client', c.client, name);
		if (c.worker !== approved.worker) fail(`${name}: worker ${show(c.worker)} is not the approved ${approved.worker}`);
		const d = c.domain;
		if (!isObject(d)) fail(`${name}: domain is ${show(d)}`);
		else {
			onlyKeys(d, ['id', 'hostname', 'zoneId', 'service', 'environment'], `${name}.domain`, problems);
			if (typeof d.id !== 'string' || !HEX32.test(d.id)) fail(`${name}: domain id ${show(d.id)} is not a 32-hex Workers domain ID`);
			if (d.hostname !== approved.hostname) fail(`${name}: hostname ${show(d.hostname)} is not the approved exact ${approved.hostname}`);
			if (d.zoneId !== APPROVED_NATIVE_SCOPE.zone.id) fail(`${name}: domain zone ${show(d.zoneId)} is not the approved zone`);
			if (d.service !== approved.worker) fail(`${name}: domain service ${show(d.service)} is not ${approved.worker}`);
			if (d.environment !== 'production') fail(`${name}: domain environment ${show(d.environment)} is not production`);
			unique('domain id', d.id, name);
		}
		if (!Array.isArray(c.versionIds) || c.versionIds.length === 0 || !c.versionIds.every((v) => typeof v === 'string' && UUID.test(v)) || new Set(c.versionIds).size !== c.versionIds.length)
			fail(`${name}: retained versionIds ${show(c.versionIds)} are not distinct Worker version UUIDs`);
		else for (const v of c.versionIds) unique('version id', v, name);
		if (!Array.isArray(c.secretNames) || !c.secretNames.every((s) => typeof s === 'string' && BINDING.test(s)) || new Set(c.secretNames).size !== c.secretNames.length) fail(`${name}: secretNames ${show(c.secretNames)} are not distinct binding names`);
		if (!isObject(c.d1)) fail(`${name}: d1 is ${show(c.d1)}`);
		else {
			onlyKeys(c.d1, ['binding', 'name', 'id', 'jurisdiction'], `${name}.d1`, problems);
			if (c.d1.binding !== 'DB' || c.d1.name !== approved.d1Name) fail(`${name}: d1 ${show(c.d1.binding)}/${show(c.d1.name)} is not DB/${approved.d1Name}`);
			if (typeof c.d1.id !== 'string' || !UUID.test(c.d1.id)) fail(`${name}: d1 id ${show(c.d1.id)} is not a UUID`);
			if (c.d1.jurisdiction !== 'eu') fail(`${name}: d1 jurisdiction ${show(c.d1.jurisdiction)} is not eu`);
			unique('d1 id', c.d1.id, name);
		}
		if (!isObject(c.r2)) fail(`${name}: r2 is ${show(c.r2)}`);
		else {
			onlyKeys(c.r2, ['binding', 'bucket', 'jurisdiction'], `${name}.r2`, problems);
			if (c.r2.binding !== 'BUCKET' || c.r2.bucket !== approved.r2Bucket) fail(`${name}: r2 ${show(c.r2.binding)}/${show(c.r2.bucket)} is not BUCKET/${approved.r2Bucket}`);
			if (c.r2.jurisdiction !== 'eu') fail(`${name}: r2 jurisdiction ${show(c.r2.jurisdiction)} is not eu`);
		}
		if (!isObject(c.release)) fail(`${name}: release is ${show(c.release)}`);
		else {
			onlyKeys(c.release, ['sourceSha', 'artifactSha256', 'profileRevision'], `${name}.release`, problems);
			if (typeof c.release.sourceSha !== 'string' || !SHA40.test(c.release.sourceSha)) fail(`${name}: release sourceSha ${show(c.release.sourceSha)} is not a 40-hex commit`);
			if (typeof c.release.artifactSha256 !== 'string' || !SHA256.test(c.release.artifactSha256)) fail(`${name}: release artifactSha256 ${show(c.release.artifactSha256)} is not sha256:<hex>`);
			if (typeof c.release.profileRevision !== 'string' || !SHA40.test(c.release.profileRevision)) fail(`${name}: release profileRevision ${show(c.release.profileRevision)} is not a 40-hex commit`);
		}
		if (!isObject(c.canary)) fail(`${name}: canary is ${show(c.canary)}`);
		else {
			onlyKeys(c.canary, ['appPath', 'assetPath', 'assetSha256'], `${name}.canary`, problems);
			for (const k of ['appPath', 'assetPath'] as const) if (typeof c.canary[k] !== 'string' || !URL_PATH.test(c.canary[k] as string)) fail(`${name}: canary ${k} ${show(c.canary[k])} is not an absolute path`);
			if (typeof c.canary.assetSha256 !== 'string' || !SHA256.test(c.canary.assetSha256)) fail(`${name}: canary assetSha256 ${show(c.canary.assetSha256)} is not sha256:<hex>`);
		}
	}
	if (problems.length) throw new Error(problems.join('\n'));
	return deepFreeze(m as NativeManifest);
}

/** Problems linking a client to the checked target -> stage -> prebuilt pipeline's stage.json; never a substitute for it. */
export function bindStageRecord(manifest: NativeManifest, client: string, stageJson: string): string[] {
	const c = manifest.clients.find((x) => x.client === client);
	if (!c) return [`no native manifest entry for ${client}`];
	let stage: unknown;
	try {
		stage = JSON.parse(stageJson);
	} catch (e) {
		return [`stage.json is not JSON: ${(e as Error).message}`];
	}
	if (!isObject(stage) || stage.schema !== 'clearcase.deploy-stage/1') return ['stage.json is not a clearcase.deploy-stage/1 record'];
	const problems: string[] = [];
	if (stage.client !== client) problems.push(`stage.json is for ${show(stage.client)}, not ${client}`);
	if (stage.artifact !== c.release.artifactSha256) problems.push(`stage.json artifact ${show(stage.artifact)} is not the manifest's ${c.release.artifactSha256}`);
	return problems;
}

/** The exact stop: per client, workers.dev+previews off, then detach its one reviewed custom-domain binding. Frozen. */
export function buildStopPlan(manifest: NativeManifest): readonly StopOperation[] {
	const a = manifest.accountId;
	return deepFreeze(
		manifest.clients.flatMap((c): StopOperation[] => [
			{ kind: 'disable-workers-dev', client: c.client, method: 'POST', path: `/accounts/${a}/workers/scripts/${c.worker}/subdomain`, body: { enabled: false, previews_enabled: false }, source: `${SDK} workers.scripts.subdomain.create` },
			{ kind: 'detach-custom-domain', client: c.client, method: 'DELETE', path: `/accounts/${a}/workers/domains/${c.domain.id}`, hostname: c.domain.hostname, source: `${SDK} workers.domains.delete ("Detaches a Worker from a zone and hostname")` },
		]),
	);
}

/** The reviewed re-attach for each detached domain (not run here). workers.dev and previews stay off. */
export function buildReenablePlan(manifest: NativeManifest): readonly ReenableOperation[] {
	return deepFreeze(
		manifest.clients.map((c): ReenableOperation => ({
			method: 'PUT',
			path: `/accounts/${manifest.accountId}/workers/domains`,
			body: { environment: 'production', hostname: c.domain.hostname, service: c.worker, zone_id: manifest.zone.id },
			source: `${SDK} workers.domains.update ("Attaches a Worker to a zone and hostname")`,
		})),
	);
}

/** The GET requests a fresh ProviderReadback is assembled from. R2 reads carry the EU jurisdiction header. */
export function readOperations(manifest: NativeManifest): readonly ReadOperation[] {
	const a = manifest.accountId;
	const eu = { 'cf-r2-jurisdiction': 'eu' };
	return deepFreeze([
		{ method: 'GET', path: `/accounts/${a}/workers/domains`, source: `${SDK} workers.domains.list` },
		{ method: 'GET', path: `/zones/${manifest.zone.id}/workers/routes`, source: `${SDK} workers.routes.list` },
		// The account's zone inventory. SDK 5.2.0 `zones.list` is GET /zones with page pagination (V4PagePaginationArray); the
		// `account.id` filter is the one wrangler 4.151.1 itself sends (the SDK's vendored JS has no parameter types).
		{ method: 'GET', path: '/zones', query: { 'account.id': a, per_page: 50 }, pagination: 'page-until-total', source: `${SDK} zones.list` },
		...manifest.clients.flatMap((c): ReadOperation[] => [
			{ method: 'GET', path: `/accounts/${a}/workers/scripts/${c.worker}/subdomain`, source: `${SDK} workers.scripts.subdomain.get` },
			{ method: 'GET', path: `/accounts/${a}/workers/scripts/${c.worker}/versions`, source: `${SDK} workers.scripts.versions.list` },
			{ method: 'GET', path: `/accounts/${a}/workers/scripts/${c.worker}/deployments`, source: `${SDK} workers.scripts.deployments.list` },
			{ method: 'GET', path: `/accounts/${a}/workers/scripts/${c.worker}/secrets`, source: `${SDK} workers.scripts.secrets.list` },
			{ method: 'GET', path: `/accounts/${a}/d1/database/${c.d1.id}`, source: `${SDK} d1.database.get` },
			{ method: 'GET', path: `/accounts/${a}/r2/buckets/${c.r2.bucket}`, headers: eu, source: `${SDK} r2.buckets.get` },
			{ method: 'GET', path: `/accounts/${a}/r2/buckets/${c.r2.bucket}/domains/managed`, headers: eu, source: `${SDK} r2.buckets.domains.managed.list` },
			{ method: 'GET', path: `/accounts/${a}/r2/buckets/${c.r2.bucket}/domains/custom`, headers: eu, source: `${SDK} r2.buckets.domains.custom.list` },
		]),
	]);
}

/** The GET of one account zone's Workers routes (SDK workers.routes.list is SinglePage). Needed for every listed zone. */
export function zoneRoutesReadOperation(manifest: NativeManifest, zoneId: string): ReadOperation {
	if (typeof zoneId !== 'string' || !HEX32.test(zoneId)) throw new Error(`zone ${show(zoneId)} is not a 32-hex zone ID`);
	void manifest;
	return deepFreeze({ method: 'GET', path: `/zones/${zoneId}/workers/routes`, source: `${SDK} workers.routes.list` });
}

/** Problems with `op` as a stop action: it must be exactly one of this manifest's planned operations. */
export function stopOperationProblems(manifest: NativeManifest, op: StopOperation): string[] {
	const planned = buildStopPlan(manifest).find((p) => p.method === op?.method && p.path === op?.path);
	if (!planned) return [`${show(op?.method)} ${show(op?.path)} is not a reviewed non-destructive stop operation`];
	return canonical(snapshot(op)) === canonical(planned) ? [] : [`${op.method} ${op.path} differs from the reviewed operation`];
}

/** Problems with one Workers route: unknown syntax, or a route that runs an owned Worker or covers an owned hostname. */
function routeProblem(route: unknown, hosts: ReadonlySet<string>, workers: ReadonlySet<string>, prefix: string): string | null {
	const r = isObject(route) ? route : {};
	const host = routeHost(r.pattern);
	if (host === null) return `${prefix}Workers route ${show(r.pattern)} -> ${show(r.script)} has unknown syntax; failing closed, not treated as uncovered`;
	if ((typeof r.script === 'string' && workers.has(r.script.toLowerCase())) || [...hosts].some((h) => hostPatternCovers(host, h)))
		return `${prefix}Workers route ${show(r.pattern)} -> ${show(r.script)} exposes an owned Worker or hostname; native ingress is custom domains only`;
	return null;
}

/**
 * Problems with a provider readback for `phase`. Both phases need a fresh, complete, exact state: the manifest's Workers,
 * retained versions and secret names, EU D1 and private EU R2, the complete account zone inventory with every zone's
 * complete Workers route list, and no Workers route on an owned Worker or covering an owned hostname (hostnames and
 * patterns are matched case-free; any wildcard or unknown syntax fails closed). Before: each owned custom domain bound
 * exactly once, nothing else on owned hostnames or Workers. After: no custom-domain binding on any owned hostname or
 * Worker, and workers.dev and previews off.
 */
export function readbackProblems(manifest: NativeManifest, state: ProviderReadback, now: number, phase: 'before' | 'after'): string[] {
	const problems: string[] = [];
	const fail = (m: string) => problems.push(`${phase}: ${m}`);
	if (!isObject(state)) return [`${phase}: readback is not an object`];
	const keys = ['accountId', 'zoneId', 'observedAt', 'domains', 'routes', 'routesComplete', 'accountZones', 'otherZoneRoutes', 'workers', 'd1', 'r2'];
	for (const k of Object.keys(state)) if (!keys.includes(k)) fail(`readback key ${k} is unread; refusing a partial or unknown state`);
	if (!Number.isFinite(now) || !Number.isFinite(state.observedAt) || state.observedAt > now || now - state.observedAt > READBACK_MAX_AGE_MS) fail('readback is missing, stale or future-dated');
	if (state.accountId !== manifest.accountId) fail(`readback account ${show(state.accountId)} is not the manifest account`);
	if (state.zoneId !== manifest.zone.id) fail(`readback zone ${show(state.zoneId)} is not the manifest zone`);
	for (const k of ['domains', 'routes', 'workers', 'd1', 'r2'] as const) if (!Array.isArray(state[k])) return [...problems, `${phase}: readback ${k} is not a list`];
	const workers = new Set(manifest.clients.map((c) => c.worker.toLowerCase()));
	const hosts = new Set(manifest.clients.map((c) => c.domain.hostname));
	const exactKeys = (v: unknown, allowed: string[], at: string) => {
		if (!isObject(v)) return void fail(`${at} is not an object`);
		if (Object.keys(v).length !== allowed.length || !allowed.every((k) => k in v)) fail(`${at} has keys ${show(Object.keys(v))}, not exactly ${show(allowed)}`);
	};
	state.domains.forEach((d, i) => exactKeys(d, ['id', 'hostname', 'zoneId', 'service', 'environment'], `domains[${i}]`));
	state.routes.forEach((r, i) => exactKeys(r, ['id', 'pattern', 'script'], `routes[${i}]`));
	state.workers.forEach((w, i) => exactKeys(w, ['worker', 'workersDev', 'previews', 'versionIds', 'secretNames'], `workers[${i}]`));
	state.d1.forEach((d, i) => exactKeys(d, ['id', 'name', 'jurisdiction'], `d1[${i}]`));
	state.r2.forEach((r, i) => exactKeys(r, ['bucket', 'jurisdiction', 'managedDomainEnabled', 'customDomains'], `r2[${i}]`));
	for (const w of state.workers) if (!workers.has(String(w?.worker).toLowerCase()) || !manifest.clients.some((c) => c.worker === w?.worker)) fail(`readback names Worker ${show(w?.worker)}, which is not in the manifest`);
	for (const c of manifest.clients) {
		const ws = state.workers.filter((w) => w?.worker === c.worker);
		if (ws.length !== 1) fail(`Worker ${c.worker} appears ${ws.length} times, not once`);
		const w = ws[0];
		if (w) {
			if (typeof w.workersDev !== 'boolean' || typeof w.previews !== 'boolean') fail(`${c.worker} workers.dev/preview settings are not booleans`);
			if (phase === 'after' && (w.workersDev !== false || w.previews !== false)) fail(`${c.worker} workers.dev or preview URLs are still enabled`);
			if (!sameSet(w.versionIds, c.versionIds)) fail(`${c.worker} retained version IDs ${show(w.versionIds)} are not the manifest's ${show(c.versionIds)}`);
			if (!sameSet(w.secretNames, c.secretNames)) fail(`${c.worker} secret names ${show(w.secretNames)} are not the manifest's ${show(c.secretNames)}`);
		}
		const d1 = state.d1.filter((d) => d?.id === c.d1.id);
		if (d1.length !== 1 || d1[0]!.name !== c.d1.name || d1[0]!.jurisdiction !== 'eu') fail(`D1 ${c.d1.name} ${c.d1.id} is not present exactly once as EU`);
		const r2 = state.r2.filter((r) => r?.bucket === c.r2.bucket);
		if (r2.length !== 1 || r2[0]!.jurisdiction !== 'eu') fail(`R2 ${c.r2.bucket} is not present exactly once as EU`);
		else if (r2[0]!.managedDomainEnabled !== false || !Array.isArray(r2[0]!.customDomains) || r2[0]!.customDomains.length !== 0) fail(`R2 ${c.r2.bucket} has a public r2.dev or custom domain`);
	}
	if (state.d1.length !== manifest.clients.length) fail(`readback lists ${state.d1.length} D1 databases, not the manifest's ${manifest.clients.length}`);
	if (state.r2.length !== manifest.clients.length) fail(`readback lists ${state.r2.length} R2 buckets, not the manifest's ${manifest.clients.length}`);

	// Routes: the approved zone, then every other zone of the account. Nothing is judged covered when it was not fully read.
	if (state.routesComplete !== true) fail(`approved zone ${manifest.zone.id} route list is not complete (every page read); refusing a partial route inventory`);
	for (const r of state.routes) {
		const p = routeProblem(r, hosts, workers, '');
		if (p) fail(p);
	}
	const inv = state.accountZones;
	let listed: string[] | undefined;
	if (inv === undefined) fail('account zone inventory is missing; a route in a zone not read would keep serving unnoticed');
	else if (!isObject(inv)) fail('account zone inventory is not an object');
	else {
		exactKeys(inv, ['complete', 'items'], 'accountZones');
		if (inv.complete !== true) fail('account zone inventory is not complete (every page of the account zone list read); HOLD');
		if (!Array.isArray(inv.items)) fail('accountZones.items is not a list');
		else {
			inv.items.forEach((z, i) => exactKeys(z, ['id', 'name'], `accountZones.items[${i}]`));
			const ids = inv.items.map((z) => (isObject(z) ? z.id : undefined));
			if (ids.some((id) => typeof id !== 'string' || !HEX32.test(id))) fail('account zone inventory has a zone ID that is not a 32-hex zone ID');
			else if (new Set(ids).size !== ids.length) fail('account zone inventory names a zone more than once');
			else listed = ids as string[];
			if (!ids.includes(manifest.zone.id)) fail(`approved zone ${manifest.zone.id} is not in the zone inventory`);
		}
	}
	const other = state.otherZoneRoutes;
	if (!Array.isArray(other)) fail('other-zone routes list is missing or not a list; every other zone needs its complete route list');
	else {
		other.forEach((z, i) => exactKeys(z, ['zoneId', 'complete', 'routes'], `otherZoneRoutes[${i}]`));
		if (listed) {
			const expected = listed.filter((id) => id !== manifest.zone.id);
			for (const id of expected) {
				const n = other.filter((z) => z?.zoneId === id).length;
				if (n === 0) fail(`zone ${id} has no route list; a route there could still run an owned Worker`);
				else if (n > 1) fail(`zone ${id} appears more than once in the route lists`);
			}
			for (const z of other) if (!expected.includes(z?.zoneId)) fail(`zone ${zoneLabel(z?.zoneId)} is not in the inventory of other zones`);
		}
		for (const z of other) {
			if (!isObject(z)) continue;
			if (z.complete !== true) fail(`zone ${zoneLabel(z.zoneId)} route list is not complete (every page read)`);
			if (!Array.isArray(z.routes)) {
				fail(`zone ${zoneLabel(z.zoneId)} routes is not a list`);
				continue;
			}
			z.routes.forEach((r, i) => exactKeys(r, ['id', 'pattern', 'script'], `otherZoneRoutes[${zoneLabel(z.zoneId)}].routes[${i}]`));
			for (const r of z.routes) {
				const p = routeProblem(r, hosts, workers, `zone ${zoneLabel(z.zoneId)} `);
				if (p) fail(p);
			}
		}
	}

	// Custom domains: hostnames are matched case-free; a wildcard or unreadable hostname fails closed.
	const owned: typeof state.domains = [];
	for (const d of state.domains) {
		const host = normHost(d?.hostname);
		if (host === null) {
			fail(`custom domain hostname ${show(d?.hostname)} is unreadable or a wildcard; failing closed, not treated as unowned`);
			continue;
		}
		if (hosts.has(host) || (typeof d?.service === 'string' && workers.has(d.service.toLowerCase()))) owned.push(d);
	}
	if (phase === 'after') for (const d of owned) fail(`custom domain ${show(d.hostname)} -> ${show(d.service)} is still bound`);
	else {
		for (const d of owned) {
			const c = manifest.clients.find((x) => x.domain.id === d.id);
			if (!c || canonical({ ...d, hostname: normHost(d.hostname) }) !== canonical({ id: c.domain.id, hostname: c.domain.hostname, zoneId: c.domain.zoneId, service: c.domain.service, environment: c.domain.environment }))
				fail(`custom domain ${show(d.hostname)} -> ${show(d.service)} (${show(d.id)}) is not a reviewed binding`);
		}
		for (const c of manifest.clients) if (owned.filter((d) => d.id === c.domain.id).length !== 1) fail(`reviewed custom domain ${c.domain.hostname} is not bound exactly once`);
	}
	return problems;
}

/** The DNS and certificate side effects of the Workers custom-domain DELETE are not stated in the SDK. This is the default. */
export const UNKNOWN_DOMAIN_DETACH_POLICY = deepFreeze({
	schema: 'clearcase.native-domain-detach-policy/1',
	status: 'UNKNOWN',
	reason: `${SDK} workers.domains.delete says only "Detaches a Worker from a zone and hostname"; its DNS record and certificate effects are unconfirmed in a primary source`,
});

/**
 * Problems with a reviewed domain-detach side-effect policy for this manifest. The policy must be explicitly KNOWN,
 * for exactly this account, zone and these domains, with a named primary source and no new paid certificate or other DNS
 * record touched. This is a structural check of data the parent supplies after reading primary docs: it is NOT owner
 * approval, a cryptographic trust anchor or provider proof, and a missing or UNKNOWN policy is always a problem.
 */
export function domainDetachPolicyProblems(manifest: NativeManifest, policy: unknown): string[] {
	if (!isObject(policy) || policy.status !== 'KNOWN') return [`domain detach DNS record and certificate side effects are UNKNOWN (policy status ${show(isObject(policy) ? policy.status : undefined)}); HOLD before any dispatch, no domain DELETE without a reviewed KNOWN policy`];
	const problems: string[] = [];
	const fail = (m: string) => problems.push(m);
	onlyKeys(policy, ['schema', 'status', 'appliesTo', 'dnsRecord', 'certificate', 'newPaidCertificate', 'otherDnsRecordsTouched', 'source'], 'policy', problems);
	if (policy.schema !== 'clearcase.native-domain-detach-policy/1') fail(`policy schema ${show(policy.schema)} is not clearcase.native-domain-detach-policy/1`);
	const wanted = { accountId: manifest.accountId, zoneId: manifest.zone.id, domains: manifest.clients.map((c) => ({ id: c.domain.id, hostname: c.domain.hostname })) };
	if (canonical(policy.appliesTo) !== canonical(wanted)) fail(`policy applies to ${show(policy.appliesTo)}, not this manifest's ${show(wanted)}`);
	for (const k of ['dnsRecord', 'certificate'] as const) if (policy[k] !== 'retained' && policy[k] !== 'removed') fail(`policy.${k} ${show(policy[k])} is not retained or removed`);
	if (policy.newPaidCertificate !== false) fail(`policy.newPaidCertificate ${show(policy.newPaidCertificate)} must be false`);
	if (policy.otherDnsRecordsTouched !== false) fail(`policy.otherDnsRecordsTouched ${show(policy.otherDnsRecordsTouched)} must be false`);
	const src = policy.source;
	if (!isObject(src)) fail(`policy.source ${show(src)} is not an object naming a primary source`);
	else {
		onlyKeys(src, ['document', 'section', 'excerptSha256'], 'policy.source', problems);
		if (typeof src.document !== 'string' || !/^https:\/\/\S+$/.test(src.document)) fail(`policy.source.document ${show(src.document)} is not an https document`);
		if (typeof src.section !== 'string' || src.section.trim() === '') fail('policy.source.section is empty');
		if (typeof src.excerptSha256 !== 'string' || !SHA256.test(src.excerptSha256)) fail(`policy.source.excerptSha256 ${show(src.excerptSha256)} is not sha256:<hex>`);
	}
	return problems;
}

type Transport = {
	manifest: NativeManifest;
	now: () => number;
	stopOwnerRequests: () => Promise<void>;
	readState: () => Promise<ProviderReadback>;
	dispatch: (op: StopOperation) => Promise<void>;
	/** A reviewed KNOWN domain-detach side-effect policy. Absent means UNKNOWN, which is a HOLD before any dispatch. */
	domainDetachPolicy?: unknown;
};

/** The results stopNativeAlpha itself issued in this process. This is not provider origin, only "not hand-built here". */
const ISSUED = new WeakSet<object>();

/**
 * Stops the owner's new requests first, reads and validates the complete before-state, then (only under a reviewed
 * KNOWN domain-detach policy) dispatches each reviewed operation exactly once (no retries, no fallback), then reads a
 * fresh after-state that must be observed strictly after the LAST dispatch completed. Every clock reading must be finite
 * and non-decreasing. Any missing callback, invalid manifest, unknown policy, bad state, failed dispatch or unreadable
 * after-state returns HOLD; the only actions ever taken are the reviewed non-destructive ones. The manifest, the policy and
 * the plan are copied and frozen before the first await. The result is a frozen record, never provider proof.
 */
export async function stopNativeAlpha(a: Transport): Promise<StopResult> {
	const dispatched: StopResult['dispatched'] = [];
	const result = (state: StopState, problems: string[], extra: Partial<StopResult> = {}): StopResult => {
		const out = deepFreeze(snapshot({ state, problems, dispatched, ...extra, providerProof: false as const, controlReady: false as const, retainedStorageBills: true as const }));
		ISSUED.add(out);
		return out;
	};
	if (!isObject(a) || typeof a.now !== 'function' || typeof a.stopOwnerRequests !== 'function' || typeof a.readState !== 'function' || typeof a.dispatch !== 'function')
		return result('HOLD', ['no injected now/stopOwnerRequests/readState/dispatch; this module has no default transport']);
	let manifest: NativeManifest | undefined;
	let invalid: string | undefined;
	try {
		manifest = parseNativeManifest(a.manifest);
	} catch (e) {
		invalid = (e as Error).message;
	}
	let policy: unknown;
	try {
		policy = snapshot(a.domainDetachPolicy ?? UNKNOWN_DOMAIN_DETACH_POLICY);
	} catch (e) {
		policy = { status: `unreadable: ${(e as Error).message}` };
	}
	const plan = manifest ? buildStopPlan(manifest) : undefined;
	const { now, stopOwnerRequests, readState, dispatch } = a;
	try {
		await stopOwnerRequests();
	} catch (e) {
		return result('HOLD', [`owner requests were not confirmed stopped: ${(e as Error).message}`]);
	}
	if (!manifest || !plan) return result('HOLD', [`manifest refused: ${invalid}`]);
	const gate = domainDetachPolicyProblems(manifest, policy);
	if (gate.length) return result('HOLD', [`domain detach not dispatched: ${gate.join('; ')}`]);
	const progress: Partial<StopResult> = {};
	try {
		return await run(manifest, plan, progress);
	} catch (e) {
		return result('HOLD', [`stop interrupted, outcome unknown: ${(e as Error).message}`], progress);
	}

	async function run(manifest: NativeManifest, plan: readonly StopOperation[], progress: Partial<StopResult>): Promise<StopResult> {
		let last = -Infinity;
		/** One valid clock reading: finite and not earlier than any reading before it. */
		const tick = (what: string): number => {
			const v = now();
			if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`clock returned ${show(v)} at ${what}`);
			if (v < last) throw new Error(`clock went backwards at ${what}: ${v} after ${last}`);
			last = v;
			return v;
		};
		let before: ProviderReadback;
		try {
			before = snapshot(await readState());
		} catch (e) {
			return result('HOLD', [`before-state unreadable: ${(e as Error).message}`]);
		}
		progress.before = before;
		const beforeCheckedAt = tick('before-state check');
		progress.beforeCheckedAt = beforeCheckedAt;
		const initial = readbackProblems(manifest, before, beforeCheckedAt, 'before');
		if (initial.length) return result('HOLD', initial, { before, beforeCheckedAt });
		const clockProblems: string[] = [];
		const reading = (what: string): number | undefined => {
			try {
				return tick(what);
			} catch (e) {
				clockProblems.push((e as Error).message);
				return undefined;
			}
		};
		for (const op of plan) {
			const startedAt = reading(`start of ${op.method} ${op.path}`);
			if (progress.dispatchedAt === undefined && startedAt !== undefined) progress.dispatchedAt = startedAt;
			let outcome: 'accepted' | 'failed' = 'accepted';
			try {
				await dispatch(op);
			} catch {
				outcome = 'failed';
			}
			const completedAt = reading(`completion of ${op.method} ${op.path}`);
			dispatched.push({ op, outcome, ...(startedAt !== undefined ? { startedAt } : {}), ...(completedAt !== undefined ? { completedAt } : {}) });
			if (completedAt !== undefined) progress.completedAt = completedAt;
		}
		const problems = dispatched.filter((d) => d.outcome === 'failed').map((d) => `partial stop: ${d.op.method} ${d.op.path}${d.op.hostname ? ` (${d.op.hostname})` : ''} failed; liability retained, no fallback`);
		const base = { before, beforeCheckedAt, ...(progress.dispatchedAt !== undefined ? { dispatchedAt: progress.dispatchedAt } : {}), ...(progress.completedAt !== undefined ? { completedAt: progress.completedAt } : {}) };
		if (clockProblems.length) return result('HOLD', [...problems, ...clockProblems.map((m) => `invalid clock, the stop is not timed and cannot be judged: ${m}`)], base);
		const completedAt = progress.completedAt!;
		let after: ProviderReadback;
		try {
			after = snapshot(await readState());
		} catch (e) {
			return result('HOLD', [...problems, `after-state unreadable, disable outcome unknown: ${(e as Error).message}`], base);
		}
		const afterCheckedAt = tick('after-state check');
		problems.push(...readbackProblems(manifest, after, afterCheckedAt, 'after'));
		if (!(after.observedAt > completedAt)) problems.push(`after-state observed at ${show(after.observedAt)} predates the last completed action at ${completedAt}; it may show a state from before the stop finished`);
		if (!(after.observedAt > before.observedAt)) problems.push('after-state predates the before-state');
		progress.after = after;
		return result(problems.length ? 'HOLD' : 'STOP-READBACK-CONSISTENT', problems, { ...base, after, afterCheckedAt });
	}
}

/**
 * Problems with a StopResult judged from its own records, not its labels. It must be a result stopNativeAlpha issued in
 * this process (a copy, a persisted file or a hand-built object is refused: it cannot be re-judged here), and its records
 * must show: a before-state that passes readbackProblems when it was checked; exactly the reviewed stop plan, in order,
 * every action accepted with a start and a completion; and an after-state that passes readbackProblems and was observed
 * strictly after the last completion; all on one non-decreasing clock. Being issued here proves no provider origin.
 */
function stopRecordProblems(manifest: NativeManifest, stop: StopResult): string[] {
	const problems: string[] = [];
	const fail = (m: string) => problems.push(m);
	if (!isObject(stop) || !ISSUED.has(stop)) fail('the stop result was not issued by stopNativeAlpha in this process (a copy, a persisted file or a hand-built result cannot be re-judged here)');
	if (!isObject(stop)) return problems;
	if (stop.state !== 'STOP-READBACK-CONSISTENT' || !Array.isArray(stop.problems) || stop.problems.length) fail('the stop result is not readback-consistent');
	const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
	if (!isObject(stop.before)) fail('the stop result has no before-state; the stop cannot be judged without it');
	else if (!finite(stop.beforeCheckedAt)) fail('the stop result has no before-state check time');
	else problems.push(...readbackProblems(manifest, stop.before, stop.beforeCheckedAt, 'before'));
	const plan = buildStopPlan(manifest);
	const records = Array.isArray(stop.dispatched) ? stop.dispatched : [];
	const same = records.length === plan.length && plan.every((p, i) => records[i] && canonical(snapshot(records[i]!.op)) === canonical(p) && records[i]!.outcome === 'accepted');
	if (!same) fail('the dispatched records are not exactly the reviewed stop plan, once each, in order, all accepted');
	let ordered = same && finite(stop.beforeCheckedAt);
	let prev = finite(stop.beforeCheckedAt) ? stop.beforeCheckedAt : NaN;
	for (const d of same ? records : []) {
		if (!finite(d.startedAt) || !finite(d.completedAt) || !(d.startedAt >= prev) || !(d.completedAt >= d.startedAt)) ordered = false;
		else prev = d.completedAt;
	}
	if (!ordered) fail('the dispatched records lack valid ordered start and completion times after the before-state check');
	else if (stop.dispatchedAt !== records[0]!.startedAt || stop.completedAt !== records[records.length - 1]!.completedAt) fail('the stop result times do not match its dispatched records');
	if (!isObject(stop.after)) fail('the stop result has no after-state');
	else if (!finite(stop.afterCheckedAt)) fail('the stop result has no after-state check time');
	else {
		problems.push(...readbackProblems(manifest, stop.after, stop.afterCheckedAt, 'after'));
		if (ordered && !(stop.after.observedAt > prev)) fail(`the stop after-state observed at ${show(stop.after.observedAt)} predates the last completed action at ${prev}`);
		if (isObject(stop.before) && !(stop.after.observedAt > stop.before.observedAt)) fail('the stop after-state predates its before-state');
	}
	return problems;
}

/**
 * The post-stop negative-proof contract. The stop is re-validated from its records (see stopRecordProblems). For each
 * client and each of its app and original-asset canaries it needs one authenticated before request through public DNS/TLS
 * that served the deployed build or asset bytes, fresh (no older than the readback bound), uncached and finished before the
 * first action began, and one after request, taken after the after-readback, that is a classified network error or an
 * unbound error response with no build, no app or asset bytes and no cache. Redirects, auth denials, other hosts,
 * anonymous or emulated requests are refused. A 'network' label needs provenance and is still self-asserted data.
 * Injected observations cap the result at UNIT-CONTRACT-ONLY. A satisfied contract is STRUCTURAL ONLY: this validator
 * runs over injected data and can never certify remote proof or return control-ready; the parent binds a satisfied
 * contract to real receipts at an exact SHA, after a funded manifest and a scoped apply.
 */
export function checkNegativeProof(a: { manifest: NativeManifest; stop: StopResult; observations: CanaryObservation[] }): { state: ProofState; problems: string[]; controlReady: false; remoteProof: false; structuralOnly: true } {
	const problems: string[] = [];
	const done = (state: ProofState) => ({ state: problems.length ? ('HOLD' as const) : state, problems, controlReady: false as const, remoteProof: false as const, structuralOnly: true as const });
	const stop = a.stop;
	if (stop?.state !== 'STOP-READBACK-CONSISTENT' || !stop.after || stop.dispatchedAt === undefined) {
		problems.push('the stop is not readback-consistent; canaries cannot upgrade a HOLD');
		return done('HOLD');
	}
	let manifest: NativeManifest;
	try {
		manifest = parseNativeManifest(a.manifest);
	} catch (e) {
		problems.push(`manifest refused: ${(e as Error).message}`);
		return done('HOLD');
	}
	problems.push(...stopRecordProblems(manifest, stop));
	const obs: CanaryObservation[] = Array.isArray(a.observations) ? snapshot(a.observations) : [];
	const hosts = new Map(manifest.clients.map((c) => [c.domain.hostname, c]));
	const firstStart = stop.dispatchedAt;
	const beforeAt = stop.before?.observedAt;
	for (const o of obs) if (!hosts.has(o.hostname)) problems.push(`canary on ${show(o.hostname)} is not an owned custom domain`);
	for (const c of manifest.clients)
		for (const kind of ['app', 'asset'] as const) {
			const path = kind === 'app' ? c.canary.appPath : c.canary.assetPath;
			const before: CanaryObservation[] = [];
			for (const phase of ['before', 'after'] as const) {
				const at = `${c.client} ${kind} ${phase} (${c.domain.hostname}${path})`;
				const found = obs.filter((o) => o.hostname === c.domain.hostname && o.kind === kind && o.phase === phase);
				if (found.length !== 1) {
					problems.push(`${at}: ${found.length} observations, not exactly one`);
					continue;
				}
				const o = found[0]!;
				if (phase === 'before') before.push(o);
				if (o.client !== c.client || o.path !== path) problems.push(`${at}: observation names ${show(o.client)} ${show(o.path)}`);
				if (o.identity?.authenticated !== true) problems.push(`${at}: request was not authenticated as a known app user`);
				else if (o.identity.client !== c.client) problems.push(`${at}: identity is ${show(o.identity.client)}, not ${c.client}`);
				if (o.route !== 'public-dns') problems.push(`${at}: route ${show(o.route)} is emulation, not a public-dns request`);
				if (!Number.isFinite(o.requestedAt) || !Number.isFinite(o.respondedAt) || o.respondedAt < o.requestedAt) problems.push(`${at}: requestedAt ${show(o.requestedAt)} and respondedAt ${show(o.respondedAt)} are not a valid start and end`);
				if (o.transport !== 'injected' && o.transport !== 'network') problems.push(`${at}: transport ${show(o.transport)} is unknown`);
				else if (o.transport === 'network') {
					const p = o.provenance;
					const shaped = isObject(p) && Object.keys(p).length === 3 && typeof p.receiptSha256 === 'string' && SHA256.test(p.receiptSha256) && p.resolver === 'public-dns' && typeof p.tlsVerified === 'boolean';
					if (!shaped) problems.push(`${at}: a 'network' transport label has no valid provenance (receipt digest, public-dns resolver, TLS result); a self-labelled observation is not evidence`);
					else if (o.outcome?.type === 'response' && p.tlsVerified !== true) problems.push(`${at}: provenance does not record a verified TLS result`);
				}
				const out = o.outcome;
				if (out?.type === 'response' && out.tlsHostname !== c.domain.hostname) problems.push(`${at}: TLS hostname ${show(out.tlsHostname)} is not ${c.domain.hostname} (emulation)`);
				if (phase === 'before') {
					if (!(o.requestedAt < firstStart)) problems.push(`${at}: positive canary was not taken before the dispatch`);
					else if (!(o.respondedAt <= firstStart)) problems.push(`${at}: positive canary finished after the first action started`);
					if (typeof beforeAt === 'number' && o.requestedAt < beforeAt - READBACK_MAX_AGE_MS) problems.push(`${at}: positive canary requested at ${o.requestedAt} is older than ${READBACK_MAX_AGE_MS} ms before the before-readback at ${beforeAt}`);
					if (out?.type !== 'response' || out.status !== 200) problems.push(`${at}: positive canary did not return 200`);
					else {
						if (out.cache !== 'miss') problems.push(`${at}: positive canary cache state ${show(out.cache)} is not a miss; a cached body is not a live app`);
						if (kind === 'app' && out.servedSourceSha !== c.release.sourceSha) problems.push(`${at}: served build source ${show(out.servedSourceSha)} is not the deployed ${c.release.sourceSha}`);
						else if (kind === 'asset' && out.bodySha256 !== c.canary.assetSha256) problems.push(`${at}: asset bytes ${show(out.bodySha256)} are not the deployed ${c.canary.assetSha256}`);
					}
					continue;
				}
				if (!(o.requestedAt > stop.after.observedAt)) problems.push(`${at}: after canary was not taken after the after-readback`);
				if (out?.type === 'network-error') {
					if (!NETWORK_ERRORS.includes(out.code)) problems.push(`${at}: network error ${show(out.code)} is not a classified outcome`);
					continue;
				}
				if (out?.type !== 'response' || !Number.isInteger(out.status)) {
					problems.push(`${at}: outcome ${show(out)} is not classified`);
					continue;
				}
				const known = [c.canary.assetSha256, ...before.map((b) => (b.outcome.type === 'response' ? b.outcome.bodySha256 : ''))];
				if (out.status >= 200 && out.status < 300) problems.push(`${at}: status ${out.status} means the ${kind} is still served`);
				else if (out.status >= 300 && out.status < 400) problems.push(`${at}: redirect ${out.status} is not a negative result; follow and classify it`);
				else if ([401, 403, 407].includes(out.status)) problems.push(`${at}: auth denial ${out.status} shows something still answering, not an unbound domain`);
				else if (out.status < 400) problems.push(`${at}: status ${out.status} is not classified`);
				if (out.servedSourceSha !== null) problems.push(`${at}: a build ${show(out.servedSourceSha)} is still served`);
				if (known.includes(out.bodySha256)) problems.push(`${at}: app or asset bytes are still served`);
				if (out.cache !== 'miss') problems.push(`${at}: cache state ${show(out.cache)} could be a cached success`);
			}
		}
	return done(obs.some((o) => o.transport !== 'network') ? 'UNIT-CONTRACT-ONLY' : 'NETWORK-LABELLED-STRUCTURALLY-CONSISTENT');
}
