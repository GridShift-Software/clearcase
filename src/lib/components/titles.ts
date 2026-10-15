export interface TitleParts { section: string; caseName?: string | null; document?: string | null; status?: string | null }
const clip = (s: string, n: number) => { const c = [...s.replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n - 1).join('') + '…' : c.join(''); };
export function pageTitle(p: TitleParts): string {
	return [p.document ? clip(p.document, 80) : null, p.status ? `${p.section} (${p.status})` : p.section, p.caseName ? clip(p.caseName, 60) : null, 'ClearCase']
		.filter(Boolean).join(' · ');
}
export const caseName = (c: { caseLabel: string | null; caseId: string }) => c.caseLabel || c.caseId;
