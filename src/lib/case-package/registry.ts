// Dataset registry: which dataset keys and schemas exist, where each comes from in the v5
// workspace HTML, and whether it is generated (reproducible from the originals by the
// pipeline) or authored (analysis written by people). The split follows the provenance
// in the raw-review field inventory: `machine_built` vs the hand-authored overlay that
// the v5 app merges into DATA at runtime. Only authored datasets carry inline citation
// tokens and later Markdown editing.
import type { TSchema } from 'typebox';
import * as R from './records.ts';

export type DatasetKind = 'generated' | 'authored';
export interface DatasetDef { key: string; sourcePath: string; kind: DatasetKind; schema: string; data: TSchema; required: boolean }

const g = (key: string, sourcePath: string, data: TSchema): DatasetDef => ({ key, sourcePath, kind: 'generated', schema: `v5.${key}@1`, data, required: true });
const a = (key: string, sourcePath: string, data: TSchema): DatasetDef => ({ key, sourcePath, kind: 'authored', schema: `v5.${key}@1`, data, required: true });

export const V5_DATASETS: readonly DatasetDef[] = [
  g('chronology', 'DATA.chronology', R.V5Chronology),
  g('people', 'DATA.people', R.V5People),
  g('entities', 'DATA.entities', R.V5Entities),
  a('matter', 'DATA.matter', R.V5Matter),
  g('quantum', 'DATA.quantum', R.V5Quantum),
  a('risk-matrix', 'DATA.riskMatrix', R.V5RiskMatrix),
  a('defence-matrix', 'DATA.defenceMatrix', R.V5DefenceMatrix),
  a('info-required', 'DATA.infoRequired', R.V5InfoRequired),
  a('witnesses', 'DATA.witnesses', R.V5Witnesses),
  g('build-report', 'DATA.buildReport', R.V5BuildReport),
  g('link-sample', 'DATA.linkSample', R.V5LinkSample),
  a('timeline-events', 'DATA.timeline.events', R.V5TimelineEvents),
  a('timeline-phases', 'DATA.timeline.phases', R.V5TimelinePhases),
  g('timeline-year-counts', 'DATA.timeline.yearCounts', R.V5TimelineYearCounts),
  g('timeline-type-by-year', 'DATA.timeline.typeByYear', R.V5TimelineTypeByYear),
  g('contracts', 'DATA.contracts', R.V5Contracts),
  g('filings', 'DATA.filings', R.V5Filings),
  a('contradictions', 'DATA.contradictions', R.V5Contradictions),
  a('lit-enforcement', 'DATA.lit.enforcement', R.V5LitEnforcement),
  a('lit-legality', 'DATA.lit.legality', R.V5LitLegality),
  a('lit-authorities', 'DATA.lit.authorities', R.V5LitAuthorities),
  a('lit-elements', 'DATA.lit.elements', R.V5LitElements),
  a('lit-crossexam-seed', 'DATA.lit.crossexam_seed', R.V5LitCrossexamSeed),
  a('lit-prescription', 'DATA.lit.prescription', R.V5LitPrescription),
  a('lit-presc-summary', 'DATA.lit.prescSummary', R.V5LitPrescSummary),
  a('lit-interest-basis', 'DATA.lit.interestBasis', R.V5LitInterestBasis),
  a('lit-recon', 'DATA.lit.recon', R.V5LitRecon),
  a('lit-settlement', 'DATA.lit.settlement', R.V5LitSettlement),
  g('bundles', 'DATA.bundles', R.V5Bundles),
  g('meta', 'META', R.V5Meta),
  g('discovery-schedules', 'window.__SCHED__', R.V5DiscoverySchedules),
  g('caselines-index', 'window.__CASELINES_IDX__', R.V5CaselinesIndex),
];

/** Containers that the adapter splits into one dataset per child key. */
export const V5_SPLIT_PARENTS = ['DATA.timeline', 'DATA.lit'] as const;
export const LAYOUT: DatasetDef = { key: 'source-layout', sourcePath: '(layout)', kind: 'generated', schema: 'v5.source-layout@1', data: R.V5SourceLayout, required: true };
export const CONVERSION_REPORT: DatasetDef = { key: 'conversion-report', sourcePath: '(adapter)', kind: 'generated', schema: 'v5.conversion-report@1', data: R.V5ConversionReport, required: false };
/** Unknown source keys: preserved, bounded, explicitly unsupported (not rendered). */
export const OPAQUE_SCHEMA = 'opaque@1';

export const KNOWN_SCHEMAS: ReadonlyMap<string, DatasetDef> = new Map([...V5_DATASETS, LAYOUT, CONVERSION_REPORT].map((d) => [d.schema, d]));
export const REQUIRED_DATASETS = ['chronology'];

/** Dataset keys reserved for user work; they never appear in immutable results. */
export const USERWORK_KEYS = new Set([
  'annotations', 'notes', 'deadlines', 'timesheet', 'disbursements', 'privilege-log', 'popia-register', 'rescan',
  'transcripts', 'user-registers', 'backup', 'payments', 'heads', 'courtbundle', 'custom-bundles', 'bundle-header',
  'bundle-overrides', 'bundle-extents', 'info-done', 'enf-status', 'filings-register', 'crossexam', 'schedule-co',
  'schedule-sel', 'schedule-mode', 'caselines-docs',
]);
export const USERWORK_SOURCES = new Set(['user-work', 'local-storage', 'backup', 'workspace']);
/** v5 browser store key shape, e.g. ess_dcs_deadlines_v1, at any nesting depth */
export const STORE_KEY = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+_v\d+$/;

/** Fields whose string values are link locators (kept as data, never used as href). */
export const LINK_FIELDS = new Set(['url', 'href', 'link', 'headline_url', 'sliceUrl', 'file', 'indexFile', 'planFile', 'folder', 'caselinesSrc', 'extracts', 'src_url']);

/** Per-schema citation fields beyond the generic ref / headline_ref / refs[] / also_in[] rule. */
export const EXTRA_CITATION_ARRAYS: Record<string, ReadonlySet<string>> = {
  'v5.lit-recon@1': new Set(['invoice', 'statement', 'supporting', 'charging', 'pod', 'amountdue']),
};
/** Fields that hold a record's own id or another namespace, never a citation. */
export const NON_CITATION_FIELDS: Record<string, ReadonlySet<string>> = {
  'v5.chronology@1': new Set(['ref']),
};

/** Stable seed ids: natural-key fields per seed dataset (user edits are overlays keyed by these). */
export const SEED_DATASETS: Record<string, { pointer: string; keyFields: readonly string[] }> = {
  'filings': { pointer: '/registerSeed', keyFields: ['ref', 'filing'] },
  'lit-crossexam-seed': { pointer: '', keyFields: ['witness', 'topic'] },
};

/** Registered dataset keys: each must carry its registered schema and required flag. */
export const KNOWN_KEYS: ReadonlyMap<string, DatasetDef> = new Map([...V5_DATASETS, LAYOUT, CONVERSION_REPORT].map((d) => [d.key, d]));
