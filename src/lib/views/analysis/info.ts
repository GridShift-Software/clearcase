import { toCSV } from '../../components/csv.ts';

export interface InfoExportRow { item: string; status: string; owner: string; done: boolean }

export const INFO_CSV_NAME = 'info_required.csv';
export const infoStatus = (status: string, done: boolean) => done ? 'Done' : status;

export const infoCsv = (rows: readonly InfoExportRow[]) => toCSV([
	['Done', 'Item', 'Status', 'Owner'],
	...rows.map((r) => [r.done ? 'Yes' : 'No', r.item, infoStatus(r.status, r.done), r.owner]),
]);
