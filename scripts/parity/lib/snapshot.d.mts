// Types for snapshot.mjs (the shape both adapters return; see docs/reference/parity/README.md).
export interface Column { id: string; label: string }
export interface Table { columns: Column[]; key: string | null; rows: Record<string, string>[] }
export interface Snapshot {
	view: string; side: 'v5' | 'app'; status: 'ok' | 'not-implemented' | 'error'; error?: string; owner?: string | null; ms?: number;
	title?: string; texts: Record<string, string>; kpis: Record<string, { label: string; value: string; sub?: string }>;
	counts: Record<string, string>; tables: Record<string, Table>; lists: Record<string, string[]>; controls: Record<string, number>;
	sweeps: Record<string, Record<string, string>>; exports: Record<string, ExportEntry>; focus: Record<string, string>;
}
export interface ExportEntry { name: string; columns?: string[]; rows?: string[][]; text?: string }
export interface RawTable { caption?: string; header: string[]; rows: string[][][]; attrs?: Record<string, string>[]; complete?: string | null }
export interface RawControl { kind: string; label: string; id?: string | null; disabled?: boolean; inRow: boolean; column?: string; options?: string[]; value?: string; target?: string }
export interface Raw {
	h1: string[]; headings: { level: number; text: string }[]; kpis: { label: string; value: string; sub: string }[]; tables: RawTable[];
	lists: { caption: string; items: string[] }[]; paragraphs: { section: string; text: string; cls: string }[]; controls: RawControl[];
	focus: unknown; title: string;
}
export function stripArrow(s: string): string;
export function emptySnapshot(view: string, side: 'v5' | 'app', status?: Snapshot['status']): Snapshot;
export function appWithoutAdapter(view: string, registry: Record<string, { status?: string; linear?: string | null } | undefined>, implemented?: ReadonlySet<string>): Snapshot;
export function appFromAdapter(view: string, registry: Record<string, { status?: string; linear?: string | null } | undefined>, sa: Snapshot, implemented?: ReadonlySet<string>): Snapshot;
export function tableFromRaw(t: Pick<RawTable, 'header' | 'rows'>, opts?: { key?: string }): Table & { sorted: string | null };
export function fromRaw(view: string, side: 'v5' | 'app', raw: Raw, opts?: { tableKey?: string }): Snapshot;
export function remap(s: Snapshot, map: Record<string, string>): Snapshot;
