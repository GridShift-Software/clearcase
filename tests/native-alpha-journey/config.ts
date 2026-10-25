// Journey configuration from the private environment. Anything missing, malformed or unsafe is a HOLD that names the
// variable (never its value). Nothing here opens a network connection, and nothing defaults to a permissive value.
import path from 'node:path';
import { PART, SHA, SHA1 } from './common.ts';
import { resolveRoutes, type Resolved } from './routes.ts';
import { sessionFor, type SessionProof } from './session.ts';

export type ActorName = 'clientA' | 'operatorB' | 'otherClient' | 'revoked' | 'reviewer';
export const PHASES = ['upload-import', 'signoff-publish', 'after-restart'] as const;
export type Phase = (typeof PHASES)[number];
const ACTOR_VARS: Record<ActorName, string> = {
  clientA: 'CLEARCASE_JOURNEY_CLIENT_A_STATE', operatorB: 'CLEARCASE_JOURNEY_OPERATOR_B_STATE', otherClient: 'CLEARCASE_JOURNEY_OTHER_CLIENT_STATE',
  revoked: 'CLEARCASE_JOURNEY_REVOKED_STATE', reviewer: 'CLEARCASE_JOURNEY_REVIEWER_STATE',
};

export interface Config {
  base: URL; expectedSha: string; caseId: string; foreignCaseId: string | null; outDir: string; resolved: Resolved;
  sessions: Partial<Record<ActorName, SessionProof>>;
  /** phase 2 only: the human's confirmation of the exact candidate identity digest, and who they are (a label, not a secret) */
  human: { identitySha256: string; reviewerRef: string } | null;
  runId: string | null;
}
export type Loaded = { kind: 'hold'; reasons: string[] } | { kind: 'ready'; config: Config };

export interface ConfigIo { env: Record<string, string | undefined>; read: (absolutePath: string) => string | null; repoRoot: string; nowMs: number }

const LOCAL_HOST = /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/i;
const PROVIDER_PREVIEW_HOST = /\.(?:workers|pages)\.dev$/i;

export function baseUrlProblems(raw: string | undefined): { url: URL | null; problems: string[] } {
  if (!raw) return { url: null, problems: ['CLEARCASE_JOURNEY_BASE_URL is not set (the production-profile native origin)'] };
  let url: URL;
  try { url = new URL(raw); } catch { return { url: null, problems: ['CLEARCASE_JOURNEY_BASE_URL is not a URL'] }; }
  const p: string[] = [];
  if (url.protocol !== 'https:') p.push('CLEARCASE_JOURNEY_BASE_URL must be https');
  if (url.username || url.password) p.push('CLEARCASE_JOURNEY_BASE_URL must not carry credentials');
  if (url.pathname !== '/' || url.search || url.hash) p.push('CLEARCASE_JOURNEY_BASE_URL must be an origin only (no path, query or fragment)');
  if (LOCAL_HOST.test(url.hostname)) p.push('CLEARCASE_JOURNEY_BASE_URL must be the deployed native hostname, not a local or private address');
  if (PROVIDER_PREVIEW_HOST.test(url.hostname)) p.push('CLEARCASE_JOURNEY_BASE_URL must be the native custom domain; workers.dev and pages.dev are closed for this profile');
  return { url: p.length ? null : url, problems: p };
}

/** Session files live outside the checkout, or under its ignored .local/; never at a tracked path. */
export function stateFileProblem(file: string, repoRoot: string): string | null {
  if (!path.isAbsolute(file)) return 'must be an absolute path';
  const rel = path.relative(repoRoot, file);
  if (!rel.startsWith('..') && !path.isAbsolute(rel) && !rel.startsWith(`.local${path.sep}`)) return 'must be outside the checkout or under its ignored .local/';
  return null;
}

export function loadConfig(phase: Phase, io: ConfigIo): Loaded {
  const { env } = io, reasons: string[] = [];
  const need = (name: string, ok: (v: string) => boolean, why: string): string | null => {
    const v = env[name];
    if (v === undefined || v === '') { reasons.push(`${name} is not set`); return null; }
    if (!ok(v)) { reasons.push(`${name} ${why}`); return null; }
    return v;
  };
  const { url, problems } = baseUrlProblems(env.CLEARCASE_JOURNEY_BASE_URL);
  reasons.push(...problems);
  const expectedSha = need('CLEARCASE_JOURNEY_EXPECTED_SHA', (v) => SHA1.test(v), 'must be the 40-hex source commit the deployment was built from');
  const caseId = need('CLEARCASE_JOURNEY_CASE_ID', (v) => PART.test(v), 'is not a valid case id');
  const foreign = need('CLEARCASE_JOURNEY_FOREIGN_CASE_ID', (v) => PART.test(v) && v !== caseId, 'must be a provisioned ungranted case id other than the journey case');
  const out = need('CLEARCASE_JOURNEY_OUT', (v) => path.isAbsolute(v) && stateFileProblem(path.join(v, 'x'), io.repoRoot) === null, 'must be an absolute directory outside the checkout or under its ignored .local/');

  let routesFile: unknown = null;
  const routesPath = env.CLEARCASE_JOURNEY_ROUTES;
  if (routesPath) {
    const text = path.isAbsolute(routesPath) ? io.read(routesPath) : null;
    if (text === null) reasons.push('CLEARCASE_JOURNEY_ROUTES must be an absolute path of a readable routes file');
    else { try { routesFile = JSON.parse(text); } catch { reasons.push('CLEARCASE_JOURNEY_ROUTES is not JSON'); } }
  }
  const resolved = resolveRoutes(routesFile);
  reasons.push(...resolved.problems);
  for (const n of resolved.unresolved) reasons.push(`route port ${n} is unresolved: supply it in CLEARCASE_JOURNEY_ROUTES from its owning worker's accepted doc (no route is invented)`);

  // The sessions: all four are required before any request; the reviewer is optional.
  const sessions: Partial<Record<ActorName, SessionProof>> = {};
  for (const actor of Object.keys(ACTOR_VARS) as ActorName[]) {
    const name = ACTOR_VARS[actor];
    const file = env[name];
    if (!file) { if (actor !== 'reviewer') reasons.push(`${name} is not set (a real Clerk session's storage state, supplied privately)`); continue; }
    const bad = stateFileProblem(file, io.repoRoot);
    if (bad) { reasons.push(`${name} ${bad}`); continue; }
    const text = io.read(file);
    if (text === null) { reasons.push(`${name} names a file that cannot be read`); continue; }
    let doc: unknown;
    try { doc = JSON.parse(text); } catch { reasons.push(`${name} is not JSON`); continue; }
    if (!url) continue;
    const { proof, problems: sp } = sessionFor(doc, url, io.nowMs);
    if (proof) sessions[actor] = proof; else reasons.push(...sp.map((x) => `${name}: ${x}`));
  }
  // One cookie jar per actor: two actors sharing a session value would make every refusal test meaningless.
  const seen = new Map<string, ActorName>();
  for (const [actor, proof] of Object.entries(sessions) as [ActorName, SessionProof][]) {
    const fingerprint = proof.cookies.map((c) => `${c.name}=${c.value}`).sort().join(';');
    const other = seen.get(fingerprint);
    if (other) reasons.push(`${ACTOR_VARS[actor]} holds the same cookies as ${ACTOR_VARS[other]}; every actor needs its own session`);
    seen.set(fingerprint, actor);
  }

  let human: Config['human'] = null;
  if (phase === 'signoff-publish') {
    const digest = need('CLEARCASE_JOURNEY_HUMAN_SIGNOFF_IDENTITY_SHA256', (v) => SHA.test(v), 'must be the sha256 shown at the end of phase 1, typed by the human who reviewed that exact candidate');
    const ref = need('CLEARCASE_JOURNEY_HUMAN_REVIEWER_REF', (v) => /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,63}$/.test(v) && !v.includes('@'), 'must be a short non-secret label of the human reviewer (3 to 64 characters, no e-mail)');
    if (digest && ref) human = { identitySha256: digest, reviewerRef: ref };
  }
  if (reasons.length || !url || !expectedSha || !caseId || !out) return { kind: 'hold', reasons };
  return { kind: 'ready', config: { base: url, expectedSha, caseId, foreignCaseId: foreign || null, outDir: out, resolved, sessions, human, runId: null } };
}

export const isReady = (l: Loaded): l is { kind: 'ready'; config: Config } => l.kind === 'ready';
