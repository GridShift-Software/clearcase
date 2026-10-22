import { render } from 'svelte/server';
import { expect, it, vi } from 'vitest';
import TimelinePage from '../../src/routes/v/[vid]/analysis/timeline/+page.svelte';

vi.mock('$app/navigation', () => ({ goto: () => Promise.resolve() }));

it('reveals timeline text even when an event has only the primary reference', () => {
	const data = { version: { id: 'test', titleName: 'Synthetic' }, heading: 'Timeline', known: ['OD-001'], content: {}, years: [], people: [], chart: null, headlineRef: null, dated: true, unplaced: [], phases: [{ label: '2001', title: 'Phase', note: '', events: [{ date: '2001-01-01', kind: 'Note: \u200B', title: 'Title\u2066', note: 'Invoice\u202E', ref: 'OD-001', phase: 'one' }] }] };
	const body = render(TimelinePage, { props: { data } as never }).body;
	for (const cp of ['202E', '200B', '2066']) expect(body).toContain(`⟨U+${cp}⟩`);
	expect(body).not.toMatch(/[\u202E\u200B\u2066]/);
});
