// Staging's Clerk and secret plumbing for scripts/deploy-staging.sh and scripts/preview.sh (GRS-245). Never prints a
// secret value: keys travel from the source below to the Clerk Backend API or to Wrangler's stdin, nowhere else.
//
//   bun deploy/staging/clerk.ts allow <origin>     add <origin>/sign-in (client app) and <origin>/sign-in/operator (staff
//                                                  app) to the redirect allow-lists, and <origin> to allowed origins
//   bun deploy/staging/clerk.ts remove <origin>    the reverse, for scripts/preview.sh --delete
//   bun deploy/staging/clerk.ts put-secrets        the four Clerk secrets into the staging Worker and the Preview base
//                                                  config, through `wrangler ... secret put` on stdin
//
// Key source (instance.ts secretKeys): STAGING_CLERK_SECRET_KEY and STAGING_CLERK_STAFF_SECRET_KEY (the repo secret names),
// else the active profile's file in the main checkout (`.local/secrets/staging-clerk.env` for development,
// `staging-clerk-production.env` for production; CLERK_SECRET_KEY, CLERK_STAFF_SECRET_KEY), else STAGING_CLERK_ENV naming
// another such file. Keys of the other mode than the active profile are refused. The JWT keys are the instances' public RSA
// keys from GET /v1/jwks.
import { spawnSync } from 'node:child_process';
import { createPublicKey } from 'node:crypto';
import path from 'node:path';
import { activeProfile, secretKeys } from './instance.ts';

const root = path.resolve(import.meta.dirname, '../..');
const CONFIG = 'deploy/staging/wrangler.jsonc';
const API = 'https://api.clerk.com/v1';
type Kind = 'client' | 'staff';
const CALLBACK: Record<Kind, string> = { client: '/sign-in', staff: '/sign-in/operator' };

/** The secret keys of the Clerk instance wrangler.jsonc names (GRS-267), refused when they are of the other mode. */
function keys(): Record<Kind, string> {
	const profile = activeProfile();
	if (!profile) throw new Error('wrangler.jsonc matches no Clerk instance profile; run scripts/clerk-instance.sh --use <development|production>');
	return secretKeys(profile);
}

async function clerk<T>(key: string, method: string, p: string, body?: unknown): Promise<T> {
	const res = await fetch(`${API}${p}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
	const text = await res.text();
	if (!res.ok) throw new Error(`Clerk ${method} ${p}: ${res.status} ${text.slice(0, 300)}`);
	return (text ? JSON.parse(text) : null) as T;
}

function origin(value: string | undefined): string {
	const u = new URL(value ?? '');
	if (u.protocol !== 'https:' || u.origin !== value) throw new Error(`not an https origin: ${value}`);
	return u.origin;
}

async function allow(o: string, add: boolean) {
	for (const [kind, key] of Object.entries(keys()) as [Kind, string][]) {
		const url = o + CALLBACK[kind];
		const list = await clerk<{ id: string; url: string }[]>(key, 'GET', '/redirect_urls');
		const found = list.filter((r) => r.url === url);
		if (add && found.length === 0) await clerk(key, 'POST', '/redirect_urls', { url });
		if (!add) for (const r of found) await clerk(key, 'DELETE', `/redirect_urls/${r.id}`);
		const instance = await clerk<{ allowed_origins: string[] | null }>(key, 'GET', '/instance');
		const origins = instance.allowed_origins ?? [];
		const next = add ? [...new Set([...origins, o])] : origins.filter((x) => x !== o);
		if (next.length !== origins.length) await clerk(key, 'PATCH', '/instance', { allowed_origins: next });
		console.log(`clerk ${kind}: redirect ${url} ${add ? (found.length ? 'present' : 'added') : (found.length ? 'removed' : 'absent')}; allowed origin ${next.length !== origins.length ? (add ? 'added' : 'removed') : (add ? 'present' : 'absent')}`);
	}
}

/** The instance's RSA public key as PEM, the form CLERK_*_JWT_KEY takes (docs/hosted-foundation/identity.md). */
async function jwtKey(key: string): Promise<string> {
	const { keys: jwks } = await clerk<{ keys: JsonWebKey[] }>(key, 'GET', '/jwks');
	if (jwks.length !== 1 || jwks[0].kty !== 'RSA') throw new Error(`expected one RSA key in the instance JWKS, got ${jwks.length}`);
	return createPublicKey({ key: jwks[0], format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString();
}

function wrangler(args: string[], input: string) {
	const r = spawnSync('node', ['node_modules/wrangler/bin/wrangler.js', ...args, '-c', CONFIG], { cwd: root, input, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' } });
	if (r.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed: ${(r.stdout + r.stderr).slice(-600)}`);
}

async function putSecrets() {
	const k = keys();
	const values: Record<string, string> = {
		CLERK_CLIENT_SECRET_KEY: k.client, CLERK_STAFF_SECRET_KEY: k.staff,
		CLERK_CLIENT_JWT_KEY: await jwtKey(k.client), CLERK_STAFF_JWT_KEY: await jwtKey(k.staff),
	};
	for (const [name, value] of Object.entries(values)) {
		wrangler(['secret', 'put', name], value);
		wrangler(['preview', 'base-config', 'secret', 'put', name], value);
		console.log(`secret ${name}: put on the Worker and the Preview base config`);
	}
}

const [cmd, arg] = process.argv.slice(2);
try {
	if (cmd === 'allow' || cmd === 'remove') await allow(origin(arg), cmd === 'allow');
	else if (cmd === 'put-secrets') await putSecrets();
	else throw new Error('usage: bun deploy/staging/clerk.ts allow|remove <https-origin> | put-secrets');
} catch (e) {
	console.error(`clerk.ts: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
}
