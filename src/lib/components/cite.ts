import { documentRoute, renderNarrative } from '../case-package/browser.ts';
import { CITATION_TOKEN, parseCitationToken } from '../case-package/refs.ts';

export function citedRefs(texts: Iterable<string>): string[] {
	const out = new Set<string>();
	for (const t of texts) for (const m of String(t).replace(/\r\n?/g, '\n').matchAll(CITATION_TOKEN)) { const c = parseCitationToken(m[1]!.trim()); if (c) out.add(c.ref); }
	return [...out].sort();
}

export const citationResolver = (resultsVersion: string, known: ReadonlySet<string> | readonly string[]) => {
	const set = known instanceof Set ? known : new Set(known as readonly string[]);
	return (ref: string, page: number | null) => (set.has(ref) ? documentRoute(resultsVersion, ref, page) : null);
};

export const narrativeHtml = (text: string, resultsVersion: string, known: ReadonlySet<string> | readonly string[]) =>
	renderNarrative(text, { resolveCitationHref: citationResolver(resultsVersion, known) });
