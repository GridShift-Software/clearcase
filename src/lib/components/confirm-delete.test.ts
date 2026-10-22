// deleteStep (GRS-175): a delete request is confirmed only for the exact target it names, and a Cancel wins.
import { describe, expect, it } from 'vitest';
import { CANCEL, CONFIRM, deleteStep } from './confirm-delete';

const form = (fields: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(fields)) f.set(k, v);
	return f;
};

describe('deleteStep', () => {
	it('asks when the request carries no confirmation, or one for another target, or an empty target', () => {
		expect(deleteStep(form({}), 'row:1')).toBe('ask');
		expect(deleteStep(form({ [CONFIRM]: 'row:2' }), 'row:1')).toBe('ask');
		expect(deleteStep(form({ [CONFIRM]: '' }), '')).toBe('ask');
	});
	it('confirms only the target the confirmation names', () => {
		expect(deleteStep(form({ [CONFIRM]: 'row:1' }), 'row:1')).toBe('confirm');
		expect(deleteStep(form({ [CONFIRM]: 'clear' }), 'clear')).toBe('confirm');
	});
	it('cancels whenever the request carries a Cancel, confirmed or not', () => {
		expect(deleteStep(form({ [CANCEL]: 'row:1' }), 'row:1')).toBe('cancel');
		expect(deleteStep(form({ [CANCEL]: '', [CONFIRM]: 'row:1' }), 'row:1')).toBe('cancel');
	});
});
