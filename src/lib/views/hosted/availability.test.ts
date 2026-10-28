import { describe, expect, it } from 'vitest';
import { VIEWS } from '../../components/view-registry.ts';
import { HOSTED_STATUS, hostedStatus } from './availability.ts';

describe('hosted availability', () => {
	it('names every registry view once, and nothing else', () => {
		expect(Object.keys(HOSTED_STATUS).sort()).toEqual(VIEWS.map((v) => v.id).sort());
	});

	it('never offers a system view, and always offers the overview', () => {
		for (const v of VIEWS.filter((x) => x.category === 'system')) expect([v.id, hostedStatus(v.id)]).toEqual([v.id, 'never']);
		expect(hostedStatus('overview')).toBe('ported');
	});

	it('never shows an id the registry does not know', () => {
		for (const id of ['not_a_view', '__proto__', 'toString', 'constructor']) expect(hostedStatus(id)).toBe('never');
	});
});
