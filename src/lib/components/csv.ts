import { exportCell } from '../case-package/browser.ts';

export type Cell = string | number | null | undefined | readonly string[];
const text = (c: Cell) => (c === null || c === undefined ? '' : Array.isArray(c) ? c.join('; ') : String(c));
const SEGMENT = /([;\t\r\n] *)(?=["=+\-@\t\r])/g;
const atSegments = (s: string) => s.replace(SEGMENT, "$1'");
export const csvCell = (c: Cell) => { const s = atSegments(text(c)); return /[",;\t\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };
export const toCSV = (rows: readonly (readonly Cell[])[]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
export const userCell = (v: string | readonly string[]) => atSegments(exportCell(typeof v === 'string' ? v : v.join('; ')));

import { download as save } from './download.ts';
export const download = (name: string, content: string | Uint8Array, type = 'text/csv;charset=utf-8') => save(name, content, type);
