// Link classification for imported link-bearing values (url, headline_url, sliceUrl, file,
// indexFile, ...) and for Markdown-style links in authored prose. Mirrors the WHATWG URL
// parser's leniency (leading C0 and space stripped, TAB/LF/CR removed anywhere) before the
// scheme is judged, so "  java\tscript:" is still caught. Imported values are never used
// as href; this decides only whether a package may carry them.
// Browser-safe: no Node built-ins.
import { decodeLegacyLocator } from './paths.ts';

export type LinkClass =
  | { kind: 'package'; path: string; directory: boolean; fragment: string | null }
  | { kind: 'external'; href: string; scheme: 'https' | 'mailto' }
  | { kind: 'text-only'; reason: string; scheme: string }
  | { kind: 'name'; reason: string }
  | { kind: 'rejected'; reason: string; scheme?: string; traversal?: boolean };

/** Schemes that are never followed, not even as inert text links. */
export const REJECTED_SCHEMES = new Set([
  'javascript', 'vbscript', 'data', 'file', 'blob', 'filesystem', 'about', 'chrome', 'chrome-extension',
  'intent', 'jar', 'view-source', 'ws', 'wss', 'ftp', 'livescript', 'mocha', 'ms-its', 'mhtml', 'res', 'resource',
]);

export const MAX_LINK = 2048;

export function normaliseForScheme(raw: string): string {
  return raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+/, '').replace(/[\u0000- ]+$/, '');
}

export function classifyLink(raw: string): LinkClass {
  if (raw.length > MAX_LINK) return { kind: 'rejected', reason: `longer than ${MAX_LINK} characters` };
  const v = normaliseForScheme(raw);
  if (v.startsWith('//') || v.startsWith('\\\\') || v.startsWith('/\\') || v.startsWith('\\/')) {
    return { kind: 'rejected', reason: 'protocol-relative or UNC locator', traversal: true };
  }
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(v);
  if (m) {
    const scheme = m[1]!.toLowerCase();
    if (scheme.length === 1) return { kind: 'rejected', reason: 'drive-letter path', scheme, traversal: true };
    if (REJECTED_SCHEMES.has(scheme)) return { kind: 'rejected', reason: `scheme ${scheme}: is not allowed`, scheme };
    if (scheme === 'https') {
      let u: URL;
      try { u = new URL(v); } catch { return { kind: 'rejected', reason: 'unparseable https URL', scheme }; }
      if (!u.hostname || u.username || u.password) return { kind: 'rejected', reason: 'https URL without a host or with credentials', scheme };
      return { kind: 'external', href: u.href, scheme: 'https' };
    }
    // only the address: a query could prefill recipients (cc, bcc) or a body
    if (scheme === 'mailto') return { kind: 'external', href: v.split('?', 1)[0]!, scheme: 'mailto' };
    return { kind: 'text-only', reason: `scheme ${scheme}: is shown as text and never linked`, scheme };
  }
  if (/^[A-Za-z]\|/.test(v)) return { kind: 'rejected', reason: 'drive-letter path', traversal: true };
  if (v.startsWith('./')) {
    const d = decodeLegacyLocator(v);
    if (d.ok) return { kind: 'package', path: d.path, directory: d.directory, fragment: d.fragment };
    return { kind: 'rejected', reason: d.reason, traversal: d.traversal };
  }
  if (v.startsWith('/') || v.startsWith('\\')) return { kind: 'rejected', reason: 'absolute locator', traversal: true };
  if (v.split(/[/\\]/).includes('..')) return { kind: 'rejected', reason: 'traversing locator', traversal: true };
  return { kind: 'name', reason: 'bare name, not a locator' };
}
