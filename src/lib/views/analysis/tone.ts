
export const riskTone = (v: string) => (v === 'High' ? 'b-dang' : v === 'Medium' ? 'b-warn' : 'b-ok');

/** Imported labels keep their spelling; only the displayed tone folds case. */
export const riskDisplayTone = (v: string) => {
	const level = v.trim().toLowerCase();
	return riskTone(level === 'high' ? 'High' : level === 'medium' ? 'Medium' : v);
};

export const infoTone = (v: string) => (v === 'Outstanding' ? 'b-dang' : v === 'In progress' ? 'b-warn' : v === 'Done' ? 'b-ok' : 'b-info');

const SEVERITY: Record<string, readonly [string, string]> = { high: ['b-dang', 'HIGH'], medium: ['b-warn', 'MEDIUM'], info: ['b-info', 'INFO'], low: ['b-mut', 'LOW'] };

export const severityBadge = (s: string) => {
	const [cls, label] = Object.hasOwn(SEVERITY, s) ? SEVERITY[s]! : SEVERITY.info!;
	return { cls, label };
};

export const checkTone = (result: string) => (/PASS/.test(result) ? 'b-ok' : /FLAG/.test(result) ? 'b-dang' : null);
