// Chip colours of the analysis views, as v5 maps them (exact, case-sensitive compares; v5 lines 2660, 2706, 2726).
// The chip's text is always the imported value; only the colour class is derived. Browser-safe.

/** Risk Matrix likelihood and impact: 'High' danger, 'Medium' warn, anything else (including 'high') ok. */
export const riskTone = (v: string) => (v === 'High' ? 'b-dang' : v === 'Medium' ? 'b-warn' : 'b-ok');

/** Info Required status: 'Outstanding' danger, 'In progress' warn, anything else info. */
export const infoTone = (v: string) => (v === 'Outstanding' ? 'b-dang' : v === 'In progress' ? 'b-warn' : 'b-info');

const SEVERITY: Record<string, readonly [string, string]> = { high: ['b-dang', 'HIGH'], medium: ['b-warn', 'MEDIUM'], info: ['b-info', 'INFO'], low: ['b-mut', 'LOW'] };

/** Contradiction category severity badge: v5's four keys; any other value shows as INFO. */
export const severityBadge = (s: string) => {
	const [cls, label] = Object.hasOwn(SEVERITY, s) ? SEVERITY[s]! : SEVERITY.info!;
	return { cls, label };
};

/** Consistency-check result: /PASS/ ok badge, /FLAG/ danger badge, otherwise plain text (null). */
export const checkTone = (result: string) => (/PASS/.test(result) ? 'b-ok' : /FLAG/.test(result) ? 'b-dang' : null);
