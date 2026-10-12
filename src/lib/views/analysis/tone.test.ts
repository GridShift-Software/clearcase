import { describe, expect, it } from 'vitest';
import { checkTone, infoTone, riskTone, severityBadge } from './tone.ts';

describe('analysis chip colours (v5 mapping)', () => {
	it('risk: exact, case-sensitive High/Medium, everything else ok', () => {
		expect(['High', 'Medium', 'Low', 'high', ''].map(riskTone)).toEqual(['b-dang', 'b-warn', 'b-ok', 'b-ok', 'b-ok']);
	});
	it('info required status', () => {
		expect(['Outstanding', 'In progress', 'To verify', 'outstanding'].map(infoTone)).toEqual(['b-dang', 'b-warn', 'b-info', 'b-info']);
	});
	it('contradiction severity: four keys, unknown as INFO', () => {
		expect(severityBadge('high')).toEqual({ cls: 'b-dang', label: 'HIGH' });
		expect(severityBadge('low')).toEqual({ cls: 'b-mut', label: 'LOW' });
		expect(severityBadge('critical')).toEqual({ cls: 'b-info', label: 'INFO' });
		expect(severityBadge('__proto__')).toEqual({ cls: 'b-info', label: 'INFO' });
	});
	it('check results', () => {
		expect([checkTone('PASS'), checkTone('2 FLAGGED'), checkTone('307 invoices')]).toEqual(['b-ok', 'b-dang', null]);
	});
});
