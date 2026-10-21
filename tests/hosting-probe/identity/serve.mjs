// Node host for the identity probe's two Workers (GRS-108). Wrangler runs on Node only; Bun hosts the build and the
// runner. Usage, from harness.ts only: node serve.mjs '<config JSON>' with the keys on fd 3 (CLEARCASE_SECRETS_FD=3).
//
// It takes the keys off fd 3 once (takeSecrets(), the child half of deploy/probes/secrets.ts), so they are never in
// this process's environment, argv or a file, and hands them to Wrangler's startWorker as secret_text bindings: Wrangler
// prints them as hidden and passes them to workerd inside its config, over a pipe. Each Worker is local: its D1 and R2
// are Miniflare's, under the config's persist directory. On SIGINT or SIGTERM it disposes both Workers and exits 0.
import { unstable_startWorker } from 'wrangler';
import { takeSecrets } from '../../../deploy/probes/secrets-child.mjs';

const config = JSON.parse(process.argv[2] ?? 'null');
if (!config?.client?.port || !config?.staff?.port || !config.persist) {
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
	for (const w of workers.splice(0)) await w.dispose().catch(() => {});
	process.exit(code);
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));

try {
	for (const app of ['client', 'staff']) {
		const worker = await unstable_startWorker({
			config: 'wrangler.toml',
			env: app,
			bindings: { ...common, ...apps[app] },
			dev: { server: { hostname: '127.0.0.1', port: config[app].port }, inspector: false, persist: config.persist, watch: false, liveReload: false, remote: false },
		});
		workers.push(worker);
		await worker.ready;
	}
	console.log(`serve: ready client ${config.client.port} staff ${config.staff.port}`);
} catch (e) {
	console.error(`serve: failed: ${e instanceof Error ? e.message : String(e)}`);
	await stop(1);
}
