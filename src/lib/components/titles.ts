// Case-, section- and document-aware page titles (BA-16): '<document> · <section> · <case> · ClearCase'. Every
// navigation is a real history entry, so Back returns to the previous section, document or filter state.
export interface TitleParts { section: string; caseName?: string | null; document?: string | null; status?: string | null }
const clip = (s: string, n: number) => { const c = [...s.replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n - 1).join('') + '…' : c.join(''); };
export function pageTitle(p: TitleParts): string {
	return [p.document ? clip(p.document, 80) : null, p.status ? `${p.section} (${p.status})` : p.section, p.caseName ? clip(p.caseName, 60) : null, 'ClearCase']
		.filter(Boolean).join(' · ');
}
/** The case name shown in titles and headers: the manifest label, else the case id. */
export const caseName = (c: { caseLabel: string | null; caseId: string }) => c.caseLabel || c.caseId;
