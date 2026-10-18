// Entirely invented corpus built through the pilot's real converter and package writer.
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCase, putOriginal, row, url } from '../../../tests/e2e/pilot/lib/fixtures.ts';
import { SYNTH_VIEW_CODE } from '../../../tests/case-package/fixtures/synth.ts';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import { KNOWN_KEYS } from '../../../src/lib/case-package/registry.ts';
import { VIEWS } from '../../../src/lib/components/view-registry.ts';
import { pdf, png, originalSize, sizeSummary, type Profile } from './originals.ts';
import { seededRandom } from './random.ts';

export interface CorpusOptions { out: string; seed: string; documents: number; profile: Profile }
const enc = (s: string) => new TextEncoder().encode(s);
export const words = ['Amber', 'Acorn', 'Birch', 'Cedar', 'Coral', 'Fern', 'Flint', 'Grove', 'Hazel', 'Iris', 'Jade', 'Juniper', 'Kestrel', 'Larch', 'Maple', 'Moss', 'Opal', 'Pebble', 'Quartz', 'Reed', 'Sage', 'Spruce', 'Thistle', 'Willow'];

export async function generateCorpus({ out, seed, documents: count, profile }: CorpusOptions) {
  const parent = await realpath(path.dirname(path.resolve(out)));
  const repository = await realpath(path.resolve(import.meta.dirname, '../../..'));
  const destination = path.join(parent, path.basename(path.resolve(out)));
  if (destination === repository || destination.startsWith(repository + path.sep)) {
    throw new Error('--out must be outside the checkout (including symlinked parents)');
  }
  // An exclusive mkdir is essential: buildCase removes pkg/ before writing it.
  await mkdir(destination);
  const caseDir = path.join(destination, 'case');
  await mkdir(caseDir);
  const random = seededRandom(seed);
  const integer = (n: number) => Math.floor(random() * n);
  const word = () => words[integer(words.length)] ?? 'Acorn';
  const name = () => `Synthetic ${word()} ${word()}`;
  // Seeded day offsets in a fictional future decade avoid modern case-date needles.
  const date = () => new Date(Date.UTC(2200, 0, 1) + integer(3652) * 86400000).toISOString().slice(0, 10);
  const amount = () => ((10000 + integer(990000)) / 100).toFixed(2);
  const seedHash = sha256Hex(enc(seed)).slice(0, 12);
  const originalFiles: { path: string; sha256: string; size: number }[] = [];
  const save = async (relative: string, bytes: Uint8Array) => {
    await putOriginal(caseDir, relative, bytes);
    originalFiles.push({ path: relative, sha256: sha256Hex(bytes), size: bytes.length });
  };
  const imageCount = Math.min(8, Math.floor(count / 6));
  const docTypes = ['SLA', 'invoice', 'email', 'statement', 'filing', 'other'];
  const pageCounts = new Map<string, number>();
  async function makeDocument(i: number) {
    const ref = `SY-${String(i + 1).padStart(4, '0')}`;
    const image = i >= count - imageCount;
    const pages = i > 0 && i % 250 === 0 ? 3 + integer(3) : 1;
    const filename = `${ref} SYNTHETIC ${word()} ${word()}.${image ? 'png' : 'pdf'}`;
    const rel = `SYNTHETIC-${String(i % 8 + 1).padStart(2, '0')}/${filename}`;
    const targetBytes = originalSize(profile, random);
    const bytes = image ? png(integer, targetBytes) : pdf(`SYNTHETIC ${ref} seed ${seedHash} ${word()} ${word()}`, pages, targetBytes);
    await save(rel, bytes);
    pageCounts.set(ref, image ? 1 : pages);
    const base = {
      ref, date: date(), filename,
      subject: `${name()} ${word()} record ${i + 1}`, sender: name(), to: name(),
      excerpt: `SYNTHETIC ONLY. ${Array.from({ length: 45 }, () => `${word()} ${word()} invented text.`).join(' ')}`,
      doc_type: image ? 'image' : docTypes[i % docTypes.length] ?? 'other', bundle: `Synthetic group ${i % 8 + 1}`,
      amount: amount(), text_status: image ? 'none' : i % 37 === 0 ? 'ocr' : 'extracted',
      url: url(rel), invoice_no: `SYNINV${String(i + 1).padStart(5, '0')}`,
    };
    // Reuse the pilot helper's canonical chronology defaults and locator handling.
    return { ...row(ref, i + 1, rel, bytes.length, base), ...base };
  }
  const docs: Awaited<ReturnType<typeof makeDocument>>[] = [];
  for (let i = 0; i < count; i++) docs.push(await makeDocument(i));
  const first = docs[0];
  if (!first) throw new Error('empty synthetic corpus');
  const series = (d: typeof first) => ({ amount: d.amount, date: d.date, filename: d.filename, ref: d.ref, url: d.url });
  const docLink = (d: typeof first) => ({ date: d.date, doc_type: d.doc_type, filename: d.filename, ref: d.ref, url: d.url });
  const register = (d: typeof first) => ({ date: d.date, doc_type: d.doc_type, ref: d.ref, url: d.url, note: 'SYNTHETIC invented register row', party: d.sender, role: 'Synthetic role', text_status: d.text_status, title: d.subject });
  const invoices = docs.filter(d => d.doc_type === 'invoice');
  const statements = docs.filter(d => d.doc_type === 'statement');
  const contracts = docs.filter(d => d.doc_type === 'SLA');
  const filings = docs.filter(d => d.doc_type === 'filing');
  const sum = invoices.reduce((n, d) => n + Math.round(Number(d.amount) * 100), 0);
  const totalAmount = (sum / 100).toFixed(2);
  const people = Array.from({ length: 64 }, (_, i) => ({ name: `${name()} ${i + 1}`, email: `synthetic-${i + 1}@example.invalid`, org: name(), sent: integer(50), received: integer(50), total: 0, role: 'Invented role' }));
  for (const p of people) p.total = p.sent + p.received;
  const years: Record<string, number> = {}, types: Record<string, number> = {}, bundles: Record<string, number> = {};
  const typeByYear: Record<string, Record<string, number>> = {};
  for (const d of docs) {
    const year = d.date.slice(0, 4); years[year] = (years[year] ?? 0) + 1;
    types[d.doc_type] = (types[d.doc_type] ?? 0) + 1; bundles[d.bundle] = (bundles[d.bundle] ?? 0) + 1;
    const bucket = typeByYear[year] ??= {}; bucket[d.doc_type] = (bucket[d.doc_type] ?? 0) + 1;
  }
  const narrative = (d: typeof first) => `SYNTHETIC ${word()} ${word()} analysis of [[${d.ref}#p1]]. Invented only.`;
  const quantum = {
    amountDueSeries: invoices.map(series), statementSeries: statements.map(series), interestSeries: invoices.slice(0, 40).map(series),
    invoiceLedger: invoices.map(d => ({ amount: d.amount, bundle: d.bundle, date: d.date, no: d.invoice_no, ref: d.ref, text_status: d.text_status, url: d.url })),
    chargingCount: 0, invoiceCount: invoices.length, grossInvoiced: totalAmount, headline_date: first.date, headline_due: totalAmount, headline_ref: first.ref, headline_url: first.url,
  };
  let bundlePage = 1;
  const bundleEntries = docs.slice(0, 96).map((d, i) => {
    const pages = pageCounts.get(d.ref) ?? 1;
    const key = `SYN-${i + 1}`;
    const rel = decodeURIComponent(d.url.slice(2));
    const part = { name: d.filename, rel, url: d.url, from: 1, to: pages };
    const catalogue = { key, item: i + 1, src: 'SYN', srcName: 'Synthetic', co: 'S', date: d.date, desc: d.subject, missing: false, nDocs: 1, pages, docs: [{ ref: d.ref, name: d.filename, ext: d.doc_type === 'image' ? 'png' : 'pdf', pages, url: d.url }], parts: [{ ...part, n: 1, whole: true }], blank: false, caselines: null };
    const row = { key, n: i + 1, desc: d.subject, from: bundlePage, to: bundlePage + pages - 1, pages, parts: [part], co: 'S', date: d.date };
    bundlePage += pages;
    return { key, catalogue, row };
  });
  const catalogue = Object.fromEntries(bundleEntries.map(e => [e.key, e.catalogue]));
  const bundleRows = bundleEntries.map(e => e.row);
  const totalPages = bundlePage - 1;
  const packagePdf = pdf('SYNTHETIC package bundle', totalPages);
  await save('SYNTHETIC-BUNDLES/bundle.pdf', packagePdf);
  await save('SYNTHETIC-BUNDLES/index.pdf', pdf('SYNTHETIC bundle index', 2));
  const schedule = (subset: typeof docs) => subset.map((d, i) => ({ no: i + 1, date: d.date, desc: d.subject, co: 'S', nfiles: 1, files: [{ fn: d.filename, url: d.url, co: 'S' }] }));
  const builtAt = `${date()} 12:00`;
  const viewCode = SYNTH_VIEW_CODE.replaceAll('./INVENTED%20FOLDER/INVENTED%20BUNDLE.pdf', './SYNTHETIC-BUNDLES/bundle.pdf').replaceAll('INVENTED BUNDLE.pdf', 'SYNTHETIC bundle.pdf');
  const result = await buildCase(destination, { caseId: `synthetic-${seedHash}`, caseDir, viewCode, edit(roots) {
    roots.DATA = {
      chronology: docs, people, entities: Array.from({ length: 12 }, () => ({ name: name(), note: 'SYNTHETIC invented entity', role: 'Invented role' })),
      matter: { title: `${name()} training matter`, short: 'SYNTHETIC', forum: 'SYNTHETIC training forum', storyline: docs.slice(0, 12).map(d => ({ h: d.subject, t: narrative(d) })), strategy: docs.slice(12, 18).map(d => ({ h: d.subject, t: narrative(d) })) },
      quantum,
      riskMatrix: docs.slice(0, 24).map(d => ({ issue: d.subject, likelihood: 'Low', impact: 'Medium', mitigation: narrative(d) })),
      defenceMatrix: docs.slice(0, 24).map(d => ({ point: d.subject, dcs: 'Synthetic response', rebuttal: narrative(d), evidence: 'Invented evidence', refs: d.ref, docs: [docLink(d)] })),
      infoRequired: docs.slice(0, 20).map(d => ({ item: narrative(d), owner: d.sender, status: 'Outstanding' })),
      witnesses: people.slice(0, 12).map(p => ({ name: p.name, role: p.role, willsay: 'SYNTHETIC invented testimony' })),
      buildReport: { generatedFrom: 'SYNTHETIC seeded generator', pending: [], textNone: docs.filter(d => d.text_status === 'none').map(d => ({ bundle: d.bundle, filename: d.filename, ref: d.ref })) },
      linkSample: docs.slice(0, 24).map(d => ({ bundle: d.bundle, filename: d.filename, ref: d.ref, url: d.url })),
      timeline: { events: docs.slice(0, 96).map(d => ({ date: d.date, kind: d.doc_type, note: narrative(d), ref: d.ref, title: d.subject, url: d.url })), phases: [['Synthetic phase one', 'Invented phase'], ['Synthetic phase two', 'Invented phase']], yearCounts: years, typeByYear },
      contracts: { count: contracts.length, groups: [{ key: 'Synthetic agreements', items: contracts.map(register) }] },
      filings: { count: filings.length, groups: [{ key: 'Synthetic filings', note: 'Invented', items: filings.map(register) }], registerSeed: filings.slice(0, 24).map(d => ({ fdate: d.date, filing: d.subject, fparty: d.sender, rdate: '', ref: d.ref, response: 'Invented response', status: 'Filed' })) },
      contradictions: { byCat: { synthetic: Math.min(invoices.length, 12) }, categories: [{ key: 'synthetic', title: 'Synthetic differences', severity: 'low', explain: 'Invented only', items: invoices.slice(0, 12).map(d => ({ label: d.subject, detail: narrative(d), rates: { SYN: amount() }, spread: amount(), refs: [{ amount: d.amount, filename: d.filename, ref: d.ref, url: d.url }] })) }], checks: [{ check: 'Synthetic count', n: Math.min(invoices.length, 12), result: 'Invented' }], highCount: 0, total: Math.min(invoices.length, 12) },
      lit: {
        enforcement: docs.slice(0, 12).map(d => ({ phase: 'Synthetic phase', step: d.subject, basis: narrative(d), status: 'To do', note: 'Invented' })),
        legality: { intro: narrative(first), docs: docs.slice(0, 12).map(d => ({ date: d.date, ref: d.ref, title: d.subject, url: d.url })), factors: [{ factor: 'Synthetic factor', note: 'Invented' }], scenarios: [{ scenario: 'Synthetic scenario', prob: 'Possible', effect: 'Invented', action: 'Invented' }] },
        authorities: Array.from({ length: 12 }, () => ({ topic: word(), authority: `${name()} v ${name()} (INVENTED)`, proposition: 'Synthetic training proposition' })),
        elements: docs.slice(0, 12).map(d => ({ element: d.subject, must: 'Invented requirement', evidence: narrative(d), witness: d.sender, tab: 'chronology' })),
        crossexam_seed: docs.slice(0, 24).map(d => ({ witness: d.sender, topic: d.subject, put: narrative(d), docs: `[[${d.ref}]]` })),
        prescription: invoices.map(d => ({ no: d.invoice_no, ref: d.ref, date: d.date, prescDate: `${Number(d.date.slice(0, 4)) + 3}${d.date.slice(4)}`.replace('-02-29', '-02-28'), risk: 'Low', url: d.url })),
        prescSummary: { awardDate: first.date, note: 'SYNTHETIC only', reliesOnInterruption: 0, total: invoices.length },
        interestBasis: { award_date: first.date, first_invoice_date: invoices[0]?.date ?? first.date, headline_date: first.date, headline_due: totalAmount, note: 'Synthetic basis' },
        recon: invoices.slice(0, 24).map(d => ({ month: d.date.slice(0, 7), invoice: [d.ref], statement: [statements[0]?.ref ?? first.ref], supporting: [], charging: [], amountdue: [], pod: [] })),
        settlement: { claim: totalAmount, claimDate: first.date },
      },
      bundles: {
        source: 'synthetic', indexSource: 'synthetic', folder: './SYNTHETIC-BUNDLES/', extracts: './SYNTHETIC-BUNDLES/', caselinesSrc: './SYNTHETIC-BUNDLES/bundle.pdf',
        count: 1, catCount: bundleRows.length, totalDocs: bundleRows.length, totalItems: bundleRows.length, totalPages,
        headerDefaults: { caseNo: 'SYNTHETIC-ONLY', claimant: name(), claimantRole: 'Synthetic claimant', court: 'Invented training court', defendant: name(), defendantRole: 'Synthetic respondent', intro: 'Synthetic index', judge: 'Synthetic role' },
        caselinesSections: { '001': { from: 1, to: totalPages, title: 'Synthetic section' } }, catalogue,
        list: [{ no: '1', name: 'Synthetic bundle', slug: 'synthetic-bundle', title: 'SYNTHETIC ONLY', note: 'Invented', file: './SYNTHETIC-BUNDLES/bundle.pdf', indexFile: './SYNTHETIC-BUNDLES/index.pdf', planFile: '', pages: totalPages, bundlePages: totalPages, filePages: totalPages, indexPages: 2, nDocs: bundleRows.length, nItems: bundleRows.length, nMissing: 0, nNeedsExtent: 0, nReview: 0, items: Object.keys(catalogue), rows: bundleRows }],
      },
    };
    roots.META = { builtAt, docCount: docs.length, dataFolderName: 'SYNTHETIC ONLY', bundles, emails: types.email ?? 0, invoices: invoices.length, people: people.length, textNone: imageCount, textPending: 0, dateSpan: [...docs.map(d => d.date)].sort().filter((_, i) => i === 0 || i === docs.length - 1), docTypes: types };
    roots.SCHED = { discovery: schedule(docs.slice(0, 96)), supplementary: schedule(docs.slice(96, 120)) };
    roots.CASELINES = { file: 'SYNTHETIC-BUNDLES/bundle.pdf', pages: totalPages, index: Array.from({ length: totalPages }, (_, i): [number, string] => [i + 1, `SYNTHETIC page ${i + 1}: ${word()} ${word()} invented text`]) };
  } });
  const present = [...result.files.keys()].filter(p => p.startsWith('datasets/')).map(p => p.slice(9, -5)).sort();
  const summary = {
    synthetic: true, seed, profile, documents: docs.length, viewsInPinnedRegistry: VIEWS.length,
    registeredDatasets: KNOWN_KEYS.size, datasetKeys: present,
    datasetKinds: Object.fromEntries(['generated', 'authored'].map(kind => [kind, [...KNOWN_KEYS.values()].filter(d => d.kind === kind).length])),
    resultsVersion: result.resultsVersion, packageFiles: result.files.size,
    packageBytes: [...result.files.values()].reduce((n, b) => n + b.length, 0),
    originalFiles: originalFiles.length, originalBytes: originalFiles.reduce((n, f) => n + f.size, 0),
    pdfDocuments: count - imageCount, pngDocuments: imageCount, multiPageDocuments: [...pageCounts.values()].filter(n => n > 1).length,
    packagePdfFiles: 2, originals: originalFiles,
    originalSizeBytes: sizeSummary(originalFiles.map(f => f.size)),
    documentSizeBytes: sizeSummary(originalFiles.slice(0, count).map(f => f.size)),
    datePolicy: { firstYear: 2200, lastYear: 2209, derivedLastYear: 2212, excludedYears: [1900, 2099] },
    packageHashes: [...result.files].map(([p, b]) => ({ path: p, sha256: sha256Hex(b), size: b.length })),
    conversionDiagnostics: result.diagnostics,
  };
  await writeFile(path.join(destination, 'generation.json'), canonicalBytes(summary));
  return summary;
}
