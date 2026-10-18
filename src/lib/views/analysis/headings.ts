// ADR 0003 (GRS-48): a heading equal to its navigation label (BA-18) is an analysis addition awaiting client approval.
// While CLEARCASE_ANALYSIS_ADDITIONS is off these views keep v5's heading; their navigation entry and document title keep the label.
export const V5_HEADINGS: Readonly<Record<string, string>> = { timeline: 'Chronology & Timeline', vdm_matrix_tab: 'Defence & Rebuttal Matrix', info_required_tab: 'Information & Documents Required' };

export const viewHeading = (v: { id: string; label: string }, additions: boolean): string => (additions ? v.label : (V5_HEADINGS[v.id] ?? v.label));
