import { describe, expect, it } from 'vitest';
import { infoCsv, infoStatus } from './info.ts';
import { riskCsv } from './risk.ts';
import { riskDisplayTone } from './tone.ts';

describe('analysis exports', () => {
	it('shows the same risk tone for differently cased levels', () => {
		expect(['high', 'High', 'HIGH', 'medium', 'Medium', 'MEDIUM'].map(riskDisplayTone)).toEqual([
			'b-dang', 'b-dang', 'b-dang', 'b-warn', 'b-warn', 'b-warn',
		]);
	});

	it('exports the visible risk columns, score labels and safe imported text', () => {
		const csv = riskCsv([{ issue: '=1+1', category: 'Supply', likelihood: 'HIGH', likelihoodScore: 4,
			impact: 'Medium', impactScore: null, mitigation: 'Check;=2+2', owner: 'Ann', refs: ['OD-001'] }]);
		expect(csv).toBe('Issue,Category,Likelihood,Impact,Mitigation,Owner,Documents\r\n\'=1+1,Supply,HIGH (4),Medium,"Check;\'=2+2",Ann,OD-001');
	});

	it('omits absent optional risk columns rather than exporting hidden cells', () => {
		expect(riskCsv([{ issue: 'Invented risk', likelihood: 'Low', likelihoodScore: null, impact: 'High', impactScore: null, mitigation: 'Review' }]))
			.toBe('Issue,Likelihood,Impact,Mitigation\r\nInvented risk,Low,High,Review');
	});

	it('exports a completed checklist item with Done as its displayed status', () => {
		expect(infoStatus('In progress', true)).toBe('Done');
		expect(infoStatus('Outstanding', false)).toBe('Outstanding');
		expect(infoCsv([{ item: 'Invented item', status: 'In progress', owner: 'Ben', done: true }]))
			.toBe('Done,Item,Status,Owner\r\nYes,Invented item,Done,Ben');
	});
});
