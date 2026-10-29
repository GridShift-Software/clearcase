import { getContext, setContext } from 'svelte';

/** What the case shell shows: the sidebar, the top bar and the main region. Later fields are optional; none is renamed. */
export interface ShellData {
	brand: string;
	caseName: string;
	/** the route base the version's paths sit under: `/v` locally, `/cases/<caseId>/v` on hosted */
	base: string;
	resultsVersion: string;
	/** the current view id, or the last route segment for a page that is no view */
	current: string | null;
	/** null while the version is not published */
	published: { label: string; at: string | null; documents: number } | null;
	/** set by the hosted layout only: shared pages hide what a client must not see (pipeline internals, views hosted never serves) */
	hosted?: boolean;
	searchHref: string;
	account: { name: string; signOutHref: string } | null;
	actions: { label: string; href: string }[];
}

const BASE = 'clearcase:base';
// A getter, not the value: a layout kept across a navigation to another case keeps its context.
export const setRouteBase = (base: () => string) => setContext(BASE, base);
export const routeBase = (): (() => string) => getContext<(() => string) | undefined>(BASE) ?? (() => '/v');

const HOSTED = 'clearcase:hosted';
export const setHosted = (hosted: () => boolean) => setContext(HOSTED, hosted);
/** Whether the page renders in the hosted shell. A getter, as `routeBase` is; false outside any shell, so the local pilot is unchanged. */
export const isHosted = (): (() => boolean) => getContext<(() => boolean) | undefined>(HOSTED) ?? (() => false);
