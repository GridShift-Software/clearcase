import type { VersionedRow } from '../../local-case/registers.server.ts';
import type { enforcementPure } from './enforcement.server.ts';


export const ENF_OPTS = Object.freeze(['To do', 'In progress', 'Done', 'Contingent', 'Monitor']);

export interface EnfStep { phase: string; step: string; basis: string; status: string; note: string }
export interface EnfRow extends EnfStep {
	/** the stable key; null when another step has the same {phase, step} (disclosed, and no status can be saved) */
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

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** The saved status rows of one step; `saveStatus` (writes.server.ts) keeps the last and removes the others. */
export const stepRows = (rows: readonly VersionedRow[], stepKey: string) => rows.filter((r) => text(r.fields.stepKey) === stepKey);

/** The version of a step's saved status, as `saveStatus` checks it: 'none' when nothing is saved. */
export const stepVersion = (rows: readonly VersionedRow[]) => (rows.length ? rows.map((r) => `${r.rowId}.${r.version}`).join(' ') : 'none');

/** The Enforcement Roadmap shard (ticket 04): the view without the saved statuses. */
export type EnforcementShard = ReturnType<typeof enforcementPure>;

/** The Enforcement Roadmap page data from its shard and the saved status rows in register order. */
export function enforcementMerge(shard: EnforcementShard, work: { rows: readonly VersionedRow[] }) {
	const keys = new Set(work.rows.map((r) => text(r.fields.stepKey)).filter(Boolean));
	const saved = new Map([...keys].map((k) => { const mine = stepRows(work.rows, k); return [k, { status: text(mine.at(-1)!.fields.status), version: stepVersion(mine) }]; }));
	const rows = shard.rows.map((r) => ({ ...r, override: r.key ? saved.get(r.key)?.status ?? null : null, version: (r.key && saved.get(r.key)?.version) || 'none' }));
	return { present: shard.present, rows, phases: shard.phases, content: shard.content, known: shard.known };
}
