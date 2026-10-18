// ADR 0003: an explicit preview opt-in is not client approval and never changes the default.
export const analysisAdditionsEnabled = () => process.env.CLEARCASE_ANALYSIS_ADDITIONS === '1';

// These headings already ship in db73856; retain that contract in both flag states.
const HEADINGS = {
 timeline: 'Timeline',
 vdm_matrix_tab: 'Defence & Rebuttal',
 info_required_tab: 'Info Required',
} as const;

export const analysisHeading = (view: keyof typeof HEADINGS) => HEADINGS[view];
