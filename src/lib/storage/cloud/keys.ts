// R2 object keys. Every key is built from validated digests only: never from a filename, a package path, a host header,
// a route or a request body, so no caller-chosen text reaches a key. One client's bucket holds one client's objects.
const HEX = /^[0-9a-f]{64}$/;
const VERSION = /^sha256:([0-9a-f]{64})$/;
function hex(value: string): string {
  if (!HEX.test(value)) throw new TypeError('object key needs a sha256 digest');
  return value;
}
function versionHex(resultsVersion: string): string {
  const m = VERSION.exec(resultsVersion);
  if (!m) throw new TypeError('object key needs a resultsVersion');
  return m[1]!;
}
export const IDENTITY_KEY = 'identity/client.json';
/** An original, content-addressed and write-once. */
export const originalKey = (sha256: string) => `orig/${hex(sha256)}`;
/** A package file of one version, addressed by its content within that version. */
export const packageKey = (resultsVersion: string, sha256: string) => `pkg/${versionHex(resultsVersion)}/${hex(sha256)}`;
/** A preview of one version: never under another version's prefix. */
export const previewKey = (resultsVersion: string, sha256: string) => `preview/${versionHex(resultsVersion)}/${hex(sha256)}`;
