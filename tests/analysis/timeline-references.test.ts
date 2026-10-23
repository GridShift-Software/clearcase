import { expect, it } from 'vitest';
import { eventReferences } from '../../src/lib/views/analysis/timeline';

it('keeps the primary ref and every additional ref, including unresolved targets', () => {
	expect(eventReferences({ date: '', kind: '', title: '', note: '', ref: 'OD-001', refs: ['OD-002', 'OD-001', 'ZZ-404'] })).toEqual(['OD-001', 'OD-002', 'ZZ-404']);
});
