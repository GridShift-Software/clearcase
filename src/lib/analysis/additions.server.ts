// ADR 0003: an explicit preview opt-in is not client approval and never changes the default.
export const analysisAdditionsEnabled = () => process.env.CLEARCASE_ANALYSIS_ADDITIONS === '1';
