export interface FreshnessData {
	builtAt: string;
	documents: number;
	viaRescan: number;
	lastScan: { at: string; mode: 'quick' | 'full'; current: boolean; verdict: string } | null;
	href: string;
}

export const stamp = (d: Pick<FreshnessData, 'builtAt' | 'documents' | 'viaRescan'>) =>
	`Built on ${d.builtAt} · ${d.documents.toLocaleString('en')} documents indexed${d.viaRescan ? ` · +${d.viaRescan.toLocaleString('en')} via rescan` : ''}`;
