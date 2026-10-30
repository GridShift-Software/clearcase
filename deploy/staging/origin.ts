// Staging's app origin (GRS-278). Runbook: docs/sprint/runbooks/02-staging.md. The one setting is CLEARCASE_APP_ORIGIN in
// deploy/staging/wrangler.jsonc. The CLEARCASE_NATIVE_CONFIG hostnames and the custom-domain route follow it: the runtime
// refuses a native config for another host, and a custom domain serves only through its route. Scripts read the origin here
// and never name a host. Previews keep their workers.dev URLs, each with its own origin (scripts/preview.sh).
//
//   bun deploy/staging/origin.ts get                print the origin, after checking every value that follows it agrees
//   bun deploy/staging/origin.ts set <origin>       move staging to <origin>: a custom domain, or the Worker's workers.dev host
//   bun deploy/staging/origin.ts workers-dev-host   the Worker's workers.dev host; every Preview URL is <name>-<this host>
//   bun deploy/staging/origin.ts native <origin>    CLEARCASE_NATIVE_CONFIG aimed at a preview origin, for its --var
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG = path.resolve(import.meta.dirname, 'wrangler.jsonc');
// The account's workers.dev subdomain (Workers & Pages > Account details > Subdomain).
const ACCOUNT_SUBDOMAIN = 'shiny-sunset-211d.workers.dev';

interface Config { name: string; routes: unknown[]; vars: Record<string, string>; previews: { vars: Record<string, string> } }
interface Native { deployment: { hostname: string }; manifest: { clients: { hostname: string }[] } }
/** wrangler.jsonc as JSON: whole-line comments removed (a string value never starts a line with `//`). */
const parse = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as Config;
const nativeOf = (c: Config) => JSON.parse(c.vars.CLEARCASE_NATIVE_CONFIG) as Native;

export const workersDevHost = (text: string) => `${parse(text).name}.${ACCOUNT_SUBDOMAIN}`;

function httpsOrigin(value: string): URL {
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		throw new Error(`not an https origin: ${value}`);
	}
	if (u.protocol !== 'https:' || u.port !== '' || u.origin !== value) throw new Error(`not an https origin on the default port: ${value}`);
	return u;
}

/** `value` as a URL when staging itself can serve it: the Worker's workers.dev host, or a custom domain outside workers.dev. */
function stagingOrigin(text: string, value: string): URL {
	const u = httpsOrigin(value), own = workersDevHost(text);
	if (u.hostname.endsWith('.workers.dev') && u.hostname !== own) throw new Error(`${u.hostname} is not the Worker's workers.dev host ${own}; a preview's origin is set per preview by scripts/preview.sh`);
	return u;
}

const routesFor = (text: string, host: string) => (host === workersDevHost(text) ? [] : [{ pattern: host, custom_domain: true }]);

/** CLEARCASE_APP_ORIGIN, refused unless the native-config hostnames, the routes and the previews block all agree with it. */
export function readOrigin(text: string): string {
	const c = parse(text), origin = c.vars.CLEARCASE_APP_ORIGIN, host = stagingOrigin(text, origin).hostname;
	const native = nativeOf(c), bad: string[] = [];
	if (native.deployment.hostname !== host) bad.push('CLEARCASE_NATIVE_CONFIG deployment.hostname');
	native.manifest.clients.forEach((x, i) => { if (x.hostname !== host) bad.push(`CLEARCASE_NATIVE_CONFIG manifest.clients[${i}].hostname`); });
	if (JSON.stringify(c.routes) !== JSON.stringify(routesFor(text, host))) bad.push('routes');
	for (const name of ['CLEARCASE_APP_ORIGIN', 'CLEARCASE_NATIVE_CONFIG']) if (name in c.previews.vars) bad.push(`previews.vars.${name}`);
	if (bad.length) throw new Error(`wrangler.jsonc disagrees with CLEARCASE_APP_ORIGIN ${origin}: ${bad.join(', ')}; move it with bun deploy/staging/origin.ts set <origin>`);
	return origin;
}

/** `text` (wrangler.jsonc) moved to `origin`: CLEARCASE_APP_ORIGIN, both native-config hostnames and the routes. */
export function withOrigin(text: string, origin: string): string {
	const host = stagingOrigin(text, origin).hostname;
	let out = text;
	const swap = (re: RegExp, value: string, expected: number, what: string) => {
		let n = 0;
		out = out.replace(re, (_m, a: string, b: string) => { n++; return a + value + b; });
		if (n !== expected) throw new Error(`wrangler.jsonc has ${n} ${what}, expected ${expected}`);
	};
	swap(/("CLEARCASE_APP_ORIGIN":\s*")[^"]*(")/g, origin, 1, 'CLEARCASE_APP_ORIGIN entries');
	// Inside the CLEARCASE_NATIVE_CONFIG string the quotes are escaped.
	swap(/(\\"hostname\\":\\")[^\\"]*(\\")/g, host, 1 + nativeOf(parse(text)).manifest.clients.length, 'hostnames in CLEARCASE_NATIVE_CONFIG');
	const routes = routesFor(text, host).map((r) => `{ "pattern": ${JSON.stringify(r.pattern)}, "custom_domain": true }`).join(', ');
	swap(/("routes":\s*)\[[^\]]*(\])/g, `[${routes}`, 1, '"routes" entries');
	if (readOrigin(out) !== origin) throw new Error('the rewritten wrangler.jsonc does not carry the origin; nothing written');
	return out;
}

/** Staging's CLEARCASE_NATIVE_CONFIG with every hostname set to the host of `previewOrigin`, a Preview URL of this Worker. */
export function aimNative(text: string, previewOrigin: string): string {
	const host = httpsOrigin(previewOrigin).hostname;
	if (!host.endsWith(`-${workersDevHost(text)}`)) throw new Error(`${host} is not a Preview URL of ${workersDevHost(text)}`);
	const native = nativeOf(parse(text));
	native.deployment.hostname = host;
	for (const c of native.manifest.clients) c.hostname = host;
	return JSON.stringify(native);
}

if (import.meta.main) {
	const [cmd, arg] = process.argv.slice(2);
	try {
		const text = readFileSync(CONFIG, 'utf8');
		if (cmd === 'get') console.log(readOrigin(text));
		else if (cmd === 'workers-dev-host') console.log(workersDevHost(text));
		else if (cmd === 'native' && arg) console.log(aimNative(text, arg));
		else if (cmd === 'set' && arg) {
			const next = withOrigin(text, arg);
			if (next !== text) writeFileSync(CONFIG, next);
			console.log(readOrigin(next));
		} else throw new Error('usage: bun deploy/staging/origin.ts get | set <https-origin> | workers-dev-host | native <preview-origin>');
	} catch (e) {
		console.error(`origin.ts: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
}
