// Relative path rules shared by package files and case-folder asset paths.
// A path is a "/"-separated sequence of literal (not percent-encoded) UTF-8 segments.
// On-disk names are never NFC-normalised; folding is used only to detect collisions.
// Browser-safe: no Node built-ins.
import { LIMITS } from './limits.ts';

export type PathVerdict = { ok: true } | { ok: false; traversal: boolean; reason: string };

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const encoder = new TextEncoder();
const bytes = (s: string): number => encoder.encode(s).length;

export function checkRelPath(p: unknown): PathVerdict {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, traversal: false, reason: 'empty or not a string' };
  if (!p.isWellFormed()) return { ok: false, traversal: false, reason: 'lone surrogate' };
  if (p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z][:|]/.test(p)) return { ok: false, traversal: true, reason: 'absolute path, UNC path or drive letter' };
  if (p.includes('\\')) return { ok: false, traversal: /(^|\\)\.\.(\\|$)/.test(p), reason: 'backslash separator' };
  if (CONTROL.test(p)) return { ok: false, traversal: false, reason: 'control character' };
  const segs = p.split('/');
  if (segs.includes('..')) return { ok: false, traversal: true, reason: '".." segment' };
  if (segs.some((s) => s === '' || s === '.')) return { ok: false, traversal: false, reason: 'empty or "." segment' };
  if (bytes(p) > LIMITS.pathBytes) return { ok: false, traversal: false, reason: `longer than ${LIMITS.pathBytes} bytes` };
  if (segs.length > LIMITS.pathSegments) return { ok: false, traversal: false, reason: `more than ${LIMITS.pathSegments} segments` };
  if (segs.some((s) => bytes(s) > LIMITS.segmentBytes)) return { ok: false, traversal: false, reason: `segment longer than ${LIMITS.segmentBytes} bytes` };
  return { ok: true };
}

/** Collision key for case-insensitive or normalising filesystems. Never used as a real path. */
export const foldPath = (p: string): string => p.normalize('NFC').toLowerCase();

/** The reserved application area inside a case folder. ClearCase never writes there. */
export const isReservedPath = (p: string): boolean => {
  const f = foldPath(p);
  return f === '.clearcase' || f.startsWith('.clearcase/');
};

export type LocatorVerdict = { ok: true; path: string; directory: boolean; fragment: string | null } | { ok: false; traversal: boolean; reason: string };

/**
 * v5 legacy locator ("./" + per-segment encodeURIComponent, optional "#fragment", optional
 * trailing "/" for folders) -> literal relative path. Percent-decoded segments may not hide
 * separators or "..".
 */
export function decodeLegacyLocator(url: string): LocatorVerdict {
  if (!url.startsWith('./')) return { ok: false, traversal: false, reason: 'not a "./" locator' };
  let rest = url.slice(2);
  let fragment: string | null = null;
  const hash = rest.indexOf('#');
  if (hash >= 0) { fragment = rest.slice(hash + 1); rest = rest.slice(0, hash); }
  const directory = rest.endsWith('/');
  if (directory) rest = rest.slice(0, -1);
  const segs: string[] = [];
  for (const raw of rest.split('/')) {
    let s: string;
    try { s = decodeURIComponent(raw); } catch { return { ok: false, traversal: false, reason: 'invalid percent-encoding' }; }
    if (s === '..') return { ok: false, traversal: true, reason: '".." segment' };
    if (s.includes('/') || s.includes('\\')) return { ok: false, traversal: true, reason: 'encoded separator in a segment' };
    segs.push(s);
  }
  const path = segs.join('/');
  const v = checkRelPath(path);
  if (!v.ok) return v;
  return { ok: true, path, directory, fragment };
}
