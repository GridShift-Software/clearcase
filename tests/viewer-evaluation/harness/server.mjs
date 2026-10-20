// The evaluation's trusted origin. It serves the shell (which holds a synthetic session cookie), authorizes asset and
// descriptor reads by that cookie, and serves each renderer page with a sandboxing CSP: opaque origin, scripts only
// from the pinned bundles, no network except pdf.js's static CMaps and fonts, no forms, frames or navigation.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { OUT_ROOT } from './paths.mjs';

const WWW = path.join(OUT_ROOT, 'www');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream', '.ttf': 'font/ttf' };
export const SESSION = 'cc_session=synthetic-session-secret';

/** Renderer CSP per family: only the PDF reader may fetch, and only pdf.js's static resources. */
export function rendererCsp(origin, family) {
  const styleInline = ['word', 'sheet', 'email'].includes(family) ? " 'unsafe-inline'" : '';
  const connect = family === 'pdf' ? `${origin}/vendor/pdfjs/cmaps/ ${origin}/vendor/pdfjs/standard_fonts/ ${origin}/vendor/pdfjs/pdf.worker.min.mjs` : "'none'";
  return `sandbox allow-scripts; default-src 'none'; script-src ${origin}/r/ ${origin}/vendor/pdfjs/; style-src ${origin}/r/ ${origin}/vendor/${styleInline}; img-src blob: data:; media-src blob:; font-src ${origin}/vendor/pdfjs/ data:; connect-src ${connect}; worker-src 'none'; frame-src ${family === 'email' ? "'self'" : "'none'"}; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}`;
}

export function startServer({ descriptors, assets }) {
  const log = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req) {
      const url = new URL(req.url);
      const origin = `http://127.0.0.1:${server.port}`;
      const cookie = req.headers.get('cookie') ?? '';
      const authed = cookie.split(/;\s*/).includes(SESSION);
      log.push({ path: url.pathname, authed, origin: req.headers.get('origin'), secFetchSite: req.headers.get('sec-fetch-site'), dest: req.headers.get('sec-fetch-dest') });
      const nosniff = { 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
      if (url.pathname === '/' || url.pathname === '/shell.html') {
        return new Response(readFileSync(path.join(WWW, 'shell.html')), { headers: { ...nosniff, 'Content-Type': TYPES['.html'], 'Set-Cookie': `${SESSION}; Path=/; HttpOnly; SameSite=Strict`, 'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` } });
      }
      let m;
      if ((m = /^\/(asset|descriptor)\/(.+)$/.exec(url.pathname))) {
        if (!authed || req.headers.get('sec-fetch-site') !== 'same-origin') return new Response('unauthorized', { status: 401, headers: nosniff });
        const id = decodeURIComponent(m[2]);
        if (m[1] === 'descriptor') { const d = descriptors.get(id); return d ? Response.json(d, { headers: nosniff }) : new Response('not found', { status: 404, headers: nosniff }); }
        const a = assets.get(id);
        return a ? new Response(a.bytes, { headers: { ...nosniff, 'Content-Type': 'application/octet-stream' } }) : new Response('not found', { status: 404, headers: nosniff });
      }
      if ((m = /^\/r\/(\w+)\.html$/.exec(url.pathname))) {
        const family = m[1];
        if (!existsSync(path.join(WWW, 'r', `${family}.js`))) return new Response('no renderer', { status: 404 });
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${family} reader</title><link rel="stylesheet" href="${origin}/r/renderer.css" crossorigin="anonymous">${family === 'pdf' ? `<link rel="stylesheet" href="${origin}/vendor/pdfjs/pdf_viewer.css" crossorigin="anonymous">` : ''}${family === 'sheet' ? `<link rel="stylesheet" href="${origin}/vendor/tabulator.min.css" crossorigin="anonymous">` : ''}<script type="module" src="${origin}/r/${family}.js" crossorigin="anonymous"></script></head><body><div id="status" role="status" aria-live="polite">Loading…</div><main id="app"></main></body></html>`;
        return new Response(html, { headers: { ...nosniff, 'Content-Type': TYPES['.html'], 'Content-Security-Policy': rendererCsp(origin, family) } });
      }
      if (url.pathname.startsWith('/r/') || url.pathname.startsWith('/vendor/')) {
        const file = path.join(WWW, path.normalize(url.pathname).replace(/^\/+/, ''));
        if (!file.startsWith(WWW + path.sep) || !existsSync(file)) return new Response('not found', { status: 404 });
        return new Response(readFileSync(file), { headers: { ...nosniff, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { server, origin: `http://127.0.0.1:${server.port}`, log };
}
