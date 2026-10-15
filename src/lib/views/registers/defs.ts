import type { AmountKind } from './amounts.ts';

export const REGISTER_VIEWS = ['disbursements_tab', 'timesheet_tab', 'deadlines_tab', 'privilege_tab', 'popia_tab', 'annotations_tab', 'transcriptions_tab'] as const;
export type RegisterView = (typeof REGISTER_VIEWS)[number];

export type FieldType = 'text' | 'date' | 'select' | 'textarea';
export interface FieldDef {
	k: string;
	label: string;
	type: FieldType;
	opts?: readonly string[];
	placeholder?: string;
	docRef?: boolean;
	amount?: AmountKind;
}
export type ColumnKind = 'text' | 'money' | 'value' | 'countdown' | 'category' | 'date-or-dash' | 'ref';
export interface ColumnDef { label: string; field?: string; kind: ColumnKind; num?: boolean }

export interface RegisterDef {
	view: RegisterView;
	store: string;
	subtitle: string;
	empty: string;
	fields: readonly FieldDef[];
	columns: readonly ColumnDef[];
	required?: readonly string[];
	keepAfterAdd?: readonly string[];
	export: { label: string; kind: 'csv' | 'ics'; name: string };
}

const f = (k: string, label: string, type: FieldType = 'text', more: Partial<FieldDef> = {}): FieldDef => ({ k, label, type, ...more });
const textColumns = (fields: readonly FieldDef[], over: Record<string, Partial<ColumnDef>> = {}): ColumnDef[] =>
	fields.map((x) => ({ label: x.label, field: x.k, kind: x.docRef ? 'ref' : 'text', ...over[x.k] }) as ColumnDef);

const disbursements = [f('date', 'Date', 'date'), f('desc', 'Description'), f('payee', 'Payee'), f('amount', 'Amount (R)', 'text', { amount: 'signed-money' })];
const timesheet = [f('date', 'Date', 'date'), f('fee_earner', 'Fee earner'), f('activity', 'Activity'), f('hours', 'Hours', 'text', { amount: 'hours' }), f('rate', 'Rate/h (R)', 'text', { amount: 'rate' }), f('billed', 'Billed?', 'select', { opts: ['no', 'yes'], placeholder: 'Billed?' })];
const deadlines = [f('title', 'Title'), f('date', 'Date', 'date'), f('cat', 'Category', 'select', { opts: ['Filing', 'Hearing', 'Discovery', 'Payment', 'Other'] }), f('note', 'Note')];
const privilege = [f('ref', 'Doc ref', 'text', { docRef: true }), f('date', 'Date', 'date'), f('desc', 'Description'), f('basis', 'Privilege basis', 'select', { opts: ['Legal advice', 'Litigation', 'Without prejudice', 'Other'], placeholder: 'Privilege basis' })];
const popia = [f('activity', 'Processing activity'), f('category', 'Data category'), f('lawful', 'Lawful basis'), f('retention', 'Retention')];
const annotations = [f('ref', 'Doc ref', 'text', { docRef: true }), f('date', 'Date', 'date'), f('note', 'Note', 'textarea')];
const transcripts = [f('title', 'Title'), f('date', 'Date', 'date'), f('source', 'Source'), f('body', 'Transcript text', 'textarea')];

const csv = (store: string) => ({ label: 'Export CSV', kind: 'csv' as const, name: `${store}.csv` });

export const REGISTERS: Readonly<Record<RegisterView, RegisterDef>> = Object.freeze({
	disbursements_tab: { view: 'disbursements_tab', store: 'disbursements', subtitle: 'Disbursement ledger (saved in this browser)', empty: 'No disbursements recorded.', fields: disbursements,
		columns: textColumns(disbursements, { amount: { kind: 'money', num: true } }), export: csv('disbursements') },
	timesheet_tab: { view: 'timesheet_tab', store: 'timesheet', subtitle: 'Time-recording ledger with CSV export', empty: 'No time recorded.', fields: timesheet,
		columns: [...textColumns(timesheet, { hours: { num: true }, rate: { num: true } }), { label: 'Value', kind: 'value', num: true }], export: csv('timesheet') },
	deadlines_tab: { view: 'deadlines_tab', store: 'deadlines', subtitle: 'Deadline tracker with days-until countdown and calendar export', empty: 'No deadlines yet.', fields: deadlines,
		columns: [{ label: 'Date', field: 'date', kind: 'date-or-dash' }, { label: 'Countdown', field: 'date', kind: 'countdown' }, { label: 'Title', field: 'title', kind: 'text' }, { label: 'Category', field: 'cat', kind: 'category' }, { label: 'Note', field: 'note', kind: 'text' }],
		required: ['title', 'date'], keepAfterAdd: ['cat'], export: { label: 'Export .ics', kind: 'ics', name: 'deadlines.ics' } },
	privilege_tab: { view: 'privilege_tab', store: 'privilege', subtitle: 'Documents withheld / redacted for privilege', empty: 'No privilege entries.', fields: privilege, columns: textColumns(privilege), export: csv('privilege') },
	popia_tab: { view: 'popia_tab', store: 'popia', subtitle: 'Records of personal-information processing in the matter', empty: 'No POPIA records.', fields: popia, columns: textColumns(popia), export: csv('popia') },
	annotations_tab: { view: 'annotations_tab', store: 'annotations', subtitle: 'Private notes (saved in this browser)', empty: 'No annotations yet.', fields: annotations, columns: textColumns(annotations), export: csv('annotations') },
	transcriptions_tab: { view: 'transcriptions_tab', store: 'transcripts', subtitle: 'Transcript store (hearings, recordings)', empty: 'No transcripts stored.', fields: transcripts, columns: textColumns(transcripts), export: csv('transcripts') },
});

export const registerOf = (view: string): RegisterDef => {
	const d = (REGISTERS as Record<string, RegisterDef>)[view];
	if (!d) throw new Error(`not a register view: ${view}`);
	return d;
};
