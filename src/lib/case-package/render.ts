// Safe rendering of untrusted imported text. Every imported narrative, filename, URL and
// metadata value is untrusted. Views put imported values only into text nodes; the one
// exception is renderNarrative(), whose output may be inserted as HTML because it escapes
// everything first and then emits only <p>, <br>, <a class="cite" href> and
// <span class="cite-broken">. Citation hrefs are built by the app, never taken from data,
// and every generated href is checked against isSafeAppHref.
// Browser-safe: imports no filesystem code and no Node built-ins.
import { classifyLink } from './links.ts';
import { CITATION_TOKEN, parseCitationToken } from './refs.ts';

const HTML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESC[c]!);

// C0 except TAB and LF, DEL, C1, every default-ignorable code point (soft hyphen, Arabic letter
// mark, zero-width and directional marks, bidi embeddings, overrides and isolates, invisible
// operators, variation selectors, fillers, tags, BOM) and the interlinear annotation controls.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}\ufff9-\ufffb]/gu;

/** Shows hidden characters as ⟨U+XXXX⟩, e.g. a right-to-left override in a filename. */
export const revealInvisible = (s: string): string =>
  s.replace(INVISIBLE, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`);

/** Plain untrusted text as HTML-safe text (for contexts that cannot use a text node). */
export const displayText = (s: string): string => escapeHtml(revealInvisible(s.replace(/\r\n?/g, '\n')));

/** Filenames: hidden characters visible, at most `max` characters, never a link or a path. */
export function displayFilename(s: string, max = 120): string {
  const r = revealInvisible(s);
  const chars = [...r];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : r;
}

const APP_HREF = /^\/(?!\/)(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/]|%[0-9A-Fa-f]{2})*(?:\?(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?(?:#(?:[A-Za-z0-9\-._~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$/;

/**
 * An app-built route: same-origin absolute path, no scheme, no authority, no backslash,
 * no raw whitespace or control characters, no "." or ".." segment (also percent-encoded).
 */
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

/**
 * The pilot's document route: /v/<resultsVersion>/doc/<ref>, both URL-encoded, with an
 * optional page. Importers route by resultsVersion ('sha256:<hex>'), never by a short id.
 */
export function documentRoute(resultsVersion: string, ref: string, page?: number | null): string {
  const base = `/v/${encodeURIComponent(resultsVersion)}/doc/${encodeURIComponent(ref)}`;
  return page ? `${base}?page=${page}` : base;
}

export interface RenderNarrativeOptions {
  /** Returns the app route for a cited ref (and page), or null when the target does not resolve. */
  resolveCitationHref: (ref: string, page: number | null) => string | null | undefined;
}

/**
 * Authored narrative -> minimal HTML. Blank lines separate paragraphs, single newlines
 * become <br>. [[REF]] and [[REF#p3]] become citation links when the app resolves them to
 * a safe route; otherwise they render as a visibly broken citation. Markdown links, bare
 * URLs and any markup stay literal text.
 */
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

/**
 * External link for an explicit operator click: https (with a host, no credentials) or
 * mailto only. Render with rel="noopener noreferrer" and never fetch automatically.
 */
export function safeExternalHref(raw: string): string | null {
  const c = classifyLink(raw);
  return c.kind === 'external' ? c.href : null;
}

/** CSV/XLSX export guard against formula injection (user-entered text only; imported values stay unchanged). */
export const exportCell = (s: string): string => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
