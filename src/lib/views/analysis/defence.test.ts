import { describe, expect, it } from 'vitest';
import { NEUTRAL_CSV_KEYS, NEUTRAL_HEADINGS, defenceCsv, defenceCsvKeys, defenceHeadings } from './defence.ts';

const row = (o: Partial<Parameters<typeof defenceCsv>[1][number]> = {}) => ({ point: 'Point', dcs: 'Their case', evidence: 'Evidence', rebuttal: 'Rebuttal', refs: '', docs: [], ...o });

describe('defence & rebuttal export', () => {
	it('keeps the given keys in their order and appends the free-text refs (S-vdm_matrix_tab-1)', () => {
		const lines = defenceCsv(['k_point', 'k_case', 'k_evidence', 'documents', 'k_rebuttal'], [row({ docs: [{ ref: 'OD-1' }, { ref: 'SD-2' }], refs: 'OD-1 – OD-2' }), row()]).split('\r\n');
		expect(lines[0]).toBe('k_point,k_case,k_evidence,documents,k_rebuttal,refs');
		expect(defenceCsv(NEUTRAL_CSV_KEYS, []).split('\r\n')[0]).toBe('point,case,evidence,documents,rebuttal,refs');
		expect(lines[1]).toBe('Point,Their case,Evidence,OD-1 SD-2,Rebuttal,OD-1 – OD-2');
		expect(lines[2]).toBe('Point,Their case,Evidence,,Rebuttal,');
	});
	it('exports imported values unchanged, quoting only where CSV needs it', () => {
		expect(defenceCsv(NEUTRAL_CSV_KEYS, [row({ point: '=SUM(A1)', evidence: 'a, "b"' })]).split('\r\n')[1]).toBe('=SUM(A1),Their case,"a, ""b""",,Rebuttal,');
	});
	it('keeps the package keys unless one would repeat the refs header', () => {
		const pkg = { keys: ['a', 'b', 'c', 'd', 'e'], note: null };
		expect(defenceCsvKeys(pkg, 'N.')).toBe(pkg);
		expect(defenceCsvKeys({ keys: ['a', 'b', 'refs', 'd', 'e'], note: null }, 'N.')).toEqual({ keys: [...NEUTRAL_CSV_KEYS], note: 'N.' });
	});
	it('takes five imported headings, else neutral ones', () => {
		expect(defenceHeadings(['A', 'B', 'C', 'D', 'E'])).toEqual(['A', 'B', 'C', 'D', 'E']);
		expect(defenceHeadings(null)).toBe(NEUTRAL_HEADINGS);
		expect(defenceHeadings(['A', 'B'])).toBe(NEUTRAL_HEADINGS);
		expect(defenceHeadings(['A', 'B', ' ', 'D', 'E'])).toBe(NEUTRAL_HEADINGS);
	});
});
