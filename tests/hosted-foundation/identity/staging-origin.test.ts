// Staging's app origin is one setting (GRS-278): CLEARCASE_APP_ORIGIN in deploy/staging/wrangler.jsonc. The native-config
// hostnames and the custom-domain route follow it (deploy/staging/origin.ts), the scripts read it from there, and the runtime
// still serves exactly that one origin. The committed config is read as is; the other origins are SYNTHETIC.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aimNative, readOrigin, withOrigin, workersDevHost } from '../../../deploy/staging/origin.ts';
import { pinnedOriginRefusal } from '../../../src/lib/server/runtime/hosted/origin-guard.ts';

const repo = path.resolve(import.meta.dirname, '../../..');
const wrangler = readFileSync(path.join(repo, 'deploy/staging/wrangler.jsonc'), 'utf8');
const parse = (text: string) => JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as { routes: unknown[]; vars: Record<string, string>; previews: { vars: Record<string, string> } };
const native = (text: string) => JSON.parse(parse(text).vars.CLEARCASE_NATIVE_CONFIG) as { deployment: { hostname: string }; manifest: { clients: { hostname: string }[] } };
const CUSTOM = 'https://clearcase-staging.gridshift.co.za';
const WORKERS_DEV = 'https://clearcase-staging.shiny-sunset-211d.workers.dev';

describe('the committed staging config', () => {
	it('serves the gridshift.co.za custom domain, and every derived value agrees with it', () => {
		expect(readOrigin(wrangler)).toBe(CUSTOM);
		const n = native(wrangler);
		expect([n.deployment.hostname, ...n.manifest.clients.map((c) => c.hostname)]).toEqual(['clearcase-staging.gridshift.co.za', 'clearcase-staging.gridshift.co.za']);
		expect(parse(wrangler).routes).toEqual([{ pattern: 'clearcase-staging.gridshift.co.za', custom_domain: true }]);
		expect(workersDevHost(wrangler)).toBe('clearcase-staging.shiny-sunset-211d.workers.dev');
	});
	it('leaves the origin out of the previews block: scripts/preview.sh passes each preview its own', () => {
		expect(Object.keys(parse(wrangler).previews.vars)).not.toContain('CLEARCASE_APP_ORIGIN');
		expect(Object.keys(parse(wrangler).previews.vars)).not.toContain('CLEARCASE_NATIVE_CONFIG');
	});
	it('pins exactly its origin: workers.dev, a preview, another scheme or port and a look-alike are refused', () => {
		const pinned = parse(wrangler).vars.CLEARCASE_APP_ORIGIN;
		expect(pinnedOriginRefusal(new URL(`${CUSTOM}/cases`), pinned)).toBeNull();
		for (const other of [WORKERS_DEV, 'https://grs-278-clearcase-staging.shiny-sunset-211d.workers.dev', 'http://clearcase-staging.gridshift.co.za', 'https://clearcase-staging.gridshift.co.za:8443', 'https://gridshift.co.za', 'https://clearcase-staging.gridshift.co.za.example.com'])
			expect(pinnedOriginRefusal(new URL(`${other}/cases`), pinned)?.status, other).toBe(403);
	});
});

describe('moving the origin (bun deploy/staging/origin.ts set <origin>)', () => {
	it('moves back to workers.dev with no route, and forward again byte for byte', () => {
		const back = withOrigin(wrangler, WORKERS_DEV);
		expect(readOrigin(back)).toBe(WORKERS_DEV);
		expect(parse(back).routes).toEqual([]);
		expect(native(back).deployment.hostname).toBe('clearcase-staging.shiny-sunset-211d.workers.dev');
		expect(withOrigin(back, CUSTOM)).toBe(wrangler);
	});
	it('moves to another custom domain (clearcase.co.za later) as one change', () => {
		const moved = withOrigin(wrangler, 'https://staging.clearcase.co.za');
		expect(readOrigin(moved)).toBe('https://staging.clearcase.co.za');
		expect(parse(moved).routes).toEqual([{ pattern: 'staging.clearcase.co.za', custom_domain: true }]);
		expect(native(moved).manifest.clients.map((c) => c.hostname)).toEqual(['staging.clearcase.co.za']);
	});
	it.each([
		['http', 'http://clearcase-staging.gridshift.co.za'],
		['a path', `${CUSTOM}/`],
		['a port', `${CUSTOM}:8443`],
		['a preview host', 'https://grs-278-clearcase-staging.shiny-sunset-211d.workers.dev'],
		['another workers.dev host', 'https://other.shiny-sunset-211d.workers.dev'],
		['not a URL', 'clearcase-staging.gridshift.co.za'],
	])('refuses %s', (_what, origin) => {
		expect(() => withOrigin(wrangler, origin)).toThrow();
	});
	it('refuses a hand-edited config whose derived values disagree, naming the field', () => {
		const stale = wrangler.replace('"CLEARCASE_APP_ORIGIN": "https://clearcase-staging.gridshift.co.za"', `"CLEARCASE_APP_ORIGIN": "${WORKERS_DEV}"`);
		expect(stale).not.toBe(wrangler);
		expect(() => readOrigin(stale)).toThrow(/hostname/);
		const noRoute = wrangler.replace(/"routes":\s*\[[^\]]*\]/, '"routes": []');
		expect(() => readOrigin(noRoute)).toThrow(/routes/);
	});
});

describe('a preview gets its own origin', () => {
	it('re-aims the native config at the preview host and changes nothing else', () => {
		const host = 'grs-278-clearcase-staging.shiny-sunset-211d.workers.dev';
		const aimed = JSON.parse(aimNative(wrangler, `https://${host}`)) as ReturnType<typeof native> & Record<string, unknown>;
		expect([aimed.deployment.hostname, ...aimed.manifest.clients.map((c) => c.hostname)]).toEqual([host, host]);
		const base = native(wrangler) as ReturnType<typeof native> & Record<string, unknown>;
		expect({ ...aimed, deployment: { ...aimed.deployment, hostname: '' }, manifest: { ...aimed.manifest, clients: [] } })
			.toEqual({ ...base, deployment: { ...base.deployment, hostname: '' }, manifest: { ...base.manifest, clients: [] } });
	});
});

describe('no script hard-wires a staging host', () => {
	it('scripts/*.sh and deploy/staging/*.ts read the origin from the config', () => {
		const files = [...readdirSync(path.join(repo, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => `scripts/${f}`),
			...readdirSync(path.join(repo, 'deploy/staging')).filter((f) => f.endsWith('.ts') && f !== 'origin.ts').map((f) => `deploy/staging/${f}`)];
		expect(files).toContain('scripts/deploy-staging.sh');
		for (const f of files) expect(readFileSync(path.join(repo, f), 'utf8'), f).not.toMatch(/shiny-sunset-211d|gridshift\.co\.za/);
	});
});
