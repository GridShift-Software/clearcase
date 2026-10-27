import type { DatasetEnvelope } from '../../../src/lib/case-package/schema.ts';
import { fingerprint } from '../../../src/lib/case-package/diagnostics.ts';

// Synthetic only: the poc profile's size (1,689 documents) with the v5 sample's two META disagreements, textNone 237 against 255
// and emails 469 against 629. Every other META count is exact, so the gate's derivation must name exactly those two.
export const DOCUMENTS = 1689, NONE = 255, EMAILS = 629, PENDING = 12, INVOICES = 41, PEOPLE = 80;
const BUNDLES: Record<string, number> = { Correspondence: 700, Original: 900, Supplementary: 89 };

export function pocChronology(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < DOCUMENTS; i++) {
    const ref = `SY-${String(i + 1).padStart(4, '0')}`;
    rows.push({ n: String(i + 1), seq: String(i + 1), ref, date: '2200-01-01', filename: `${ref}.pdf`, subject: `Synthetic subject ${ref}`, sender: 'Synthetic Sender', to: 'Synthetic Recipient',
      cc: '', excerpt: 'Invented excerpt.', amount: '', also_in: [], url: `./${ref}.pdf`, refs: [], invoice_no: '', size: 1000 + i, attachments: [],
      doc_type: i < EMAILS ? 'email' : i < EMAILS + INVOICES ? 'invoice' : i % 2 ? 'SLA' : 'statement',
      bundle: i < 700 ? 'Correspondence' : i < 1600 ? 'Original' : 'Supplementary',
      text_status: i % 6 === 0 && i / 6 < NONE ? 'none' : i % 6 === 1 && (i - 1) / 6 < PENDING ? 'pending' : 'extracted' });
  }
  return rows;
}

const envelope = (key: string, schema: string, sourcePath: string, data: unknown): DatasetEnvelope => ({ envelope: 'clearcase.dataset/1', key, kind: 'source', schema, required: true,
  count: Array.isArray(data) ? data.length : 1, provenance: { source: 'v5-workspace-html', sourcePath, adapter: 'synthetic/1' }, data }) as unknown as DatasetEnvelope;

export interface PocOptions { meta?: Record<string, unknown>; people?: unknown; rows?: Record<string, unknown>[] }
export function pocDatasets(o: PocOptions = {}): DatasetEnvelope[] {
  const rows = o.rows ?? pocChronology();
  const count = (field: string, value: string) => rows.filter((r) => r[field] === value).length;
  const tally = (field: string) => { const t: Record<string, number> = {}; for (const r of rows) t[r[field] as string] = (t[r[field] as string] ?? 0) + 1; return t; };
  const meta = { builtAt: '2200-01-01T00:00:00Z', docCount: rows.length, dataFolderName: 'SYNTHETIC ONLY', bundles: tally('bundle'), emails: count('doc_type', 'email'), invoices: count('doc_type', 'invoice'),
    people: PEOPLE, textNone: count('text_status', 'none'), textPending: count('text_status', 'pending'), dateSpan: ['2200-01-01', '2200-01-01'], docTypes: tally('doc_type'), ...o.meta };
  const people = o.people ?? Array.from({ length: PEOPLE }, (_, i) => ({ name: `Synthetic ${i}`, email: '', org: '', sent: 0, received: 0, total: 0, role: '' }));
  return [envelope('chronology', 'v5.chronology@1', 'DATA.chronology', rows), envelope('people', 'v5.people@1', 'DATA.people', people), envelope('meta', 'v5.meta@1', 'META', meta)];
}
/** The META of the sample: textNone and emails carried below what the records give. */
export const disagreeingMeta = { textNone: 237, emails: 469 };

/** What the canonical validator reports for one scalar META disagreement: the fingerprint of its V5_META_COUNT_DISAGREEMENT warning. */
export const diagnosticFingerprint = (field: string) => fingerprint('V5_META_COUNT_DISAGREEMENT', { file: 'datasets/meta.json', pointer: `/data/${field}`, subject: `META.${field}` });
export const bothDiagnostics = () => [diagnosticFingerprint('textNone'), diagnosticFingerprint('emails')];
/** The same for one key of a META tally (`bundles` or `docTypes`): the pointer escapes the key, the subject quotes it. */
export const groupDiagnosticFingerprint = (group: 'bundles' | 'docTypes', key: string) =>
  fingerprint('V5_META_COUNT_DISAGREEMENT', { file: 'datasets/meta.json', pointer: `/data/${group}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, subject: `META.${group}[${JSON.stringify(key)}]` });
