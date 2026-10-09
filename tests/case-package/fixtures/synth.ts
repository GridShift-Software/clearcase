// Synthetic v5-shaped fixture: a workspace HTML with the four data lines and a case folder of
// invented originals. Every value is made up (names, dates, amounts); nothing comes from a case.
// Used by the tests, the schema check and the synthetic verification lanes.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type J = Record<string, unknown>;

/** Originals in the synthetic case folder: path -> bytes. */
export function synthOriginals(): Record<string, Uint8Array> {
  const enc = (s: string) => new TextEncoder().encode(s);
  return {
    'DISCOVERY A/OD-001 Supply agreement.pdf': enc('%PDF-1.4\n% synthetic agreement\n%%EOF\n'),
    'DISCOVERY A/OD-002 Invoice 1001.pdf': enc('%PDF-1.4\n% synthetic invoice 1001\n%%EOF\n'),
    'DISCOVERY A/OD-003 Scan.pdf': enc('%PDF-1.4\n% synthetic scan without text\n%%EOF\n'),
    'DISCOVERY A/OD-004 Photo.jpg': new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1]),
    'MAIL/EM-0001 Re payment.eml': enc('From: a@example.invalid\nSubject: synthetic\n\nbody\n'),
    'MAIL/EM-0002 Statement café.msg': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3]),
    'DISCOVERY B/SD-001 Statement.pdf': enc('%PDF-1.4\n% synthetic statement\n%%EOF\n'),
  };
}

const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');

function row(ref: string, n: string, file: string, size: number, o: Partial<J> = {}): J {
  return {
    n, ref, date: '2001-02-03', filename: file.split('/').pop(), subject: `Synthetic subject ${ref}`, sender: 'Ann Lee', to: 'Org A Ltd', cc: '',
    excerpt: 'Invented excerpt.', doc_type: 'other', bundle: 'Original', amount: '', also_in: [], text_status: 'extracted', url: url(file),
    refs: [], invoice_no: '', size, seq: n, attachments: [], ...o,
  };
}

export interface SynthRoots { DATA: J; META: J; SCHED: J; CASELINES: J }

/** Every recognized v5 dataset with one to three invented records. */
export function synthRoots(): SynthRoots {
  const o = synthOriginals();
  const sz = (p: string) => o[p]!.byteLength;
  const chronology = [
    row('OD-001', '1', 'DISCOVERY A/OD-001 Supply agreement.pdf', sz('DISCOVERY A/OD-001 Supply agreement.pdf'), { doc_type: 'SLA' }),
    row('OD-002', '2', 'DISCOVERY A/OD-002 Invoice 1001.pdf', sz('DISCOVERY A/OD-002 Invoice 1001.pdf'), { doc_type: 'invoice', amount: '1150.00', invoice_no: 'INV01001', date: '2001-02-28' }),
    row('OD-003', '3', 'DISCOVERY A/OD-003 Scan.pdf', sz('DISCOVERY A/OD-003 Scan.pdf'), { text_status: 'none', date: '' }),
    row('OD-004', '4', 'DISCOVERY A/OD-004 Photo.jpg', sz('DISCOVERY A/OD-004 Photo.jpg'), { text_status: 'none' }),
    row('EM-0001', '5', 'MAIL/EM-0001 Re payment.eml', sz('MAIL/EM-0001 Re payment.eml'), { doc_type: 'email', bundle: 'Correspondence', attachments: ['quote.pdf', 'image001.png', 'image001.png'] }),
    row('EM-0002', '6', 'MAIL/EM-0002 Statement café.msg', sz('MAIL/EM-0002 Statement café.msg'), { doc_type: 'email', bundle: 'Correspondence', text_status: 'pending', attachments: ['statement.xlsx'] }),
    row('SD-001', '7', 'DISCOVERY B/SD-001 Statement.pdf', sz('DISCOVERY B/SD-001 Statement.pdf'), { doc_type: 'statement', bundle: 'Supplementary', amount: '-20.50' }),
  ];
  const series = (ref: string, file: string) => ({ amount: '100.00', date: '2001-03-04', filename: file.split('/').pop(), ref, url: url(file) });
  const docLink = { date: '2001-02-03', doc_type: 'SLA', filename: 'OD-001 Supply agreement.pdf', ref: 'OD-001', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') };
  const regItem = { date: '2001-02-03', doc_type: 'SLA', note: 'Invented note', party: '', ref: 'OD-001', role: '', text_status: 'extracted', title: 'Synthetic agreement', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') };
  const part = { name: 'OD-001 Supply agreement.pdf', rel: 'DISCOVERY A/OD-001 Supply agreement.pdf', url: url('DISCOVERY A/OD-001 Supply agreement.pdf'), from: 1, to: 2 };
  const DATA: J = {
    chronology,
    people: [{ name: 'Ann Lee', email: 'ann@example.invalid', org: 'Org A Ltd', sent: 2, received: 1, total: 3, role: '' }],
    entities: [{ name: 'Org A Ltd', note: 'Invented entity', role: 'Claimant' }],
    matter: { title: 'Synthetic matter', short: 'SYN', forum: 'Invented forum', storyline: [{ h: 'Start', t: 'The agreement [[OD-001]] began the relationship; see also OD-002.' }], strategy: [{ h: 'Plan', t: 'Rely on [[OD-002#p2]].' }] },
    quantum: {
      amountDueSeries: [series('OD-002', 'DISCOVERY A/OD-002 Invoice 1001.pdf')], statementSeries: [series('SD-001', 'DISCOVERY B/SD-001 Statement.pdf')], interestSeries: [],
      invoiceLedger: [{ amount: '1150.00', bundle: 'Original', date: '2001-02-28', no: 'INV01001', ref: 'OD-002', text_status: 'extracted', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf') }],
      chargingCount: 0, invoiceCount: 1, grossInvoiced: '1150.00', headline_date: '2001-03-04', headline_due: '1150.00', headline_ref: 'OD-002', headline_url: url('DISCOVERY A/OD-002 Invoice 1001.pdf'),
    },
    riskMatrix: [{ issue: 'Invented issue', likelihood: 'Low', impact: 'High', mitigation: 'Invented mitigation' }],
    defenceMatrix: [{ point: 'Point', dcs: 'Defence', rebuttal: 'Rebuttal citing [[SD-001]]', evidence: 'Evidence', refs: 'OD-001 – OD-002', docs: [docLink] }],
    infoRequired: [{ item: 'Invented item', owner: 'Ann', status: 'Outstanding' }],
    witnesses: [{ name: 'Ann Lee', role: 'Supply', willsay: 'Invented statement' }],
    buildReport: { generatedFrom: 'synthetic generator', pending: [{ bundle: 'Correspondence', filename: 'EM-0002 Statement café.msg', ref: 'EM-0002' }], textNone: [{ bundle: 'Original', filename: 'OD-003 Scan.pdf', ref: 'OD-003' }] },
    linkSample: [{ bundle: 'Original', filename: 'OD-001 Supply agreement.pdf', ref: 'OD-001', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') }],
    timeline: {
      events: [{ date: '2001-02-03', kind: 'Contract', note: 'Invented', ref: 'OD-001', title: 'Agreement signed', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') }],
      phases: [['Phase one', 'Invented phase'], ['Phase two']],
      yearCounts: { '2001': 7 },
      typeByYear: { '2001': { SLA: 1, invoice: 1, email: 2 } },
    },
    contracts: { count: 1, groups: [{ key: 'Agreements', items: [regItem] }] },
    filings: { count: 1, groups: [{ key: 'Filings', note: 'Invented', items: [regItem] }], registerSeed: [{ fdate: '2001-04-05', filing: 'Statement of claim', fparty: 'Claimant', rdate: '', ref: 'OD-001', response: 'None yet', status: 'Filed' }] },
    contradictions: {
      byCat: { rate: 1 },
      categories: [{ key: 'rate', title: 'Rates', severity: 'high', explain: 'Invented', items: [{ label: 'Rate A', detail: 'Invented', rates: { OLD: '1.00' }, spread: '0.10', refs: [{ amount: '1.00', filename: 'OD-002 Invoice 1001.pdf', ref: 'OD-002', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf') }] }] }],
      checks: [{ check: 'Invented check', n: 1, result: 'ok' }], highCount: 1, total: 1,
    },
    lit: {
      enforcement: [{ phase: '1 · Start', step: 'Invented step', basis: 'Invented basis', status: 'To do', note: '' }],
      legality: { intro: 'Invented', docs: [{ date: '2001-02-03', ref: 'OD-001', title: 'Agreement', url: url('DISCOVERY A/OD-001 Supply agreement.pdf') }], factors: [{ factor: 'F', note: 'N' }], scenarios: [{ scenario: 'S', prob: 'Possible', effect: 'E', action: 'A' }] },
      authorities: [{ topic: 'T', authority: 'Invented v Invented', proposition: 'P' }],
      elements: [{ element: 'E', must: 'M', evidence: 'Ev', witness: 'W', tab: 'chronology' }],
      crossexam_seed: [{ witness: 'Ann Lee', topic: 'Payment', put: 'Invented put', docs: 'OD-002' }],
      prescription: [{ no: 'INV01001', ref: 'OD-002', date: '2001-02-28', prescDate: '2004-02-28', risk: 'Low', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf') }],
      prescSummary: { awardDate: '2002-01-01', note: 'Invented', reliesOnInterruption: 0, total: 1 },
      interestBasis: { award_date: '2002-01-01', first_invoice_date: '2001-02-28', headline_date: '2001-03-04', headline_due: '1150.00', note: 'Invented' },
      recon: [{ month: '2001-02', invoice: ['OD-002'], statement: ['SD-001'], supporting: [], charging: [], amountdue: [], pod: [] }],
      settlement: { claim: '1150.00', claimDate: '2001-03-04' },
    },
    bundles: {
      source: 'synthetic', indexSource: 'synthetic', folder: './DISCOVERY%20A/', extracts: './DISCOVERY%20A/', caselinesSrc: url('DISCOVERY A/OD-001 Supply agreement.pdf'),
      count: 1, catCount: 1, totalDocs: 1, totalItems: 1, totalPages: 2,
      headerDefaults: { caseNo: '1/2001', claimant: 'Org A Ltd', claimantRole: 'Claimant', court: 'Invented court', defendant: 'Org B Ltd', defendantRole: 'Defendant', intro: 'Index', judge: 'Invented' },
      caselinesSections: { '001': { from: 1, to: 2, title: 'Pleadings' } },
      catalogue: {
        'OD-1': { key: 'OD-1', item: 1, src: 'OD', srcName: 'Original', co: 'C', date: '03/02/2001', desc: 'Invented', missing: false, nDocs: 1, pages: 2, docs: [{ ref: 'OD-001', name: 'OD-001 Supply agreement.pdf', ext: 'pdf', pages: 2, url: url('DISCOVERY A/OD-001 Supply agreement.pdf') }], parts: [{ ...part, n: 1, whole: true }], blank: false, caselines: null },
        'XD-1': { key: 'XD-1', item: 2, src: 'XD', srcName: 'Other', co: '', date: '', desc: 'Unresolved', missing: true, nDocs: 1, pages: 0, docs: [{ ref: 'XD-017', name: 'gone.pdf', ext: 'pdf', pages: 0, url: url('DISCOVERY A/OD-001 Supply agreement.pdf') }], parts: [] },
      },
      list: [{
        no: '1', name: 'Bundle A', slug: 'bundle-a', title: 'Bundle A', note: 'Invented', file: url('DISCOVERY A/OD-001 Supply agreement.pdf'), indexFile: url('DISCOVERY A/OD-001 Supply agreement.pdf'), planFile: 'plan.json',
        pages: 2, bundlePages: 2, filePages: 2, indexPages: 1, nDocs: 1, nItems: 1, nMissing: 0, nNeedsExtent: 0, nReview: 0, items: ['OD-1'],
        rows: [{ key: 'OD-1', n: 1, desc: 'Invented', from: 1, to: 2, pages: 2, parts: [part], co: 'C', date: '03/02/2001' }],
      }],
    },
  };
  const META: J = {
    builtAt: '2001-05-06 07:08', docCount: 7, dataFolderName: 'Synthetic case', bundles: { Original: 4, Correspondence: 2, Supplementary: 1 },
    emails: 1, invoices: 1, people: 1, textNone: 1, textPending: 1, dateSpan: ['2001-02-03', '2001-03-04'],
    docTypes: { SLA: 1, invoice: 1, other: 2, email: 2, statement: 1 },
  };
  const SCHED: J = {
    discovery: [{ no: 1, date: '03/02/2001', desc: 'Invented', co: 'C', nfiles: 1, files: [{ fn: 'OD-001 Supply agreement.pdf', url: url('DISCOVERY A/OD-001 Supply agreement.pdf'), co: 'C' }] }],
    supplementary: [{ no: 1, date: '', desc: 'Invented', co: '', nfiles: 1, files: [{ fn: 'SD-001 Statement.pdf', url: url('DISCOVERY B/SD-001 Statement.pdf'), co: '', x: 'extra' }] }],
  };
  const CASELINES: J = { file: 'BUNDLE.pdf', pages: 2, index: [[1, 'Invented page one'], [2, 'Invented page two']] };
  return { DATA, META, SCHED, CASELINES };
}

/** One-line JSON as the v5 builder writes it (not the canonical form). */
const line = (v: unknown) => JSON.stringify(v);

/** v5-shaped workspace HTML. The script blocks would mark the page if anything executed them. */
export function synthHtml(r: SynthRoots, extraLines: string[] = []): Uint8Array {
  const html = [
    '<!DOCTYPE html>', '<html><head><meta charset="utf-8"><title>Synthetic workspace</title></head><body>', '<script>',
    "globalThis.__executed = true; document.title = 'EXECUTED';",
    "const NAV = [{ id: 'overview', label: 'Overview' }];",
    "const STORE_KEYS = ['syn_case_deadlines_v1'];",
    `const DATA = ${line(r.DATA)};`,
    `const META = ${line(r.META)};`,
    'function render() { return DATA.chronology.length; }',
    '</script>', '<script>',
    `window.__SCHED__ = ${line(r.SCHED)};`,
    '</script>', '<script>',
    `window.__CASELINES_IDX__ = ${line(r.CASELINES)};`,
    '</script>', ...extraLines, '</body></html>', '',
  ].join('\n');
  return new TextEncoder().encode(html);
}

export async function writeCaseFolder(dir: string, files: Record<string, Uint8Array> = synthOriginals()): Promise<void> {
  for (const [p, b] of Object.entries(files)) {
    const abs = path.join(dir, ...p.split('/'));
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, b);
  }
}

export async function tempDir(tag: string): Promise<string> {
  return mkdtemp(path.join(process.env.CLEARCASE_TEST_TMP ?? os.tmpdir(), `cc-${tag}-`));
}

export const cleanup = (dir: string) => rm(dir, { recursive: true, force: true });
