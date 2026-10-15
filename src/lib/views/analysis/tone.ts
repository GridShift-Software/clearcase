
export const riskTone = (v: string) => (v === 'High' ? 'b-dang' : v === 'Medium' ? 'b-warn' : 'b-ok');

export const infoTone = (v: string) => (v === 'Outstanding' ? 'b-dang' : v === 'In progress' ? 'b-warn' : 'b-info');

const SEVERITY: Record<string, readonly [string, string]> = { high: ['b-dang', 'HIGH'], medium: ['b-warn', 'MEDIUM'], info: ['b-info', 'INFO'], low: ['b-mut', 'LOW'] };

export const severityBadge = (s: string) => {
	const [cls, label] = Object.hasOwn(SEVERITY, s) ? SEVERITY[s]! : SEVERITY.info!;
	return { cls, label };
};

export const checkTone = (result: string) => (/PASS/.test(result) ? 'b-ok' : /FLAG/.test(result) ? 'b-dang' : null);
