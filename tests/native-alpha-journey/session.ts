// A supplied browser session, read from a Playwright storage-state file that the parent made after a real Clerk sign-in.
// The scenario never signs anybody in, never mints a session and never accepts a header or token as a stand-in: no
// cookie for the deployment's host means no session, and the run is a HOLD. Cookie values are used and never printed.
import { isPlain } from './common.ts';

export interface Cookie { name: string; value: string; domain: string; path: string; secure: boolean; expires: number }
export interface SessionProof { cookies: Cookie[]; names: string[] }

const hostMatches = (host: string, domain: string) => { const d = domain.replace(/^\./, '').toLowerCase(); return host === d || (domain.startsWith('.') && host.endsWith(`.${d}`)); };

/** Cookies of a storage-state document that apply to this origin now. Problems name a cookie by name only. */
export function sessionFor(state: unknown, origin: URL, nowMs: number): { proof: SessionProof | null; problems: string[] } {
  if (!isPlain(state) || !Array.isArray(state.cookies)) return { proof: null, problems: ['not a Playwright storage state (no cookies array)'] };
  const cookies: Cookie[] = [];
  for (const c of state.cookies) {
    if (!isPlain(c) || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string' || typeof c.path !== 'string') return { proof: null, problems: ['a cookie entry is malformed'] };
    const expires = typeof c.expires === 'number' ? c.expires : -1;
    if (!hostMatches(origin.hostname, c.domain) || !origin.pathname.startsWith(c.path)) continue;
    if (expires > 0 && expires * 1000 <= nowMs) continue; // an expired cookie is no session
    cookies.push({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: c.secure === true, expires });
  }
  if (!cookies.length) return { proof: null, problems: [`no unexpired cookie applies to ${origin.hostname}`] };
  return { proof: { cookies, names: cookies.map((c) => c.name).sort() }, problems: [] };
}

export const cookieHeader = (p: SessionProof) => p.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
