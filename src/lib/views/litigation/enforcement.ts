
export const ENF_OPTS = Object.freeze(['To do', 'In progress', 'Done', 'Contingent', 'Monitor']);

export interface EnfStep { phase: string; step: string; basis: string; status: string; note: string }
export interface EnfRow extends EnfStep {
	key: string | null;
	override: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
export const stepOf = (o: unknown): EnfStep => {
	const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
	return { phase: str(r.phase), step: str(r.step), basis: str(r.basis), status: str(r.status), note: str(r.note) };
};

export const phasesOf = (steps: readonly { phase: string }[]) => [...new Set(steps.map((s) => s.phase))];

export interface StatusOption { value: string; label: string }

export function statusOptions(imported: string, saved: string | null = null): StatusOption[] {
	const out = ENF_OPTS.map((v) => ({ value: v, label: v }));
	if (!ENF_OPTS.includes(imported)) out.push({ value: imported, label: imported });
	if (saved !== null && !out.some((o) => o.value === saved)) out.push({ value: saved, label: `${saved} (no longer offered)` });
	return out;
}

export const allowedStatus = (r: Pick<EnfRow, 'status' | 'override'>, status: string) => statusOptions(r.status, r.override).some((o) => o.value === status);

export function enforcementRows(raw: readonly unknown[], keyOf: (s: { phase: string; step: string }) => string, overrides: ReadonlyMap<string, string>): EnfRow[] {
	const steps = raw.map(stepOf);
	const keys = steps.map((s) => keyOf({ phase: s.phase, step: s.step }));
	const count = new Map<string, number>();
	for (const k of keys) count.set(k, (count.get(k) ?? 0) + 1);
	return steps.map((s, i) => {
		const k = count.get(keys[i]!) === 1 ? keys[i]! : null;
		return { ...s, key: k, override: k ? overrides.get(k) ?? null : null };
	});
}

export const shownStatus = (r: Pick<EnfRow, 'status' | 'override'>) => r.override ?? r.status;

export function mapV5EnfStatus(rows: readonly Pick<EnfRow, 'key'>[], stored: Readonly<Record<string, unknown>>): { stepKey: string; status: string }[] {
	const out: { stepKey: string; status: string }[] = [];
	for (const [i, status] of Object.entries(stored)) {
		if (!/^(0|[1-9]\d*)$/.test(i) || typeof status !== 'string' || !status) continue;
		const key = rows[Number(i)]?.key;
		if (key) out.push({ stepKey: key, status });
	}
	return out;
}
