// RED STUB — native alpha custom-domain control capability ABSENT. This is not GRS-203 and not a historical result:
// it records that no native controller can stop the a/b.sandbox custom domains yet. The only action it knows is the
// workers.dev/preview disable, it validates nothing and reads no fresh state. The implementation replaces this file.

export const NATIVE_CONTROLS_SCHEMA = 'clearcase.native-alpha-controls/1';
export const APPROVED_NATIVE_SCOPE = { accountId: '', zone: { id: '', name: '' }, clients: [] as unknown[] };

export type NativeClient = {
	client: string;
	worker: string;
	domain: { id: string; hostname: string; zoneId: string; service: string; environment: 'production' };
	versionIds: string[];
	secretNames: string[];
	d1: { binding: string; name: string; id: string; jurisdiction: 'eu' };
	r2: { binding: string; bucket: string; jurisdiction: 'eu' };
	release: { sourceSha: string; artifactSha256: string; profileRevision: string };
	canary: { appPath: string; assetPath: string; assetSha256: string };
};
export type NativeManifest = { schema: string; accountId: string; zone: { id: string; name: string }; clients: NativeClient[] };
export type StopOperation = { kind: 'disable-workers-dev' | 'detach-custom-domain'; client: string; method: 'POST' | 'DELETE'; path: string; body?: { enabled: false; previews_enabled: false }; source: string };
export type ReadOperation = { method: 'GET'; path: string; source: string };
export type ProviderReadback = {
	accountId: string;
	zoneId: string;
	observedAt: number;
	domains: { id: string; hostname: string; zoneId: string; service: string; environment: string }[];
	routes: { id: string; pattern: string; script: string | null }[];
	workers: { worker: string; workersDev: boolean; previews: boolean; versionIds: string[]; secretNames: string[] }[];
	d1: { id: string; name: string; jurisdiction: string }[];
	r2: { bucket: string; jurisdiction: string; managedDomainEnabled: boolean; customDomains: string[] }[];
};
export type StopResult = { state: string; problems: string[]; dispatched: unknown[]; dispatchedAt?: number; before?: ProviderReadback; after?: ProviderReadback; providerProof: false; controlReady: false; retainedStorageBills: true };
export type CanaryObservation = {
	client: string;
	hostname: string;
	path: string;
	kind: 'app' | 'asset';
	phase: 'before' | 'after';
	requestedAt: number;
	transport: 'injected' | 'network';
	route: 'public-dns';
	identity: { authenticated: boolean; client: string | null };
	outcome:
		| { type: 'response'; status: number; tlsHostname: string; servedSourceSha: string | null; bodySha256: string; cache: 'miss' | 'hit' | 'unknown' }
		| { type: 'network-error'; code: 'dns-nxdomain' | 'connection-refused' | 'connection-reset' | 'tls-handshake' | 'timeout' };
};

export const parseNativeManifest = (value: unknown) => value as NativeManifest;
export const bindStageRecord = (_m: NativeManifest, _client: string, _stage: string): string[] => [];
export const buildStopPlan = (m: NativeManifest): StopOperation[] =>
	m.clients.map((c) => ({ kind: 'disable-workers-dev', client: c.client, method: 'POST', path: `/accounts/${m.accountId}/workers/scripts/${c.worker}/subdomain`, body: { enabled: false, previews_enabled: false }, source: 'absent' }));
export const buildReenablePlan = (_m: NativeManifest): { method: string; path: string; body: unknown }[] => [];
export const readOperations = (_m: NativeManifest): ReadOperation[] => [];
export const stopOperationProblems = (_m: NativeManifest, _op: StopOperation): string[] => [];
export const readbackProblems = (_m: NativeManifest, _s: ProviderReadback, _now: number, _phase: 'before' | 'after'): string[] => [];
export async function stopNativeAlpha(a: { manifest: NativeManifest; now: () => number; stopOwnerRequests: () => Promise<void>; readState: () => Promise<ProviderReadback>; dispatch: (op: StopOperation) => Promise<void> }): Promise<StopResult> {
	for (const op of buildStopPlan(a.manifest)) await a.dispatch?.(op);
	return { state: 'CAPABILITY-ABSENT', problems: [], dispatched: [], providerProof: false, controlReady: false, retainedStorageBills: true };
}
export const checkNegativeProof = (_a: { manifest: NativeManifest; stop: StopResult; observations: CanaryObservation[] }) => ({ state: 'CAPABILITY-ABSENT', problems: [] as string[], controlReady: false as const });
