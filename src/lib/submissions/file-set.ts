/**
 * One multi-file submission: a set of PDFs sealed into one immutable submission revision. Hosted-safe and client-safe: Web
 * Crypto only, so the intake page computes the same digest the server fixes at the seal.
 */

/**
 * The reviewed ceiling of files in one set. It matches the package's 8,192-file ceiling (U15), above a v5 export's 1,689
 * originals. A larger set is refused before anything is written.
 */
export const MAX_SET_FILES = 8192;
export const FILE_SET_FORMAT = 'clearcase.submission-file-set/1';

export interface FileSetEntry { path: string; size: number; sha256: string }

/**
 * The digest of a set's exact file list: SHA-256 of the format line, then one line `<sha256> <size> <path>` per file in
 * code-unit order of the NFC path. A path holds no line break (safePath refuses control characters), and it is the last
 * field, so the text is unambiguous. The client sends it at the seal and the server compares it with its own records.
 */
export async function fileSetDigest(files: readonly FileSetEntry[]): Promise<string> {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const bytes = new TextEncoder().encode(`${FILE_SET_FORMAT}\n${sorted.map((f) => `${f.sha256} ${f.size} ${f.path}\n`).join('')}`);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
}
