// How the journey judges an answer. A refusal is a 401, 403 or 404 (or a redirect to sign-in) that carries none of the
// case's invented content and none of the original's bytes; a 5xx is a fault, never a refusal; any 2xx to a request that
// had to be refused is a failure, whatever its body says.
import type { Reply } from './http.ts';

export interface Verdict { ok: boolean; detail: string }
const REFUSING = new Set([401, 403, 404]);
const REDIRECTS = new Set([302, 303, 307]);

const isRefusalStatus = (r: Reply) => REFUSING.has(r.status) || (REDIRECTS.has(r.status) && /^\/sign-in(?:[/?]|$)/.test(r.location ?? ''));
const holds = (bytes: Uint8Array, needle: Uint8Array) => needle.byteLength > 0 && Buffer.from(bytes).includes(Buffer.from(needle));

/** A request that must be refused. */
export function refusal(res: Reply, forbidden: { text: string[]; bytes: Uint8Array[] }): Verdict {
  if (!isRefusalStatus(res)) return { ok: false, detail: res.status >= 500 ? `a fault (${res.status}), not a refusal` : `answered ${res.status}; expected 401, 403, 404 or a redirect to sign-in` };
  const text = forbidden.text.find((t) => res.text.includes(t));
  if (text !== undefined) return { ok: false, detail: `refused with ${res.status} but the body carries case content` };
  if (forbidden.bytes.some((b) => holds(res.bytes, b))) return { ok: false, detail: `refused with ${res.status} but the body carries the original's bytes` };
  return { ok: true, detail: `refused with ${res.status}, no case content` };
}

/** Two refusals that must not tell the cases apart: same status, same body once the case ids are scrubbed. */
export function sameRefusal(a: Reply, b: Reply, scrub: string[] = []): Verdict {
  if (!isRefusalStatus(a) || !isRefusalStatus(b)) return { ok: false, detail: `not both refusals (${a.status}, ${b.status})` };
  const clean = (r: Reply) => scrub.reduce((t, s) => (s ? t.split(s).join('<case>').split(encodeURIComponent(s)).join('<case>') : t), r.text);
  if (a.status !== b.status) return { ok: false, detail: `the refusals differ (${a.status} against ${b.status}): an unknown case must look like an ungranted one` };
  if (clean(a) !== clean(b)) return { ok: false, detail: 'the refusal bodies differ between an unknown and an ungranted case' };
  return { ok: true, detail: `both refused with ${a.status}, alike` };
}

/** A client request before publication: refused, or an ordinary page that shows no results and none of the content. */
export function privateUntilPublished(res: Reply, markers: string[]): Verdict {
  if (res.status !== 200) return isRefusalStatus(res) ? { ok: true, detail: `refused with ${res.status}` } : { ok: false, detail: `answered ${res.status}` };
  if (/data-overview-state="published"/.test(res.text)) return { ok: false, detail: 'the page shows published results before publication' };
  const m = markers.find((t) => res.text.includes(t));
  return m !== undefined ? { ok: false, detail: 'the page carries the private candidate\'s content before publication' } : { ok: true, detail: 'the page shows no results and no private content' };
}
