import { describe, expect, it } from 'vitest';
import { APPROVED_NATIVE_SCOPE } from '../../../../deploy/native-alpha/controls.ts';
import { bootstrapHostname, planWorkersDevBootstrap, type BootstrapSettings } from '../../../../deploy/native-alpha/workers-dev-bootstrap.ts';
import { exampleInput } from '../../../hosted-foundation/native-runtime-config/example-input.ts';

// Synthetic inputs only. The two origins are the pinned sets: workers.dev (the fallback) and the custom domain (the zone's single labels).
// Not provider, DNS, login or deployment evidence.
const ZONE = { id: '1c82369e826ebe0afded65c295198fcd', name: 'clearcase.co.za' };
const SLOTS = ['client-a', 'client-b'] as const;
const TUPLE = {
	'client-a': { worker: 'cc-sbx-a-20261023', d1DatabaseName: 'cc-sbx-a-20261023-db', d1DatabaseId: 'cd257736-7bf3-49f6-8544-ac58c2207802', r2Bucket: 'cc-sbx-a-20261023-files' },
	'client-b': { worker: 'cc-sbx-b-20261023', d1DatabaseName: 'cc-sbx-b-20261025-r1-db', d1DatabaseId: '7c340891-9fcc-4398-8128-68abe726f130', r2Bucket: 'cc-sbx-b-20261023-files' },
} as const;
const CUSTOM = { 'client-a': 'sbx-a.clearcase.co.za', 'client-b': 'sbx-b.clearcase.co.za' } as const;
const DEV = { 'client-a': 'cc-sbx-a-20261023.shiny-sunset-211d.workers.dev', 'client-b': 'cc-sbx-b-20261023.shiny-sunset-211d.workers.dev' } as const;

/** Renders client A only, as the live trial does. `hosts` names the hostname each client's manifest, deployment tuple and app origin carry. */
function input(hosts: Record<(typeof SLOTS)[number], string>): any {
	const value: any = exampleInput();
	SLOTS.forEach((slot, i) => {
		Object.assign(value.clients[i].deployment, { clientId: slot, ...TUPLE[slot], hostname: hosts[slot] });
		Object.assign(value.manifest.clients[i], { clientId: slot, ...TUPLE[slot], hostname: hosts[slot] });
		value.clients[i].appOrigin = `https://${hosts[slot]}`;
	});
	return value;
}
const settings = (runtimeConfig: unknown, origin?: unknown): BootstrapSettings => ({
	pins: { source: 'a'.repeat(40), artifact: `sha256:${'b'.repeat(64)}`, entry: `sha256:${'c'.repeat(64)}` }, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'],
	browserClients: ['client-a'], runtimeConfig, ...(origin === undefined ? {} : { origin }),
}) as BootstrapSettings;
const refusal = (value: unknown): string => {
	try { planWorkersDevBootstrap(value); } catch (error) { return String((error as Error).message); }
	throw new Error('accepted');
};
const config = (plan: ReturnType<typeof planWorkersDevBootstrap>, slot: string) => JSON.parse(plan.targets.find((t) => t.slot === slot)!.configText) as Record<string, any>;

describe('the custom-domain origin is the one pinned set of this zone and these two clients', () => {
	it('is the approved zone and one single label per client, read from the reviewed scope', () => {
		expect(APPROVED_NATIVE_SCOPE.zone).toEqual(ZONE);
		expect(SLOTS.map((slot) => bootstrapHostname(slot, 'custom-domain'))).toEqual(['sbx-a.clearcase.co.za', 'sbx-b.clearcase.co.za']);
		expect(SLOTS.map((slot) => bootstrapHostname(slot))).toEqual(Object.values(DEV));
		for (const slot of SLOTS) expect(bootstrapHostname(slot, 'custom-domain')).toMatch(/^sbx-[ab]\.clearcase\.co\.za$/);
	});
	it('plans each client on its own custom domain, as the single app origin and the single hostname', () => {
		const plan = planWorkersDevBootstrap(settings(input(CUSTOM), 'custom-domain'));
		expect(plan.settings.origin).toBe('custom-domain');
		for (const slot of SLOTS) {
			const c = config(plan, slot);
			expect(c.vars.CLEARCASE_APP_ORIGIN).toBe(`https://${CUSTOM[slot]}`);
			expect(JSON.parse(c.vars.CLEARCASE_NATIVE_CONFIG).deployment.hostname).toBe(CUSTOM[slot]);
			// The domain is bound by the reviewed PUT, never by a route in the Worker config; workers.dev stays on as the static fallback.
			expect(c.routes).toEqual([]);
			expect(c.workers_dev).toBe(true);
		}
	});
	it("binds each client's host only to its own Worker: no config names the other client's host or Worker", () => {
		const plan = planWorkersDevBootstrap(settings(input(CUSTOM), 'custom-domain'));
		const [a, b] = [plan.targets.find((t) => t.slot === 'client-a')!.configText, plan.targets.find((t) => t.slot === 'client-b')!.configText];
		expect(a).toContain(CUSTOM['client-a']);
		expect(a).not.toContain(CUSTOM['client-b']);
		expect(a).not.toContain(TUPLE['client-b'].worker);
		expect(b).toContain(CUSTOM['client-b']);
		expect(b).not.toContain(CUSTOM['client-a']);
		expect(b).not.toContain(TUPLE['client-a'].worker);
		expect(config(plan, 'client-a').name).toBe(TUPLE['client-a'].worker);
		expect(config(plan, 'client-b').name).toBe(TUPLE['client-b'].worker);
	});
	it("refuses one client's custom domain on the other client's Worker", () => {
		expect(refusal(settings(input({ 'client-a': CUSTOM['client-b'], 'client-b': CUSTOM['client-a'] }), 'custom-domain'))).toMatch(/^runtimeConfig: a planned hostname is not this client on its own custom domain$/);
	});
	it.each([
		['a hostname in another zone', 'sbx-a.gridshift.co.za'],
		['the old sandbox name', 'a.sandbox.gridshift.co.za'],
		['a wildcard', '*.clearcase.co.za'],
		['a wildcard label', 'sbx-*.clearcase.co.za'],
		['the apex', 'clearcase.co.za'],
		['a nested name', 'x.sbx-a.clearcase.co.za'],
		['a look-alike suffix', 'sbx-a.clearcase.co.za.example.com'],
		['a look-alike zone', 'sbx-a.clearcase.co.zaa'],
		['the workers.dev name', DEV['client-a']],
		['an upper-case name', 'SBX-A.clearcase.co.za'],
		['a trailing dot', 'sbx-a.clearcase.co.za.'],
	])('refuses %s as the custom-domain hostname of client-a', (_label, host) => {
		const hosts = { ...CUSTOM, 'client-a': host };
		let message = '';
		try { message = refusal(settings(input(hosts as any), 'custom-domain')); } catch (error) { message = String((error as Error).message); }
		expect(message).toMatch(/^runtimeConfig: /);
	});
	it('refuses a wildcard or an outside-zone hostname with the zone reason, not only a mismatch', () => {
		expect(refusal(settings(input({ ...CUSTOM, 'client-a': 'sbx-a.gridshift.co.za' }), 'custom-domain'))).toBe('runtimeConfig: a planned hostname is a wildcard or outside the approved custom-domain zone');
		// The manifest validator refuses a wildcard before the bootstrap sees it; both are refusals of the whole plan.
		expect(refusal(settings(input({ ...CUSTOM, 'client-a': '*.clearcase.co.za' }), 'custom-domain'))).toMatch(/^runtimeConfig: /);
	});
});

describe('the origin switch', () => {
	it('keeps workers.dev as the default and as an explicit choice', () => {
		const absent = planWorkersDevBootstrap(settings(input(DEV)));
		const explicit = planWorkersDevBootstrap(settings(input(DEV), 'workers-dev'));
		expect('origin' in absent.settings).toBe(false);
		expect(explicit.settings.origin).toBe('workers-dev');
		for (const slot of SLOTS) expect(config(absent, slot).vars.CLEARCASE_APP_ORIGIN).toBe(`https://${DEV[slot]}`);
	});
	it('refuses the other origin set under each choice, so one switch moves both hostnames together', () => {
		expect(refusal(settings(input(CUSTOM)))).toMatch(/pinned workers\.dev account subdomain/);
		expect(refusal(settings(input(CUSTOM), 'workers-dev'))).toMatch(/pinned workers\.dev account subdomain/);
		expect(refusal(settings(input(DEV), 'custom-domain'))).toMatch(/custom domain|zone/);
		expect(refusal(settings(input({ ...DEV, 'client-b': CUSTOM['client-b'] }), 'custom-domain'))).toMatch(/custom domain|zone/);
	});
	it.each(['', 'custom', 'Custom-Domain', 'both', 'clearcase.co.za', null, 1, true, ['custom-domain'], {}])('refuses the origin value %j', (origin) => {
		expect(() => planWorkersDevBootstrap(settings(input(CUSTOM), origin))).toThrow(/origin must be exactly/);
	});
	it('refuses an origin that is inherited, an accessor or a getter, like every other settings field', () => {
		const inherited = Object.assign(Object.create({ origin: 'custom-domain' }), settings(input(CUSTOM)));
		expect(() => planWorkersDevBootstrap(inherited)).toThrow();
		const accessor = { ...settings(input(CUSTOM)) } as Record<string, unknown>;
		Object.defineProperty(accessor, 'origin', { enumerable: true, get: () => 'custom-domain' });
		expect(() => planWorkersDevBootstrap(accessor)).toThrow(/overrides, unknown, inherited and accessor fields are refused/);
	});
	it('changes nothing in the shell-only output: no runtime configuration, no hostname, only the recorded origin', () => {
		const { browserClients: _browsers, runtimeConfig: _runtime, ...base } = settings(undefined);
		const shell = (origin?: BootstrapSettings['origin']) => planWorkersDevBootstrap({ ...base, ...(origin ? { origin } : {}) });
		expect(shell().targets.map((t) => t.configText)).toEqual(shell('custom-domain').targets.map((t) => t.configText));
	});
});
