import type { ScopeSpec } from './js-scan.ts';
import type { Entry, Omission, Param } from './view-content.ts';

export const V5_VIEW_IDS = [
  'overview', 'matter', 'timeline', 'chronology', 'quantum_tab', 'documents', 'contracts_tab', 'filings_tab', 'search', 'people',
  'entity_ledger_tab', 'hoa_diff_tab', 'invoice_ledger_tab', 'disbursements_tab', 'timesheet_tab', 'deadlines_tab', 'discovery_tab',
  'court_bundle_tab', 'caselines_tab', 'contradictions_tab', 'risk_matrix_tab', 'vdm_matrix_tab', 'info_required_tab', 'witness_tab',
  'conflict_tab', 'enforcement_tab', 'legality_tab', 'prescription_tab', 'interest_calc_tab', 'payments_tab', 'elements_tab',
  'authorities_tab', 'heads_tab', 'crossexam_tab', 'settlement_tab', 'privilege_tab', 'popia_tab', 'annotations_tab',
  'transcriptions_tab', 'rescan_tab', 'backup_tab', 'manual',
] as const;
export const SHELL_VIEW = '_shell';

const p = (name: string, expect: string): Param => ({ name, expect });
type E = Omit<Entry, 'required'> & { required?: boolean };
const R = (view: string): ScopeSpec => `render:${view}`;
const sub = (view: string, checklist: string): E => ({ view, field: 'subtitle', checklist, scope: R(view), sel: { call: 'pageHead', arg: 1 }, kind: 'text', markup: true });
const dlName = (view: string, fn: string, lines: string, field = 'exportFileName'): E =>
  ({ view, field, checklist: `S-hardcoded-case; ${lines}`, scope: `function:${fn}`, sel: { call: 'dl', arg: 0 }, kind: 'text' });

const ENTRIES: E[] = [
  { view: SHELL_VIEW, field: 'documentTitle', checklist: 'shell imported datasets; L6', scope: 'markup', sel: { html: 'title' }, kind: 'text' },
  { view: SHELL_VIEW, field: 'brandName', checklist: 'shell imported datasets; L146', scope: 'markup', sel: { html: 'div.brand > div.nm' }, kind: 'text' },
  sub('overview', 'S-overview-4; L330'),
  { view: 'overview', field: 'kpiDocumentsNote', checklist: 'S-overview-3; L322', scope: R('overview'), sel: { lit: 'table', binding: 'kpis', path: [0, 2] }, kind: 'text' },
  { view: 'overview', field: 'kpiInvoicesNote', checklist: 'L324', scope: R('overview'), sel: { lit: 'table', binding: 'kpis', path: [2, 2] }, kind: 'text' },
  dlName('chronology', 'exportChron', 'L440-442'),
  dlName('search', 'exportSearch', 'L515-516'),
  { ...sub('timeline', 'L361'), kind: 'template', params: [p('docCount', 'META.docCount.toLocaleString()')] },
  { view: 'timeline', field: 'synopsis', checklist: 'S-timeline-2; L364-368', scope: R('timeline'), sel: { html: 'div.card.narr:eq(0) > p:eq(0)' }, kind: 'template',
    params: [p('docCount', 'META.docCount.toLocaleString()'), p('original', 'B.Original'), p('supplementary', 'B.Supplementary'), p('correspondence', 'B.Correspondence'), p('dateFrom', 'esc(META.dateSpan[0])'), p('dateTo', 'esc(META.dateSpan[1])')] },
  { view: 'timeline', field: 'narrative', checklist: 'S-timeline-2; L369', scope: R('timeline'), sel: { html: 'div.card.narr:eq(0) > p:eq(1)' }, kind: 'text' },
  { view: 'timeline', field: 'amountDueNote', checklist: 'L371-372', scope: R('timeline'), sel: { html: 'div.card.narr:eq(0) > div' }, kind: 'template',
    params: [p('amountDue', 'esc(money(Q.headline_due))'), p('asAt', 'esc(Q.headline_date)'), p('sourceRef', 'esc(Q.headline_ref)'), p('invoiceCount', 'Q.invoiceCount'), p('sourceLink', "docLink(Q.headline_url,'source')")] },
  { view: 'timeline', field: 'emptyPhaseNote', checklist: 'L387', scope: R('timeline'), sel: { html: 'div.ev > span.ex' }, kind: 'text' },
  { view: 'timeline', field: 'quantumTrajectory', checklist: 'L392', scope: R('timeline'), sel: { html: 'div.card:eq(3) > p:eq(0)' }, kind: 'template',
    params: [p('amountDue', 'esc(money(Q.headline_due))'), p('asAt', 'esc(Q.headline_date)')] },
  { view: 'timeline', field: 'correspondentsIntro', checklist: 'S-timeline-2; L395', scope: R('timeline'), sel: { html: 'div.card:eq(4) > p:eq(0)' }, kind: 'text' },
  { view: 'timeline', field: 'evidenceNotes', checklist: 'S-timeline-2; L400', scope: R('timeline'), sel: { html: 'div.card.narr:eq(1) > p:eq(0)' }, kind: 'template', params: [p('textNone', 'META.textNone')] },
  sub('quantum_tab', 'L542'),
  { view: 'quantum_tab', field: 'kpiLatestNote', checklist: 'L545', scope: R('quantum_tab'), sel: { lit: 'table', nth: 0, path: [1, 2] }, kind: 'text' },
  { view: 'quantum_tab', field: 'kpiInvoicesNote', checklist: 'L546', scope: R('quantum_tab'), sel: { lit: 'table', nth: 0, path: [2, 2] }, kind: 'text' },
  { ...sub('invoice_ledger_tab', 'L577'), kind: 'template', params: [p('count', 'L.length')] },
  dlName('quantum_tab', 'exportInvoices', 'L574-575'),
  dlName('invoice_ledger_tab', 'exportInvoices', 'L574-575'),
  { view: 'deadlines_tab', field: 'icsProductId', checklist: 'L653', scope: 'function:exportICS', sel: { pattern: '^BEGIN:VCALENDAR\\r\\nVERSION:2\\.0\\r\\nPRODID:-//([^\\r\\n]+?)//' }, kind: 'text' },
  dlName('deadlines_tab', 'exportICS', 'L653-655'),
  sub('contracts_tab', 'contracts notes; L2590'),
  { view: 'contracts_tab', field: 'kpiSpineValue', checklist: 'S-contracts_tab-2; L2594', scope: R('contracts_tab'), sel: { html: 'div.kpi:eq(1) > div.v' }, kind: 'text' },
  { view: 'contracts_tab', field: 'kpiSpineNote', checklist: 'S-contracts_tab-2; L2594', scope: R('contracts_tab'), sel: { html: 'div.kpi:eq(1) > div.s' }, kind: 'text' },
  { view: 'contracts_tab', field: 'kpiWatchValue', checklist: 'S-contracts_tab-2; L2595', scope: R('contracts_tab'), sel: { html: 'div.kpi:eq(2) > div.v' }, kind: 'text' },
  { view: 'contracts_tab', field: 'kpiWatchNote', checklist: 'S-contracts_tab-2; L2595', scope: R('contracts_tab'), sel: { html: 'div.kpi:eq(2) > div.s' }, kind: 'text' },
  { view: 'contracts_tab', field: 'counselNote', checklist: 'S-contracts_tab-2; L2602', scope: R('contracts_tab'), sel: { html: 'div.card.narr > p' }, kind: 'text' },
  dlName('contracts_tab', 'exportContracts', 'L2605-2607'),
  sub('filings_tab', 'L2612'),
  { view: 'filings_tab', field: 'orientation', checklist: 'S-filings_tab-3; L2614', scope: R('filings_tab'), sel: { html: 'div.card.narr > p' }, kind: 'text' },
  dlName('filings_tab', 'exportFilings', 'L2653-2655'),
  dlName('filings_tab', 'exportRegister', 'L2656-2657', 'registerExportFileName'),
  { view: 'filings_tab', field: 'registerIntro', checklist: 'S-hardcoded-case; L2626', scope: R('filings_tab'), sel: { pattern: '^<p\\b[^>]*>(.+?[.!?])\\s+[^.!?<>]*\\([A-Za-z_][A-Za-z0-9_]*\\)\\.</p>$' }, kind: 'text', markup: true },
  ...([['court', 'court'], ['division', 'div'], ['caseNumber', 'cnum'], ['plaintiff', 'plaintiff'], ['plaintiffCitation', 'plaintiffCite'], ['plaintiffRole', 'plaintiffRole'],
    ['defendant', 'defendant'], ['defendantCitation', 'defendantCite'], ['defendantRole', 'defendantRole']] as const).map(([field, prop]): E =>
    ({ view: 'discovery_tab', field, checklist: 'S-discovery_tab-3; L3194-3204', scope: 'const:CAP', sel: { lit: 'object', path: [prop] }, kind: 'text' })),
  ...(['discovery', 'supplementary'] as const).flatMap((mode, nth) => (['deed', 'sched', 'range', 'file'] as const).map((prop): E =>
    ({ view: 'discovery_tab', field: `${mode}${prop === 'sched' ? 'Schedule' : prop[0]!.toUpperCase() + prop.slice(1)}`, checklist: 'S-discovery_tab-3, S-discovery_tab-9; L3207-3210', scope: 'function:meta', sel: { lit: 'object', nth, path: [prop] }, kind: 'text' }))),
  { view: 'discovery_tab', field: 'discoveryModeLabel', checklist: 'S-discovery_tab-3; L3229', scope: R('discovery_tab'), sel: { html: 'div.ds-switch > button[data-mode="discovery"]' }, kind: 'text' },
  { view: 'discovery_tab', field: 'supplementaryModeLabel', checklist: 'S-discovery_tab-3; L3230', scope: R('discovery_tab'), sel: { html: 'div.ds-switch > button[data-mode="supplementary"]' }, kind: 'text' },
  { view: 'discovery_tab', field: 'bundleIndexName', checklist: 'S-discovery_tab-3; L771, L3416', scope: 'function:bundleFile', sel: { ret: 0 }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'kpiBundlesNote', checklist: 'S-court_bundle_tab-11; L1959', scope: 'function:cbListView', sel: { call: 'cbKpi', nth: 0, arg: 2 }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'kpiExtractsValue', checklist: 'S-court_bundle_tab-11; L882, L1962', scope: 'function:cbListView', sel: { call: 'cbKpi', nth: 3, arg: 1 }, kind: 'number' },
  { view: 'court_bundle_tab', field: 'kpiExtractsNote', checklist: 'S-court_bundle_tab-11; L1962', scope: 'function:cbListView', sel: { call: 'cbKpi', nth: 3, arg: 2 }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'extentNarrative', checklist: 'S-court_bundle_tab-11; L1983', scope: 'function:cbListView', sel: { html: 'div.card div.narr > p:eq(0)' }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'compositionSourceDefault', checklist: 'S-court_bundle_tab-11; L808, L1986', scope: 'function:cbListView', sel: { orDefault: 'CBB.source' }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'indexSourceDefault', checklist: 'S-court_bundle_tab-11; L808, L1986', scope: 'function:cbListView', sel: { orDefault: 'CBB.indexSource' }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'headerCourtExample', checklist: 'S-court_bundle_tab-11; L1862', scope: 'const:CBHF', sel: { lit: 'array', path: [0, 2] }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'headerDivisionExample', checklist: 'S-court_bundle_tab-11; L1863', scope: 'const:CBHF', sel: { lit: 'array', path: [1, 2] }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'headerCaseNumberExample', checklist: 'S-court_bundle_tab-11; L1865', scope: 'const:CBHF', sel: { lit: 'array', path: [3, 2] }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'docxCreator', checklist: 'S-court_bundle_tab-11; L902, L2550', scope: 'function:cbDocx', sel: { pattern: '<dc:creator>([^<]+)</dc:creator>' }, kind: 'text' },
  { view: 'court_bundle_tab', field: 'allIndexesFileName', checklist: 'S-court_bundle_tab-11; L873, L2573', scope: 'function:cbIndexAllDocx', sel: { call: 'cbDocx', arg: 1 }, kind: 'text' },
  sub('caselines_tab', 'L3525'),
  { view: 'caselines_tab', field: 'bundleName', checklist: 'S-caselines_tab-2; L939, L3514', scope: 'const:BUNDLE', sel: { lit: 'object', path: ['name'] }, kind: 'text' },
  { view: 'caselines_tab', field: 'url', checklist: 'S-caselines_tab-2; L968, L3515', scope: 'const:BUNDLE', sel: { lit: 'object', path: ['url'] }, kind: 'text' },
  { view: 'caselines_tab', field: 'pageCountFallback', checklist: 'S-caselines_tab-2; L939, L3516', scope: 'const:BUNDLE', sel: { lit: 'object', path: ['pages'] }, kind: 'number', fallback: true },
  { view: 'caselines_tab', field: 'heroNote', checklist: 'S-caselines_tab-2; L3530', scope: R('caselines_tab'), sel: { html: 'div.cl-hero div.m' }, kind: 'template', params: [p('pages', 'BUNDLE.pages.toLocaleString()')] },
  { view: 'contradictions_tab', field: 'methodNote', checklist: 'S-contradictions_tab-3; L2693', scope: R('contradictions_tab'), sel: { html: 'div.card.narr > p' }, kind: 'template', params: [p('docCount', 'META.docCount.toLocaleString()')] },
  dlName('contradictions_tab', 'exportContradictions', 'L2696-2698'),
  sub('vdm_matrix_tab', 'S-vdm_matrix_tab-2; L2711'),
  { view: 'vdm_matrix_tab', field: 'columns', checklist: 'S-vdm_matrix_tab-2; L1053, L2713', scope: R('vdm_matrix_tab'), sel: { html: 'table.tbl th', all: true }, kind: 'list' },
  dlName('vdm_matrix_tab', 'exportDefence', 'L2719-2721'),
  { view: 'vdm_matrix_tab', field: 'exportColumns', checklist: 'S-hardcoded-case; L2719', scope: 'function:exportDefence', sel: { lit: 'array', binding: 'head', path: [] }, kind: 'list' },
  { view: 'conflict_tab', field: 'queryPlaceholder', checklist: 'S-conflict_tab-1; L2744', scope: R('conflict_tab'), sel: { html: 'input#confq', attr: 'placeholder' }, kind: 'text' },
  sub('enforcement_tab', 'S-enforcement_tab-3; L2874'),
  { view: 'enforcement_tab', field: 'whyNarrative', checklist: 'S-enforcement_tab-3; L2875', scope: R('enforcement_tab'), sel: { html: 'div.card.narr > p' }, kind: 'text' },
  sub('legality_tab', 'S-legality_tab-1; L2893'),
  { view: 'legality_tab', field: 'docsHeading', checklist: 'S-hardcoded-case; L2895', scope: R('legality_tab'), sel: { html: 'div.card.pad0 > div.chead' }, kind: 'template', params: [p('count', 'L.docs.length')] },
  { view: 'legality_tab', field: 'scenarioActionHeading', checklist: 'S-hardcoded-case; L2898', scope: R('legality_tab'), sel: { html: 'div.card:eq(2) th:eq(3)' }, kind: 'text' },
  dlName('prescription_tab', 'exportPresc', 'L2929'),
  { view: 'interest_calc_tab', field: 'defaultRate', checklist: 'S-interest_calc_tab-2; L1229, L2938', scope: R('interest_calc_tab'), sel: { html: 'input#ic_r', attr: 'value' }, kind: 'number' },
  sub('payments_tab', 'S-payments_tab-5; L2965'),
  dlName('payments_tab', 'ledgerCSVp', 'L2990'),
  sub('elements_tab', 'L1308, L2994'),
  { view: 'elements_tab', field: 'columns', checklist: 'L1308, L2995', scope: R('elements_tab'), sel: { html: 'table.tbl th', all: true }, kind: 'list' },
  dlName('authorities_tab', 'exportAuth', 'L3014'),
  dlName('heads_tab', 'exportHeads', 'L3036'),
  { view: 'heads_tab', field: 'exportCaption', checklist: 'S-heads_tab-1; L1360, L3036', scope: 'function:exportHeads', sel: { pattern: '^[A-Z ]+ — (.+)\\n\\n$' }, kind: 'text' },
  sub('settlement_tab', 'L3062'),
  { view: 'settlement_tab', field: 'narrative', checklist: 'S-settlement_tab-5; L3063', scope: R('settlement_tab'), sel: { html: 'div.card.narr > p' }, kind: 'text' },
  ...([['defaultProbability', 'se_p', 'L1415, L3066'], ['defaultYears', 'se_y', 'L1416, L3067'], ['defaultDiscountRate', 'se_d', 'L1417, L3068'], ['defaultEnforcementCost', 'se_c', 'L1418, L3069']] as const).map(([field, id, lines]): E =>
    ({ view: 'settlement_tab', field, checklist: `S-settlement_tab-1; ${lines}`, scope: R('settlement_tab'), sel: { html: `input#${id}`, attr: 'value' }, kind: 'number' })),
  { view: 'crossexam_tab', field: 'tip', checklist: 'L3049 (found by the unmapped-prose audit)', scope: R('crossexam_tab'), sel: { html: 'p.tag' }, kind: 'text' },
  dlName('rescan_tab', 'rescanWriteIndex', 'L2824-2826'),
  dlName('backup_tab', 'backupExport', 'L2838'),
  { view: 'rescan_tab', field: 'invoicePrefix', checklist: 'S-rescan_tab-7; L1578, L2810', scope: 'function:rescanNow', sel: { pattern: '^/([A-Za-z]+)\\\\d\\{4,6\\}/i$', on: 're' }, kind: 'text' },
  { view: 'manual', field: 'linkSampleNote', checklist: 'S-manual-1; L2863', scope: 'function:verifyLinks', sel: { html: 'p.tag' }, kind: 'text' },
];

export const VIEW_CONTENT_MAP: readonly Entry[] = ENTRIES.map((e) => ({ ...e, required: e.required ?? true }));

export const VIEW_CONTENT_OMISSIONS: readonly Omission[] = [
  { view: SHELL_VIEW, field: 'brandSubtitle', checklist: 'L146', reason: 'product chrome (workspace label), not case content' },
  { view: 'overview', field: 'kpiAmountNote', checklist: 'L323', reason: 'built from DATA.quantum (headline ref and date); only the separator is code' },
  { view: 'timeline', field: 'workingCopyNote', checklist: 'L401', reason: 'generic disclaimer, not case content' },
  { view: 'court_bundle_tab', field: 'headerPlaceholders', checklist: 'L808 CBPH, L1856-1858', reason: 'generic form placeholders, not case content' },
  { view: 'court_bundle_tab', field: 'headerIntroExample', checklist: 'L1864', reason: 'generic form wording, not case content' },
  { view: 'court_bundle_tab', field: 'indexFileName', checklist: 'L873, L2571', reason: 'built from DATA.bundles (bundle number and name)' },
  { view: 'discovery_tab', field: 'printCaption', checklist: 'L771, L3434-3435', reason: 'composed from the CAP fields already extracted' },
  { view: 'interest_calc_tab', field: 'rateCaution', checklist: 'S-interest_calc_tab-2; L2958', reason: 'generic method caution, not case content' },
  { view: 'rescan_tab', field: 'bundleKeywords', checklist: 'L1575', reason: 'v5 folder-name convention used for bundle detection; app behaviour, not displayed content' },
];

export const VIEW_CONTENT_AUDIT: readonly ScopeSpec[] = [...new Set<ScopeSpec>([...V5_VIEW_IDS.map(R), ...VIEW_CONTENT_MAP.map((e) => e.scope).filter((s) => s !== 'markup')])];
