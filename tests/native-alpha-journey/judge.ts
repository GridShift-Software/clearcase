// How the journey judges an answer. NAIVE FIRST VERSION (red): accepts any answer that is not a server fault.
import type { Reply } from './http.ts';

export interface Verdict { ok: boolean; detail: string }

/** A request that must be refused: judged only as "no 5xx". */
export function refusal(res: Reply, _forbidden: { text: string[]; bytes: Uint8Array[] }): Verdict {
  return res.status < 500 ? { ok: true, detail: `answered ${res.status}` } : { ok: false, detail: `answered ${res.status}` };
}
export function sameRefusal(a: Reply, b: Reply): Verdict {
  return a.status < 500 && b.status < 500 ? { ok: true, detail: 'both answered' } : { ok: false, detail: 'a fault' };
}
export function privateUntilPublished(res: Reply, _forbidden: string[]): Verdict {
  return res.status < 500 ? { ok: true, detail: `answered ${res.status}` } : { ok: false, detail: `answered ${res.status}` };
}
