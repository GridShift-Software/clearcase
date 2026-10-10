import { describe, expect, it } from 'vitest';
import { cleanName, phaseGroups, quantumBars, templateParts, yearBars } from './timeline.ts';

const ev = (date: string, title = 't') => ({ date, kind: 'letter', ref: 'OD-1', title, note: '' });

describe('timeline builders (v5 RENDER.timeline)', () => {
	it('places events under every phase whose years include theirs, inclusive, in data order', () => {
		const phases = [['2001–2002', 'A', 'a'], ['2003', 'B', 'b'], ['2004–2005', 'C', 'c']];
		const events = [ev('2002-05-01', 'x'), ev('2001-01-01', 'y'), ev('2003-12-31', 'z'), ev('2005-01-01', 'w')];
		const g = phaseGroups(phases, events);
		expect(g.phases.map((p) => p.events.map((e) => e.title))).toEqual([['x', 'y'], ['z'], ['w']]);
		expect(g.phases[0]).toMatchObject({ label: '2001–2002', title: 'A', note: 'a' });
		expect(g.unplaced).toEqual([]);
	});
	it('keeps events outside every phase apart instead of dropping them', () => {
		const g = phaseGroups([['2001', 'A', '']], [ev(''), ev('1999-01-01'), ev('2001-02-02')]);
		expect(g.phases[0]!.events).toHaveLength(1);
		expect(g.unplaced.map((e) => e.date)).toEqual(['', '1999-01-01']);
	});
	it('a phase without events is empty, not missing', () => {
		expect(phaseGroups([['2010', 'Quiet', '']], []).phases[0]!.events).toEqual([]);
	});
	it('draws year bars in key order, the tallest exactly 100 px; all-zero counts draw flat bars, not NaN (S-timeline-3)', () => {
		expect(yearBars([['2011', 1], ['2012', 4], ['2013', 2]])).toEqual([
			{ year: '2011', label: '11', count: 1, height: 25 }, { year: '2012', label: '12', count: 4, height: 100 }, { year: '2013', label: '13', count: 2, height: 50 },
		]);
		expect(yearBars([['2011', 0]])[0]!.height).toBe(0);
		expect(yearBars([])).toEqual([]);
	});
	it('captions the amount-due chart with its first and last dates and its peak', () => {
		const q = quantumBars([{ date: '2091-01-31', amount: '100' }, { date: '2091-02-28', amount: '250.5' }, { date: '2091-03-31', amount: 'x' }])!;
		expect(q.caption).toBe('2091-01-31 → 2091-03-31 · peak R 250.50');
		expect(q.bars).toHaveLength(3);
		expect(q.bars[1]!.h).toBe('144.0');
		expect(q.bars[2]!.h).toBe('0.0');
		expect(quantumBars([])).toBeNull();
	});
	it('draws no bar, never a negative height, for a negative amount, and keeps the imported amount in its title', () => {
		const q = quantumBars([{ date: '2091-01-31', amount: '100' }, { date: '2091-02-28', amount: '-50' }])!;
		expect(q.bars.map((b) => [b.h, b.y])).toEqual([['144.0', '8.0'], ['0.0', '152.0']]);
		expect(q.bars[1]!.title).toBe('2091-02-28: -R 50.00');
		const neg = quantumBars([{ date: '2091-01-31', amount: '-100' }, { date: '2091-02-28', amount: '-50' }])!;
		expect(neg.bars.every((b) => b.h === '0.0' && Number(b.y) <= 152)).toBe(true);
	});
	it('cleans file-like titles as v5 does, keeping entities as plain characters', () => {
		expect(cleanName('(12) Letter A & B.pdf')).toBe('Letter A & B');
		expect(cleanName('Mail.EML')).toBe('Mail');
	});
	it('fills a template into parts and keeps the link param as a link, never as filled text', () => {
		const v = { template: ['Due ', { param: 'amountDue' }, ' as at ', { param: 'asAt' }, '. ', { param: 'sourceLink' }] };
		expect(templateParts(v, { amountDue: 'R 1.00', asAt: '2090-01-01' }, 'sourceLink')).toEqual([{ text: 'Due ' }, { text: 'R 1.00' }, { text: ' as at ' }, { text: '2090-01-01' }, { text: '. ' }, { link: true }]);
		expect(templateParts(v, { amountDue: 'R 1.00' }, 'sourceLink')).toBeNull();
		expect(templateParts('Plain', {}, 'sourceLink')).toEqual([{ text: 'Plain' }]);
		expect(templateParts(null, {}, 'sourceLink')).toBeNull();
		expect(templateParts(['a'], {}, 'sourceLink')).toBeNull();
	});
});
