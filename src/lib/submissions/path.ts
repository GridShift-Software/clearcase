/**
 * The relative path a client gives for one supplied file, normalized and checked. NFC; `/` separators only; no absolute
 * path, drive, empty, `.` or `..` segment; no backslash, control, bidirectional or invisible formatting character; no
 * segment ending in a dot or space (Windows would rename it); at most 16 segments, 255 code units each, 1024 in all; the
 * file name ends in `.pdf` (this slice takes PDFs only). The path is provenance shown to people; storage never derives an
 * object key from it.
 */
export type SafePath = { path: string; filename: string; key: string };

const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\\:*?"<>|\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/;

export function safePath(raw: unknown): SafePath | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024 || !raw.isWellFormed()) return null;
  const path = raw.normalize('NFC');
  if (path.startsWith('/') || FORBIDDEN.test(path)) return null;
  const segments = path.split('/');
  if (segments.length > 16) return null;
  for (const s of segments) {
    if (s.length === 0 || s.length > 255 || s === '.' || s === '..' || /[. ]$/.test(s) || /^\s/.test(s)) return null;
  }
  const filename = segments[segments.length - 1];
  if (!/^.+\.pdf$/i.test(filename)) return null;
  // Two paths that differ only by letter case or by compatibility form name one file on common file systems.
  return { path, filename, key: path.normalize('NFKC').toLowerCase() };
}
