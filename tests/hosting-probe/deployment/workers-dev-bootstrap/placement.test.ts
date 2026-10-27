import { describe, expect, it } from 'vitest';
import { planWorkersDevBootstrap, type BootstrapSettings } from '../../../../deploy/native-alpha/workers-dev-bootstrap.ts';

// Synthetic settings only: a PASS here proves the generated config text, not that Cloudflare moved any Worker.
const valid = (): BootstrapSettings => ({ pins: { source: 'a'.repeat(40), artifact: `sha256:${'b'.repeat(64)}`, entry: `sha256:${'c'.repeat(64)}` }, compatibilityDate: '2026-10-23', compatibilityFlags: ['nodejs_compat'] });
const configs = (settings: unknown) => planWorkersDevBootstrap(settings).targets.map((t) => ({ slot: t.slot, config: JSON.parse(t.configText) as Record<string, unknown> }));

describe('optional Worker placement in the workers.dev bootstrap', () => {
	it('is absent by default: no placement key in any config and none in the resolved settings', () => {
		const plan = planWorkersDevBootstrap(valid());
		for (const { config } of configs(valid())) expect(config).not.toHaveProperty('placement');
		expect(plan.settings).not.toHaveProperty('placement');
	});
	it('writes an explicit region hint into the client configs only', () => {
		const out = configs({ ...valid(), placement: { region: 'aws:eu-central-1' } });
		for (const { slot, config } of out) {
			if (slot === 'staff') expect(config).not.toHaveProperty('placement');
			else expect(config.placement).toEqual({ region: 'aws:eu-central-1' });
		}
	});
	it('writes smart placement into the client configs only', () => {
		for (const { slot, config } of configs({ ...valid(), placement: { mode: 'smart' } })) {
			if (slot === 'staff') expect(config).not.toHaveProperty('placement');
			else expect(config.placement).toEqual({ mode: 'smart' });
		}
	});
	it('records the placement in the resolved settings and keeps planning deterministic', () => {
		const input = { ...valid(), placement: { region: 'gcp:europe-west1' } };
		expect(planWorkersDevBootstrap(input)).toEqual(planWorkersDevBootstrap(input));
		expect(planWorkersDevBootstrap(input).settings.placement).toEqual({ region: 'gcp:europe-west1' });
	});
	it.each([
		['an empty object', {}], ['both mode and region', { mode: 'smart', region: 'aws:eu-central-1' }], ['an unknown mode', { mode: 'off' }],
		['host hints', { host: 'db.example.com:5432' }], ['hostname hints', { hostname: 'api.example.com' }], ['an extra key', { region: 'aws:eu-central-1', host: 'x:1' }],
		['a region without a provider', { region: 'eu-central-1' }], ['an unknown provider', { region: 'oracle:eu-frankfurt-1' }], ['an upper-case region', { region: 'aws:EU-CENTRAL-1' }],
		['a region with a space', { region: 'aws:eu central' }], ['a non-string region', { region: 7 }], ['a string', 'smart'], ['null', null], ['an array', [{ mode: 'smart' }]],
	])('refuses %s', (_, placement) => {
		expect(() => planWorkersDevBootstrap({ ...valid(), placement })).toThrow(/placement/);
	});
	it('refuses a placement getter and an inherited placement', () => {
		const getter = valid();
		Object.defineProperty(getter, 'placement', { enumerable: true, get: () => ({ mode: 'smart' }) });
		expect(() => planWorkersDevBootstrap(getter)).toThrow();
		const inherited = Object.create({ placement: { mode: 'smart' } }, Object.getOwnPropertyDescriptors(valid()));
		expect(() => planWorkersDevBootstrap(inherited)).toThrow();
	});
});
