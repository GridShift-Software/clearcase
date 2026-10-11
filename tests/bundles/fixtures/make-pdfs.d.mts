export interface PdfOptions { name: string; pages?: number; rotate?: number; cropBox?: number[]; form?: boolean; inherit?: boolean; objStm?: boolean; encrypt?: boolean }
export function makePdf(o: PdfOptions): Uint8Array;
export const SET: Record<'Alpha_Statement.pdf' | 'Beta_Letter.pdf' | 'Gamma_Report.pdf' | 'Locked.pdf', PdfOptions>;
