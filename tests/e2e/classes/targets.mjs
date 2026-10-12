// The targets of the UI class suite (GRS-59), read from the app's own definitions so a new page, form, register or
// export is picked up without editing this file:
//   pages:   every src/routes/**/+page.svelte, its route params filled from the run (resultsVersion, a document ref,
//            the import id, and each registry view without a route of its own for /v/[vid]/[category]/[view]);
//   forms:   every route whose +page.server.ts exports `actions` (or re-exports them), and each POST form its page
//            renders, grouped by its action (`?/save`);
//   exports: every file that hands content to the user, sorted into CSV producers (their pages are driven), declared
//            non-producers and unrecognised ones, which fail the suite (csvExports).
// A form or export the suite finds and cannot drive fails its class until declared.mjs names it, with a reason.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const walk = (dir, out = []) => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const f = join(dir, e.name);
		if (e.isDirectory()) walk(f, out);
		else out.push(f);
	}
	return out;
};

/** Route ids (`/v/[vid]/registers/deadlines_tab`) of every +page.svelte under `root`/src/routes, sorted. */
export function pageRoutes(root) {
	const routes = join(root, 'src', 'routes');
	return walk(routes).filter((f) => f.endsWith(`${sep}+page.svelte`)).map((f) => '/' + relative(routes, f).split(sep).slice(0, -1).join('/')).map((r) => (r === '/' ? '/' : r.replace(/\/$/, ''))).sort();
}

/** Whether a route's +page.server.ts exports form actions (`export const actions`, or re-exports `actions`). */
export function hasActions(root, route) {
	const f = join(root, 'src', 'routes', ...route.split('/').filter(Boolean), '+page.server.ts');
	return existsSync(f) && /export const actions\b|export \{[^}]*\bactions\b[^}]*\} from/.test(readFileSync(f, 'utf8'));
}

const SINK = /\bdownload\(|\bdownloadBlob\(|content-disposition|createObjectURL|text\/csv|<a\b[^>]*\bdownload\b/i;
/** What marks a file as producing CSV: `download` imported from a csv module (any quote, relative or alias), a text/csv type, or toCSV/csvCell in a server file. */
const CSV_MARK = (f, text) => /import\s*\{[^}]*\bdownload\b[^}]*\}\s*from\s*['"][^'"]*\/csv(\.ts)?['"]/.test(text) || /text\/csv/.test(text) || (f.endsWith('+server.ts') && /\b(toCSV|csvCell)\b/.test(text));
const routeOf = (routes, f) => '/' + relative(routes, f).split(sep).slice(0, -1).join('/');

/**
 * The CSV exports of the app, found by what they do: every non-test file under src that hands content to the user
 * (a `download(` / `downloadBlob(` call, a Content-Disposition, an object URL, a text/csv type, an `<a download>`) is
 * one of: a CSV producer (marked by CSV_MARK), a `helpers` file, or a file declared not to produce CSV (`notProducers`,
 * each with its reason; a declared file that now carries a CSV mark is reported in `declaredButCsv`), or `unrecognised`, which the suite fails.
 *   pages:   routes whose +page.svelte is a CSV producer, or renders a component (any .svelte under src) that is;
 *   servers: +server.ts files that are CSV producers.
 */
export function csvExports(root, { notProducers = {}, helpers = {} } = {}) {
	const src = join(root, 'src');
	const routes = join(src, 'routes');
	const files = walk(src).filter((f) => /\.(svelte|ts)$/.test(f) && !/\.test\.ts$/.test(f));
	const rel = (f) => relative(root, f).split(sep).join('/');
	const text = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
	const sinks = files.filter((f) => (SINK.test(text.get(f)) || CSV_MARK(f, text.get(f))) && !helpers[rel(f)]);
	const producers = sinks.filter((f) => CSV_MARK(f, text.get(f)) && !notProducers[rel(f)]);
	const unrecognised = sinks.filter((f) => !CSV_MARK(f, text.get(f)) && !notProducers[rel(f)]).map(rel);
	const declaredButCsv = sinks.filter((f) => notProducers[rel(f)] && CSV_MARK(f, text.get(f))).map(rel);
	const pages = producers.filter((f) => f.endsWith('+page.svelte')).map((f) => routeOf(routes, f));
	const servers = producers.filter((f) => f.endsWith('+server.ts')).map((f) => routeOf(routes, f));
	// a shared component that exports (RegisterPage.svelte) counts for every page that renders it
	const comps = producers.filter((f) => f.endsWith('.svelte') && !f.endsWith('+page.svelte')).map((f) => f.split(sep).pop().replace('.svelte', ''));
	const viaComp = files.filter((f) => f.startsWith(routes) && f.endsWith('+page.svelte') && comps.some((c) => new RegExp(`\\b${c}\\b`).test(text.get(f)))).map((f) => routeOf(routes, f));
	return { pages: [...new Set([...pages, ...viaComp])].sort(), servers: servers.sort(), unrecognised, declaredButCsv };
}

/**
 * Whether a page's source, or a .svelte component it imports (to three levels), matches `re`: LeaveGuard or
 * beforeNavigate for a page that asks before an in-app navigation drops its input; `data-edit` for rows that can be edited.
 */
export function pageUses(root, route, re) {
	const dir = join(root, 'src', 'routes', ...route.split('/').filter(Boolean));
	const seen = new Set();
	const scan = (f, depth) => {
		if (seen.has(f) || !existsSync(f)) return false;
		seen.add(f);
		const t = readFileSync(f, 'utf8');
		if (re.test(t)) return true;
		if (depth >= 3) return false;
		return [...t.matchAll(/from\s+['"](\$lib\/[^'"]+\.svelte|\.{1,2}\/[^'"]+\.svelte)['"]/g)].some((m) => scan(m[1].startsWith('$lib/') ? join(root, 'src', 'lib', m[1].slice(5)) : join(f, '..', m[1]), depth + 1));
	};
	return scan(join(dir, '+page.svelte'), 0);
}
export const hasLeaveGuard = (root, route) => pageUses(root, route, /\bLeaveGuard\b|\bbeforeNavigate\b/);
export const hasEditRows = (root, route) => pageUses(root, route, /\bdata-edit\b/);

/**
 * Concrete URLs for every page route: `params` gives { vid, ref, id } and `views` the view registry; a route with a
 * param the suite cannot fill is returned with `url: null` and the reason, so it is listed rather than dropped.
 */
export function pageTargets(root, { vpath, rv, ref, importId, views }) {
	const out = [];
	for (const route of pageRoutes(root)) {
		if (route === '/v/[vid]/[category]/[view]') {
			// the generic page serves each registry view whose category has no route of its own
			for (const v of views) {
				if (!v.category) continue;
				if (existsSync(join(root, 'src', 'routes', 'v', '[vid]', ...v.route.split('/').filter(Boolean), '+page.svelte'))) continue;
				out.push({ route, view: v.id, url: `${vpath(rv)}${v.route}` });
			}
			continue;
		}
		let url = route.replace('[ref]', ref).replace('[id]', String(importId));
		if (route.startsWith('/v/[vid]')) url = vpath(rv) + url.slice('/v/[vid]'.length);
		const view = route.startsWith('/v/[vid]/') ? route.split('/').pop() : route;
		out.push({ route, view, url: /\[/.test(url) ? null : url, reason: /\[/.test(url) ? 'unfilled route param' : undefined });
	}
	return out;
}
