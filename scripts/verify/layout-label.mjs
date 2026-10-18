// The label check and server env of scripts/verify/layout.mjs, as 9ad17e0 had them (heading must equal the label; no flag).
export const analysisAdditionsFrom = () => false;
export const labelCheck = (v, id) => ({ ok: id.heading === v.label && id.title.startsWith(v.label) && (id.nav ?? '').startsWith(v.label), expected: v.label });
export const serverEnv = () => ({ CLEARCASE_FIXED_NOW: '2026-10-08T09:00:00Z', TZ: 'UTC' });
