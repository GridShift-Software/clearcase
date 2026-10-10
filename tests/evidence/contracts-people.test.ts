// Contracts' Signed marker (S-contracts_tab-1, corrected) and export; People and Entities keep raw values and never
// present an inferred identity as verified (BA-07). Synthetic values.
import { describe, expect, it } from 'vitest';
import { toCSV } from '../../src/lib/components/csv.ts';
import { contractsCsvRows, signedChip } from '../../src/lib/views/evidence/contracts.ts';
import { anyRole, entities, looksAutomated, people } from '../../src/lib/views/evidence/people.ts';

describe('contracts', () => {
	it('reads the Signed marker as words in the title and note', () => {
		// the checklist's synthetic examples, with v5's misreadings corrected
		expect(signedChip({ title: 'X', note: 'unsigned draft' })).toBe('unsigned');
		expect(signedChip({ title: 'Final agreement', note: '' })).toBe('signed');
		expect(signedChip({ title: 'Schedule', note: '' })).toBe('—');
		expect(signedChip({ title: 'Unsigned copy', note: '' })).toBe('unsigned'); // v5: 'signed'
		expect(signedChip({ title: 'Deed of assignment', note: '' })).toBe('—'); // v5: 'signed'
		expect(signedChip({ title: 'Designated areas', note: 'signature page missing' })).toBe('—'); // v5: 'signed'
		expect(signedChip({ title: 'Lease', note: 'SIGNED by both' })).toBe('signed');
		expect(signedChip({ title: 'Lease', note: 'executed copy' })).toBe('signed');
	});

	it('reads negated wording as uncertain and the forms that mean signed as signed (D7)', () => {
		// the verification lanes' synthetic examples
		expect(signedChip({ title: 'Supply agreement', note: 'not executed' })).toBe('—');
		expect(signedChip({ title: 'Agreement (not signed)', note: '' })).toBe('—');
		expect(signedChip({ title: 'Lease', note: 'never signed by tenant' })).toBe('—');
		expect(signedChip({ title: 'Countersigned lease', note: '' })).toBe('signed');
		expect(signedChip({ title: 'Finalised agreement', note: '' })).toBe('signed');
		// each negation word, before signed or executed
		for (const note of ['not signed', 'never signed', 'yet to be signed', 'not executed', 'never executed', 'yet to be executed', 'not yet countersigned', 'has not been signed', 'NOT FINALISED']) expect(signedChip({ title: 'Lease', note }), note).toBe('—');
		for (const title of ['Finalized agreement', 'Executed lease', 'Countersigned deed']) expect(signedChip({ title, note: '' }), title).toBe('signed');
		// 'unsigned' still wins
		expect(signedChip({ title: 'Unsigned, not executed', note: '' })).toBe('unsigned');
	});

	it('exports every item in v5 columns, CRLF separated (checklist example)', () => {
		const csv = toCSV(contractsCsvRows([{ key: 'G1', items: [{ ref: 'OD-1', date: '', title: 'T1', note: '', text_status: 'none', url: './a.pdf' }] }, { key: 'G2', items: [{ ref: 'OD-2', date: '2001-02-03', title: 'T2', note: 'n, with comma', text_status: 'extracted', url: './b.pdf' }] }]));
		expect(csv).toBe('group,ref,date,title,note,text_status,url\r\nG1,OD-1,,T1,,none,./a.pdf\r\nG2,OD-2,2001-02-03,T2,"n, with comma",extracted,./b.pdf');
	});
});

describe('people and entities (BA-07)', () => {
	const automated = { name: 'Synthetic Mailer', email: 'no-reply@example.test', org: 'Synthetic Attorneys Inc', sent: 3, received: 0, total: 3, role: 'attorney' };
	it('keeps every raw value of an automated sender unchanged', () => {
		expect(people([automated])).toEqual([automated]);
		expect(entities([{ name: 'Synthetic Body', role: 'Respondent', note: 'n' }])).toEqual([{ name: 'Synthetic Body', role: 'Respondent', note: 'n' }]);
		expect(people(null)).toBeNull();
	});
	it('marks machine-looking addresses as a hint, and shows the Role column only when a role is supplied', () => {
		for (const e of ['no-reply@x.test', 'noreply@x.test', 'do_not_reply@x.test', 'MAILER-DAEMON@x.test', 'notifications+abc@x.test', 'alerts@x.test']) expect(looksAutomated(e)).toBe(true);
		for (const e of ['jane.doe@x.test', 'replyto@x.test', 'systems.admin@x.test', '']) expect(looksAutomated(e)).toBe(false);
		expect(anyRole([{ ...automated, role: '' }])).toBe(false);
		expect(anyRole([automated])).toBe(true);
	});
});
