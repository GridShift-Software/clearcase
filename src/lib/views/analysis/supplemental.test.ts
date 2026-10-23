import { describe, expect, it } from 'vitest';
import { datePhaseGroups, phaseGroups, type TimelineEvent } from './timeline';
import { consistencyChecks, type Contradictions } from './contradictions';
import { relationshipLayout } from './supplemental';

const event = (phase: string): TimelineEvent => ({ date: '2001-02-28', kind: 'note', title: phase, note: '', ref: '', phase });
const phase = (key: string) => ({ key, from: '2001-01-01', to: '2001-12-31', title: key, summary: 'Supplied summary' });
describe('GRS-194 visible source semantics', () => {
	it('assigns overlapping date ranges only by explicit key and leaves unknown membership visible', () => {
		const events = [event('a'), event('b'), event('unknown'), event('')];
		const grouped = datePhaseGroups([phase('a'), phase('b')], events);
		expect(grouped.phases.map((p) => p.events.map((e) => e.title))).toEqual([['a'], ['b']]);
		expect(grouped.unplaced).toEqual(events.slice(2));
		expect(grouped.phases.flatMap((p) => p.events).length + grouped.unplaced.length).toBe(events.length);
	});
	it('discloses duplicate phase IDs without duplicating or guessing event membership', () => {
		const grouped = datePhaseGroups([phase('a'), phase('a')], [event('a')]);
		expect(grouped.phases.flatMap((p) => p.events)).toEqual([]);
		expect(grouped.unplaced).toHaveLength(1);
		expect(grouped.phases.every((p) => p.note.includes('Duplicate phase key'))).toBe(true);
	});
	it('keeps v5 year-based grouping', () => {
		expect(phaseGroups([['2001–2002', 'Original phase', 'Note']], [event('not-used-by-v5')]).phases[0]!.events).toHaveLength(1);
	});
	it('shows both counted and count-free checks, retaining repeated source rows', () => {
		const c = { checks: [{ check: 'Counted', n: 0, result: 'None' }], source_checks: [{ check: 'Text only', result: 'Needs review' }, { check: 'Text only', result: 'Needs review' }] } as unknown as Contradictions;
		expect(consistencyChecks(c)).toEqual([{ check: 'Counted', result: 'None' }, ...c.source_checks!]);
		expect(consistencyChecks(c).some((x) => 'n' in x)).toBe(false);
	});
	it('retains every connection while disclosing missing or duplicate node endpoints', () => {
		const graph = relationshipLayout({ nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'Other A' }, { id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'missing' }] });
		expect(graph.nodes).toHaveLength(3);
		expect(graph.edges).toHaveLength(2);
		expect(graph.edges[0]!.source).toBeNull();
		expect(graph.edges[0]!.target?.label).toBe('B');
		expect(graph.edges[1]!.target).toBeNull();
	});
});
