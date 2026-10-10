// The citation contract: [[REF]] and [[REF#pN]] in authored narrative become links to the document route of the
// version being viewed, through GRS-10's renderNarrative (escapes everything, emits only p/br/a.cite/span.cite-broken,
// checks every href with isSafeAppHref). Only refs that exist in the version resolve; the rest render visibly broken.
// Browser-safe.
import { documentRoute, renderNarrative } from '../case-package/browser.ts';
import { CITATION_TOKEN, parseCitationToken } from '../case-package/refs.ts';

/**
 * The refs cited in a set of texts (the server checks which of them exist in the version). Tokens are read as
 * renderNarrative reads them (line breaks normalised, the inner text trimmed), so every ref it links is looked up.
 */
export function citedRefs(texts: Iterable<string>): string[] {
	const out = new Set<string>();
	for (const t of texts) for (const m of String(t).replace(/\r\n?/g, '\n').matchAll(CITATION_TOKEN)) { const c = parseCitationToken(m[1]!.trim()); if (c) out.add(c.ref); }
	return [...out].sort();
}

export const citationResolver = (resultsVersion: string, known: ReadonlySet<string> | readonly string[]) => {
	const set = known instanceof Set ? known : new Set(known as readonly string[]);
	return (ref: string, page: number | null) => (set.has(ref) ? documentRoute(resultsVersion, ref, page) : null);
};

/** Narrative HTML for {@html}: the only sanctioned use of raw HTML in the app. */
export const narrativeHtml = (text: string, resultsVersion: string, known: ReadonlySet<string> | readonly string[]) =>
	renderNarrative(text, { resolveCitationHref: citationResolver(resultsVersion, known) });
