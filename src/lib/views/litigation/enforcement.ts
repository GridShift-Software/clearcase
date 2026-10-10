// Enforcement Roadmap (enforcement_tab). The imported steps (`lit-enforcement`) are shown by phase in first-appearance
// order, as v5 does. A user's status is an override in register store `enforcement-status`, keyed by `stepKey`, a
// digest of the step's canonical {phase, step} (S-enforcement_tab-1, S-index-keys: never the array index); the
// imported status stays unchanged underneath. Browser-safe.

/** v5's ENF_OPTS: viewer code, so a literal (docs/results-package.md). */
export const ENF_OPTS = Object.freeze(['To do', 'In progress', 'Done', 'Contingent', 'Monitor']);

export interface EnfStep { phase: string; step: string; basis: string; status: string; note: string }
export interface EnfRow extends EnfStep {
	/** the stable key; null when another step has the same {phase, step} (disclosed, and no status can be saved) */
	key: string | null;
	/** the user's status over the imported one, or null */
	override: string | null;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
export const stepOf = (o: unknown): EnfStep => {
	const r = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
	return { phase: str(r.phase), step: str(r.step), basis: str(r.basis), status: str(r.status), note: str(r.note) };
};

/** Phases in first-appearance order (v5: [...new Set(steps.map(s => s.phase))]). */
export const phasesOf = (steps: readonly { phase: string }[]) => [...new Set(steps.map((s) => s.phase))];

/**
 * The options of a step's select: ENF_OPTS, and the current value as its own option when it is outside them
 * (S-enforcement_tab-2, corrected: v5 left no option selected, so the browser showed "To do").
 */
export const statusOptions = (current: string): string[] => (ENF_OPTS.includes(current) ? [...ENF_OPTS] : [...ENF_OPTS, current]);

/** Rows with their keys and overrides; `keyOf` digests a step's canonical {phase, step}. */
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

/** The status a step shows: the user's override, else the imported status. */
export const shownStatus = (r: Pick<EnfRow, 'status' | 'override'>) => r.override ?? r.status;

/**
 * How v5's `ess_dcs_enf_status_v1` ({"<array index>": status}) would map onto overrides, for a later import (none in
 * V1): index i names step i of DATA.lit.enforcement only in the same results version, so the caller passes that
 * version's rows. An index outside the steps, or a step without a unique key, maps to nothing.
 */
export function mapV5EnfStatus(rows: readonly Pick<EnfRow, 'key'>[], stored: Readonly<Record<string, unknown>>): { stepKey: string; status: string }[] {
	const out: { stepKey: string; status: string }[] = [];
	for (const [i, status] of Object.entries(stored)) {
		if (!/^(0|[1-9]\d*)$/.test(i) || typeof status !== 'string' || !status) continue;
		const key = rows[Number(i)]?.key;
		if (key) out.push({ stepKey: key, status });
	}
	return out;
}
