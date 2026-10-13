// HTTP client for the pilot's app origin: form posts with an Origin header (SvelteKit's CSRF check), the import and
// activation flows, and page reads. Pages are parsed with regular expressions on stable ids and data-* attributes.
export function client(port) {
	const origin = `http://127.0.0.1:${port}`;
	const get = async (path, opts = {}) => {
		const r = await fetch(origin + path, { redirect: 'manual', ...opts });
		return { status: r.status, location: r.headers.get('location'), text: await r.text(), headers: Object.fromEntries(r.headers) };
	};
	const form = async (path, fields, extraHeaders = {}) => {
		const body = new URLSearchParams();
		for (const [k, v] of Array.isArray(fields) ? fields : Object.entries(fields)) body.append(k, v);
		const r = await fetch(origin + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin, accept: 'text/html', ...extraHeaders }, body });
		const text = await r.text();
		let location = r.headers.get('location');
		if (!location && /^\{"type":"redirect"/.test(text)) location = JSON.parse(text).location;
		return { status: r.status, location, text };
	};
	const c = {
		origin, get, form,
		health: () => fetch(`${origin}/api/health`).then((r) => r.json()),
		/** POST the import form; resolves to the report's import id and the redirect. */
		async importPkg(caseFolder, packageSource) {
			const t0 = performance.now();
			const r = await form('/import?/import', { caseFolder, packageSource });
			const m = /^\/import\/(\d+)(\?.*)?$/.exec(r.location ?? '');
			return { status: r.status, location: r.location, importId: m ? Number(m[1]) : null, noop: !!m?.[2]?.includes('noop'), repaired: !!m?.[2]?.includes('repaired'), ms: performance.now() - t0, text: m ? '' : r.text };
		},
		async report(id) {
			const r = await get(`/import/${id}`);
			const t = r.text;
			const formHtml = /<form method="POST" action="\?\/activate"[\s\S]*?<\/form>/.exec(t)?.[0] ?? null;
			const hidden = formHtml ? [...formHtml.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], decodeHtml(m[2])]) : [];
			return {
				status: r.status, html: t, verdict: /data-verdict="([a-z]+)"/.exec(t)?.[1] ?? null,
				resultsVersion: /id="results-version"[^>]*>([^<]+)</.exec(t)?.[1] ?? null,
				codes: Object.fromEntries([...t.matchAll(/data-code="([A-Z0-9_]+)" data-severity="([a-z]+)"/g)].map((m) => [m[1], m[2]])),
				appCodes: [...t.matchAll(/<li><strong>(APP_[A-Z_]+)<\/strong>/g)].map((m) => m[1]),
				hidden, canActivate: !!formHtml, needsAck: /name="ack"/.test(formHtml ?? ''), verify: /id="verify-state">([^<]+)</.exec(t)?.[1] ?? null,
			};
		},
		/** Submit the report's activation form; `ack` ticks the acknowledgement checkbox. */
		async activate(id, { ack = true, override = null } = {}) {
			const rep = await c.report(id);
			const fields = override ?? [...rep.hidden, ...(ack && rep.needsAck ? [['ack', 'on']] : [])];
			const t0 = performance.now();
			const r = await form(`/import/${id}?/activate`, fields);
			const err = /id="activate-error"[^>]*data-reasons="([^"]*)"[^>]*>([^<]*)</.exec(r.text);
			return { status: r.status, location: r.location, reasons: err ? err[1].split(' ').filter(Boolean) : [], error: err ? decodeHtml(err[2]) : null, ms: performance.now() - t0 };
		},
		/** Where Open goes on the case list's first row (the most recently activated case), or null when no case is listed. */
		async home() {
			const r = await get('/cases');
			const m = /class="btn open" href="([^"]+)"/.exec(r.text);
			return m ? decodeHtml(m[1]) : null;
		},
		/** The effective active version of the most recently activated case, from the case list. */
		async activeVersion() {
			const m = /^\/v\/([^/]+)\/overview$/.exec((await c.home()) ?? '');
			return m ? decodeURIComponent(m[1]) : null;
		},
	};
	return c;
}
export const decodeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
export const vpath = (rv) => `/v/${encodeURIComponent(rv)}`;
