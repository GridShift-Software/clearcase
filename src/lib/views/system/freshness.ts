// The overview's Freshness slot (GRS-20): v5's freshness stamp (L286-287) and where it stands against the case
// folder. Browser-safe: the data type and the stamp text, shared by the loader, the widget and the tests.
export interface FreshnessData {
	builtAt: string;
	documents: number;
	viaRescan: number;
	lastScan: { at: string; mode: 'quick' | 'full'; current: boolean; verdict: string } | null;
	href: string;
}

/** 'Built on <builtAt> · <n> documents indexed[ · +k via rescan]', as v5 words it. */
export const stamp = (d: Pick<FreshnessData, 'builtAt' | 'documents' | 'viaRescan'>) =>
	`Built on ${d.builtAt} · ${d.documents.toLocaleString('en')} documents indexed${d.viaRescan ? ` · +${d.viaRescan.toLocaleString('en')} via rescan` : ''}`;
