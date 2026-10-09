import { describe, expect, it } from 'vitest';
import { NEUTRAL_HEADINGS, defenceCsv, defenceHeadings } from './defence.ts';

const row = (o: Partial<Parameters<typeof defenceCsv>[0][number]> = {}) => ({ point: 'Point', dcs: 'Their case', evidence: 'Evidence', rebuttal: 'Rebuttal', refs: '', docs: [], ...o });

describe('defence & rebuttal export', () => {
	it('keeps v5 columns in v5 order and appends the free-text refs (S-vdm_matrix_tab-1)', () => {
		const lines = defenceCsv([row({ docs: [{ ref: 'OD-1' }, { ref: 'SD-2' }], refs: 'OD-1 – OD-2' }), row()]).split('\r\n');
		expect(lines[0]).toBe('dcs_point,dcs_case,ess_evidence,documents,rebuttal,refs');
		expect(lines[1]).toBe('Point,Their case,Evidence,OD-1 SD-2,Rebuttal,OD-1 – OD-2');
		// a row without documents exports an empty documents cell (v5 example candidate)
		expect(lines[2]).toBe('Point,Their case,Evidence,,Rebuttal,');
	});
	it('exports imported values unchanged, quoting only where CSV needs it', () => {
		expect(defenceCsv([row({ point: '=SUM(A1)', evidence: 'a, "b"' })]).split('\r\n')[1]).toBe('=SUM(A1),Their case,"a, ""b""",,Rebuttal,');
	});
	it('takes five imported headings, else neutral ones', () => {
		expect(defenceHeadings(['A', 'B', 'C', 'D', 'E'])).toEqual(['A', 'B', 'C', 'D', 'E']);
		expect(defenceHeadings(null)).toBe(NEUTRAL_HEADINGS);
		expect(defenceHeadings(['A', 'B'])).toBe(NEUTRAL_HEADINGS);
		expect(defenceHeadings(['A', 'B', ' ', 'D', 'E'])).toBe(NEUTRAL_HEADINGS);
	});
});
