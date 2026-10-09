// Types for exports.mjs.
import type { ExportEntry } from './snapshot.mjs';
export function parseCsv(text: string): string[][];
export function parseIcs(text: string): { columns: string[]; rows: string[][] };
export function canonicalJson(text: string): string;
export function unzip(buf: Uint8Array): Map<string, Buffer | null>;
export function docxText(buf: Uint8Array): string;
export function pdfText(buf: Uint8Array): Promise<string>;
export function parseDownload(d: { name: string; type: string; base64: string }): Promise<ExportEntry>;
