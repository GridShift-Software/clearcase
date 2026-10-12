// The targets of the UI class suite (GRS-59), read from the app's own definitions so a new page, form, register or
// export is picked up without editing this file:
//   pages:   every src/routes/**/+page.svelte, its route params filled from the run (resultsVersion, a document ref,
//            the import id, and each registry view without a route of its own for /v/[vid]/[category]/[view]);
//   forms:   every route whose +page.server.ts exports `actions` (or re-exports them), and each POST form its page
//            renders, grouped by its action (`?/save`);
//   exports: every page that imports `download` from $lib/components/csv, and every +server.ts that imports `toCSV`.
// A form or export the suite finds and cannot drive fails the class until its applicability is declared in
// classes.mjs (APPLIES), with a reason when a class does not apply.
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

/** Routes that render CSV in the browser (`download` from $lib/components/csv) or on the server (`toCSV` in +server.ts). */
export function csvExports(root) {
	const routes = join(root, 'src', 'routes');
	const lib = join(root, 'src', 'lib');
	const uses = (f) => /import \{[^}]*\bdownload\b[^}]*\} from '\$lib\/components\/csv'/.test(readFileSync(f, 'utf8'));
	const pages = walk(routes).filter((f) => f.endsWith('+page.svelte') && uses(f)).map((f) => '/' + relative(routes, f).split(sep).slice(0, -1).join('/'));
	const servers = walk(routes).filter((f) => f.endsWith('+server.ts') && /\btoCSV\b/.test(readFileSync(f, 'utf8'))).map((f) => '/' + relative(routes, f).split(sep).slice(0, -1).join('/'));
	// a shared component that exports (RegisterPage.svelte) counts for every page that renders it
	const comps = walk(lib).filter((f) => f.endsWith('.svelte') && uses(f)).map((f) => f.split(sep).pop().replace('.svelte', ''));
	const viaComp = walk(routes).filter((f) => f.endsWith('+page.svelte') && comps.some((c) => new RegExp(`\\b${c}\\b`).test(readFileSync(f, 'utf8')))).map((f) => '/' + relative(routes, f).split(sep).slice(0, -1).join('/'));
	return { pages: [...new Set([...pages, ...viaComp])].sort(), servers: servers.sort() };
}

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
		let url = route.replace('[vid]', encodeURIComponent(rv).replace(/%/g, '%25').replace(/%25/g, '%')).replace('[ref]', ref).replace('[id]', String(importId));
		if (route.startsWith('/v/[vid]')) url = vpath(rv) + route.slice('/v/[vid]'.length);
		url = url.replace('[ref]', ref);
		const view = route.startsWith('/v/[vid]/') ? route.split('/').pop() : route;
		out.push({ route, view, url: /\[/.test(url) ? null : url, reason: /\[/.test(url) ? 'unfilled route param' : undefined });
	}
	return out;
}
