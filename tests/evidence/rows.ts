// Synthetic document-list rows for the evidence unit tests (the ChronologyListRow shape the document-row contract serves).
import type { ChronologyListRow } from '../../src/lib/local-case/model.ts';

let ord = 0;
export const resetOrd = () => { ord = 0; };
export function listRow(ref: string, o: Partial<ChronologyListRow> = {}): ChronologyListRow {
	return {
		ref, ord: ord++, date: '', dateType: null, dateSource: null, docType: 'other', bundle: 'Original', subject: '', filename: `${ref} synthetic.pdf`,
		sender: '', to: '', excerpt: '', amount: '', alsoIn: [], url: `./${ref}.pdf`, textStatus: 'extracted', parentRef: null, file: 'present', preview: 'inline-isolated', attachments: 0,
		...o,
	};
}
