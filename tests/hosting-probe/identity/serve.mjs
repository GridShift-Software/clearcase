// Node host for the identity probe's two Workers (GRS-108). Wrangler runs on Node only; Bun hosts the build and the
// runner. Usage, from harness.ts only: node serve.mjs '<config JSON>' with the keys on fd 3 (CLEARCASE_SECRETS_FD=3).
//
// It takes the keys off fd 3 once (takeSecrets(), the child half of deploy/probes/secrets.ts), so they are never in
// this process's environment, argv or a file, and hands them to Wrangler's startWorker as secret_text bindings: Wrangler
// prints them as hidden and passes them to workerd inside its config, over a pipe. Each Worker is local: its D1 and R2
// are Miniflare's, under its own persist directory (harness.ts, persistOf). On SIGINT or SIGTERM, or when its stdin (a pipe from the runner) ends, it disposes both Workers and exits 0.
//
// "serve: ready" means both Workers are live. Wrangler's worker.ready is only its ProxyWorker listening; the Worker's own
// workerd starts after the bundle, and the proxy holds every request until it has. A Worker whose workerd fails to start
// would leave the proxy holding them for good, and Wrangler logs that failure at debug level only, so every error event
// from Wrangler is printed here and ends this process with exit 1.
import { unstable_startWorker } from 'wrangler';
import { takeSecrets } from '../../../deploy/probes/secrets-child.mjs';

const config = JSON.parse(process.argv[2] ?? 'null');
if (!config?.client?.port || !config?.staff?.port || !config.client.persist || !config.staff.persist) {
	console.error('serve: usage: node serve.mjs <config JSON> (from harness.ts)');
	process.exit(2);
}
const keys = takeSecrets();
const need = ['CLIENT_A_PK', 'CLIENT_A_SK', 'STAFF_PK', 'STAFF_SK', ...(config.jwtKeys ? ['CLIENT_A_JWT_KEY', 'STAFF_JWT_KEY'] : [])];
const missing = need.filter((k) => !keys.get(k));
if (missing.length) {
	console.error(`serve: fd 3 lacks ${missing.join(', ')}`);
	process.exit(2);
}
const secret = (name) => ({ type: 'secret_text', value: keys.get(name) });
const plain = (value) => ({ type: 'plain_text', value: String(value) });
const common = { AUTH_MFA_REQUIRED: plain(config.mfaRequired ? 'true' : 'false'), ...(config.apiUrl ? { CLERK_API_URL: plain(config.apiUrl) } : {}) };

const apps = {
	client: {
		APP_ORIGIN: plain(config.client.origin),
		STAFF_ORIGIN: plain(config.staff.origin),
		CLERK_PUBLISHABLE_KEY: secret('CLIENT_A_PK'),
		CLERK_SECRET_KEY: secret('CLIENT_A_SK'),
		STAFF_PUBLISHABLE_KEY: secret('STAFF_PK'),
		STAFF_SECRET_KEY: secret('STAFF_SK'),
		...(config.jwtKeys ? { CLERK_JWT_KEY: secret('CLIENT_A_JWT_KEY'), STAFF_JWT_KEY: secret('STAFF_JWT_KEY') } : {}),
	},
	staff: {
		APP_ORIGIN: plain(config.staff.origin),
		CLERK_PUBLISHABLE_KEY: secret('STAFF_PK'),
		CLERK_SECRET_KEY: secret('STAFF_SK'),
		...(config.jwtKeys ? { CLERK_JWT_KEY: secret('STAFF_JWT_KEY') } : {}),
	},
};
keys.clear();

const workers = [];
async function stop(code) {
	// dispose() first waits for the ProxyWorker, which a failed start may never have; the runner signals the whole group anyway
	const disposed = Promise.all(workers.splice(0).map((w) => w.dispose().catch(() => {})));
	await Promise.race([disposed, new Promise((r) => setTimeout(r, 10_000))]);
	process.exit(code);
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
// stdin is a pipe from the runner that started this process (harness.ts), never written: when it ends the runner is gone,
// whether it exited, threw or was killed, and a process group of its own would outlive it holding both ports.
process.stdin.on('end', () => stop(0));
process.stdin.on('error', () => stop(0));
process.stdin.resume();

const reason = (e) => (e instanceof Error ? e.message : `${e.source}: ${e.reason}: ${e.cause instanceof Error ? e.cause.message : String(e.cause)}`);
try {
	const live = [];
	for (const app of ['client', 'staff']) {
		const worker = await unstable_startWorker({
			config: 'wrangler.toml',
			env: app,
			bindings: { ...common, ...apps[app] },
			dev: { server: { hostname: '127.0.0.1', port: config[app].port }, inspector: false, persist: config[app].persist, watch: false, liveReload: false, remote: false },
		});
		workers.push(worker);
		worker.raw.on('error', (e) => {
			console.error(`serve: ${app} failed: ${reason(e)}`);
			void stop(1);
		});
		live.push(new Promise((resolve) => worker.raw.once('reloadComplete', resolve)));
		await worker.ready;
	}
	await Promise.all(live);
	console.log(`serve: ready client ${config.client.port} staff ${config.staff.port}`);
} catch (e) {
	console.error(`serve: failed: ${e instanceof Error ? e.message : String(e)}`);
	await stop(1);
}
