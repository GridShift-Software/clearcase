// The journey's only way to reach the deployed system: HTTPS requests with a supplied session's cookies. Redirects are
// never followed (a redirect to sign-in is an answer to be judged), bodies are bounded, and there is no retry, no
// fallback origin and no header that could stand in for a session. The CLI passes the real `fetch`; only this
// directory's own unit tests pass another function, and the CLI offers no way to do so.
import { cookieHeader, type SessionProof } from './session.ts';
import { sha256Hex } from './common.ts';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;
export interface Reply { status: number; headers: Headers; bytes: Uint8Array; location: string | null; text: string; sha256: string }
export interface Actor { name: string; send: (method: string, path: string, init?: Send) => Promise<Reply> }
export interface Send { headers?: Record<string, string>; body?: Uint8Array | string; origin?: string | null }

export const MAX_BODY = 64 * 1024 * 1024;

export function makeActor(name: string, base: URL, session: SessionProof | null, fetchFn: FetchFn): Actor {
  return {
    name,
    async send(method, path, init = {}) {
      if (!path.startsWith('/') || path.startsWith('//')) throw new Error('a journey request names a path of the deployment origin');
      const headers: Record<string, string> = { accept: '*/*', 'user-agent': 'clearcase-native-journey/1', ...init.headers };
      if (session) headers.cookie = cookieHeader(session);
      // Browsers send Origin on every non-GET; so does the journey, unless a test names another (or none) on purpose.
      if (method !== 'GET' && method !== 'HEAD' && init.origin !== null) headers.origin = init.origin ?? base.origin;
      const res = await fetchFn(new URL(path, base).href, { method, headers, body: init.body as BodyInit | undefined, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      const reader = res.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY) { await reader.cancel(); throw new Error('the response is larger than the journey accepts'); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
      return { status: res.status, headers: res.headers, bytes, location: res.headers.get('location'), text: new TextDecoder().decode(bytes), sha256: sha256Hex(bytes) };
    },
  };
}
