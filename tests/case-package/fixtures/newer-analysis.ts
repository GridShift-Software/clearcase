// GRS-149: a synthetic newer (V1) workspace whose mod_00_analysis.js module carries the 19 analysis roots in the newer
// viewer's own shapes, with the builder's merge line, and DATA's analysis slots left empty as the builder writes them.
// Every value is invented.
import type { SynthRoots } from './synth.ts';

type J = Record<string, any>;
const url = (p: string) => './' + p.split('/').map(encodeURIComponent).join('/');
export const AGREEMENT = 'DISCOVERY A/OD-001 Supply agreement.pdf';

export const MODULE = '/* ===== module mod_00_analysis.js ===== */';
export const literal = (x: unknown) => `(function(){ const X = ${JSON.stringify(x)};`;
/** The V1 builder's merge line, statement for statement as it writes it after the literal. */
export const V1_MERGE_LINE = 'Object.assign(DATA.matter, X.matter); Object.assign(DATA.timeline, {phases: X.timeline.phases, events: X.timeline.events}); DATA.riskMatrix.push.apply(DATA.riskMatrix, X.riskMatrix); Object.assign(DATA.lit.legality, X.legality); DATA.defenceMatrix.push.apply(DATA.defenceMatrix, X.defenceMatrix); DATA.lit.elements.push.apply(DATA.lit.elements, X.elements); DATA.lit.recon.push.apply(DATA.lit.recon, X.recon); Object.assign(DATA.lit.settlement, X.settlement); DATA.lit.enforcement.push.apply(DATA.lit.enforcement, X.enforcement); Object.assign(DATA.organogram, X.organogram); DATA.witnesses.push.apply(DATA.witnesses, X.witnesses); DATA.anchors.push.apply(DATA.anchors, X.anchors); Object.assign(DATA.contradictions, X.contradictions); DATA.lit.authorities.push.apply(DATA.lit.authorities, X.authorities); DATA.lit.crossexam_seed.push.apply(DATA.lit.crossexam_seed, X.crossexam_seed); DATA.infoRequired.push.apply(DATA.infoRequired, X.infoRequired); DATA.lit.prescription.push.apply(DATA.lit.prescription, X.prescription); Object.assign(DATA.lit.prescSummary, X.prescSummary); Object.assign(DATA.lit.interestBasis, X.interestBasis); })();';

/** The 19 analysis roots in the newer viewer's shapes. */
export const X: J = {
  matter: { title: 'Invented matter', short: 'IM', forum: 'Invented forum', summary: 'Invented summary', status: 'Open', storyline: [['Start', 'The agreement OD-001 began it.'], ['Then', 'Invoice OD-002 followed.']], strategy: [['Plan', 'Rely on SD-001.']] },
  timeline: {
    phases: [{ key: 'one', title: 'Phase one', from: '2001-02-03', to: '2001-02-28', summary: 'First', oneLine: 'First' }, { key: 'two', title: 'Phase two', from: '2001-02-28', to: '2002-01-01', summary: 'Second', oneLine: 'Second' }],
    events: [
      { date: '2001-02-03', title: 'Agreement signed', detail: 'Invented detail', phase: 'one', type: 'contract', refs: ['OD-001'] },
      { date: '2001-02-28', title: 'Invoice issued', detail: 'Invented', phase: 'two', type: 'invoice', refs: ['OD-002', 'SD-001'] },
      { date: '2001-03-04', title: 'No document', detail: 'Invented', phase: 'two', type: 'note', refs: [] },
    ],
  },
  riskMatrix: [
    { issue: 'Invented risk', category: 'Legal', likelihood: 'Low', impact: 'High', mitigation: 'Invented', owner: 'Counsel', refs: ['OD-001'] },
    { issue: 'Second risk', category: 'Quantum', likelihood: 'High', impact: 'Medium', mitigation: 'Invented', owner: 'Attorney', refs: ['OD-002', 'SD-001'] },
  ],
  legality: { intro: 'Invented intro', docs: [{ ref: 'OD-001', date: '2001-02-03', title: 'Agreement', url: url(AGREEMENT) }], scenarios: [{ scenario: 'S', effect: 'E', prob: 'Possible', action: 'A' }], factors: [{ factor: 'F', note: 'N' }] },
  defenceMatrix: [{ point: 'Point', theirs: 'Their contention', evidence: 'Evidence', docs: ['OD-001', 'OD-002'], rebuttal: 'Rebuttal' }],
  elements: [{ element: 'E', must: 'M', evidence: 'Ev', refs: ['OD-001'], witness: 'W', gap: 'G', goto: 'chronology' }],
  recon: [{ period: '2001-02', invoice: ['OD-002'], supporting: [], charging: [], breakdown: ['OD-002'], pod: [], statement: ['SD-001'], due: ['OD-002'] }],
  settlement: { claim: '1150.00', capital: '1000.00', probability: 0.5, years: 2, discount: 0.1, cost: 100, note: 'Invented', batna: 'Invented' },
  enforcement: [{ phase: '1', step: 'S', basis: 'B', status: 'To do', note: '' }],
  organogram: { nodes: [{ id: 'a', label: 'Org A', kind: 'company', side: 'ours', role: 'Claimant', refs: ['OD-001'] }], edges: [] },
  witnesses: [{ name: 'Ann Lee', side: 'ours', role: 'Supply', willsay: 'Invented will-say', proves: 'Delivery', docs: ['OD-001'], status: 'To consult' }],
  anchors: [{ ref: 'OD-001', issue: 'I', rank: 1, why: 'W', page: 1, quote: 'Invented', title: 'Agreement', date: '2001-02-03' }],
  contradictions: { categories: [{ key: 'rates', title: 'Rates', severity: 'high', explain: 'Invented', items: [{ label: 'L', detail: 'D', refs: ['OD-002'], values: { a: '1.00' } }] }], total: 1, byCat: { rates: 1 }, checks: [{ check: 'C', result: 'ok' }], highCount: 1 },
  authorities: [{ topic: 'T', authority: 'Invented v Invented', proposition: 'P' }],
  crossexam_seed: [{ witness: 'Ann Lee', topic: 'Payment', put: 'Invented put', docs: ['OD-002', 'SD-001'] }],
  infoRequired: [{ id: 'I1', item: 'Item', why: 'Why', status: 'Open', owner: 'Ann', refs: ['OD-001'], from: 'Counsel' }],
  prescription: [{ ref: 'OD-002', no: 'INV01001', date: '2001-02-28', due: '2001-03-04', prescDate: '2004-02-28', amount: '1150.00', risk: 'Low', url: url('DISCOVERY A/OD-002 Invoice 1001.pdf') }],
  prescSummary: { total: 1, reliesOnInterruption: 0, awardDate: '2002-01-01', keyEvent: 'Invented', note: 'Invented' },
  interestBasis: { rate: 10.5, rateNote: 'Invented', method: 'simple', to: '2002-01-01', headline_due: '1150.00', capital: '1000.00', note: 'Invented', refs: ['OD-002'], from: '2001-03-04' },
};

/** The analysis slots as the V1 builder leaves them in DATA: empty, filled only by the module at run time. */
export function emptyAnalysisSlots(r: SynthRoots): void {
  r.META.version = 'V1';
  const D = r.DATA;
  D.profile = { matter_full: 'Profile title', short: 'PT', claim_type: 'A claim.' };
  D.matter = {};
  D.timeline = { events: [], phases: [], yearCounts: {}, typeByYear: {} };
  for (const k of ['riskMatrix', 'defenceMatrix', 'witnesses', 'infoRequired', 'anchors']) D[k] = [];
  D.organogram = { nodes: [], edges: [] };
  D.contradictions = { categories: [], total: 0, byCat: {}, checks: [], highCount: 0 };
  D.lit = {
    legality: { intro: '', docs: [], scenarios: [], factors: [] }, elements: [], recon: [], settlement: {}, enforcement: [], authorities: [], crossexam_seed: [],
    prescription: [], prescSummary: {}, interestBasis: { rate: '', method: '', from: '', source: 'builder' },
  };
}
