import { classifyLink } from './links.ts';
import { CITATION_TOKEN, parseCitationToken } from './refs.ts';

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESC[c]!);

const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\ufff9-\ufffb]/gu;

export const revealInvisible = (s: string): string =>
  s.replace(INVISIBLE, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);

export const displayText = (s: string): string => escapeHtml(revealInvisible(s.replace(/\r\n?/g, '\n')));

export function displayFilename(s: string, max = 120): string {
  const r = revealInvisible(s);
  const chars = [...r];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : r;
}

const APP_HREF = /^\/(?!\/)(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*(?:\?(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?(?:#(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$/;

export function isSafeAppHref(href: unknown): href is string {
  if (typeof href !== 'string' || href.length === 0 || href.length > 2048 || !APP_HREF.test(href)) return false;
  const path = href.split(/[?#]/, 1)[0]!;
  for (const seg of path.split('/')) {
    let d: string;
    try { d = decodeURIComponent(seg); } catch { return false; }
    if (d === '.' || d === '..' || d.includes('/') || d.includes('\\') || /[\u0000-\u001f\u007f]/.test(d)) return false;
  }
  return true;
}

export function documentRoute(resultsVersion: string, ref: string, page?: number | null): string {
  const base = `/v/${encodeURIComponent(resultsVersion)}/doc/${encodeURIComponent(ref)}`;
  return page ? `${base}?page=${page}` : base;
}

export interface RenderNarrativeOptions {
  resolveCitationHref: (ref: string, page: number | null) => string | null | undefined;
}

export function renderNarrative(text: string, opts: RenderNarrativeOptions): string {
  const src = String(text).replace(/\r\n?/g, '\n');
  const paras = src.split(/\n{2,}/).filter((p) => p.length > 0);
  return paras.map((p) => `<p>${renderInline(p, opts)}</p>`).join('');
}

function renderInline(p: string, opts: RenderNarrativeOptions): string {
  let out = '';
  let last = 0;
  for (const m of p.matchAll(CITATION_TOKEN)) {
    out += textHtml(p.slice(last, m.index));
    last = m.index! + m[0].length;
    const tok = parseCitationToken(m[1]!.trim());
    if (!tok) { out += textHtml(m[0]); continue; }
    const label = tok.page ? `${tok.ref} p.${tok.page}` : tok.ref;
    let href: unknown = null;
    try { href = opts.resolveCitationHref(tok.ref, tok.page); } catch { href = null; }
    out += isSafeAppHref(href)
      ? `<a class="cite" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`
      : `<span class="cite-broken" title="Citation does not resolve">${textHtml(m[0])}</span>`;
  }
  out += textHtml(p.slice(last));
  return out;
}

const textHtml = (s: string): string => escapeHtml(revealInvisible(s)).replace(/\n/g, '<br>');

export function safeExternalHref(raw: string): string | null {
  const c = classifyLink(raw);
  return c.kind === 'external' ? c.href : null;
}

/** CSV/XLSX export guard against formula injection (user-entered text only; imported values stay unchanged). */
export const exportCell = (s: string): string => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
