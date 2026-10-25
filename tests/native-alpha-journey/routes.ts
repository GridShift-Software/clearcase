// The journey's route contract: every URL the scenario calls, as a named port. Ports whose routes already exist at the
// base commit (health, intake, original download) or in a prepared worker's accepted-for-integration docs (case pages,
// notes, publication) have defaults. Ports whose routes no prepared document fixes (operator submission read and
// download, private import and preview, recovery export) have NONE: the scenario never invents a route, so a missing
// port is a HOLD. A routes file (`clearcase.native-journey-routes/1`) supplies or overrides ports from the owning
// worker's final doc. No port may point at a test login, an identity double or any other way around Clerk.
import { exactKeys, isPlain } from './common.ts';

export const VARS = ['caseId', 'operationId', 'assetId', 'resultsVersion', 'candidateId'] as const;
export type Var = (typeof VARS)[number];
export type Method = 'GET' | 'HEAD' | 'POST' | 'PUT';
export interface Port {
  method: Method;
  path: string;
  /** which supplied session acts; the scenario fixes it for every port except the export */
  actor?: 'clientA' | 'operatorB';
  /** JSON pointers into the response, by capture name (see REQUIRED_CAPTURES) */
  captures?: Record<string, string>;
  /** the request body's media type for operator.import (default application/zip, the package's accepted transport) */
  contentType?: string;
  /** export only: the response bytes must contain the original PDF's exact bytes (a stored archive or a raw object) */
  containsOriginal?: boolean;
}

export const DEFAULT_PORTS = {
  health: { method: 'GET', path: '/health' },
  signIn: { method: 'GET', path: '/sign-in' },
  'intake.declare': { method: 'POST', path: '/client/intake/{caseId}/submissions' },
  'intake.list': { method: 'GET', path: '/client/intake/{caseId}/submissions' },
  'intake.upload': { method: 'PUT', path: '/client/intake/{caseId}/submissions/{operationId}' },
  'intake.read': { method: 'GET', path: '/client/intake/{caseId}/submissions/{operationId}' },
  'case.page': { method: 'GET', path: '/cases/{caseId}' },
  'case.chronology': { method: 'GET', path: '/cases/{caseId}/views/{resultsVersion}/chronology' },
  'case.notes': { method: 'GET', path: '/cases/{caseId}/notes' },
  'case.notes.add': { method: 'POST', path: '/cases/{caseId}/notes?/add' },
  'case.notes.delete': { method: 'POST', path: '/cases/{caseId}/notes?/delete' },
  'original.get': { method: 'GET', path: '/cases/{caseId}/originals/{assetId}' },
  'publication.signoff': { method: 'POST', path: '/operator/publication/{caseId}/signoffs' },
  'publication.publish': { method: 'POST', path: '/operator/publication/{caseId}/publish' },
} as const satisfies Record<string, Port>;

/** No default exists: no accepted document names the route. */
export const UNRESOLVED_PORTS = ['operator.submission.get', 'operator.submission.download', 'operator.import', 'operator.preview', 'recovery.export'] as const;
export const OPTIONAL_PORTS = ['viewer.pdf'] as const;
export type PortName = keyof typeof DEFAULT_PORTS | (typeof UNRESOLVED_PORTS)[number] | (typeof OPTIONAL_PORTS)[number];
const KNOWN = new Set<string>([...Object.keys(DEFAULT_PORTS), ...UNRESOLVED_PORTS, ...OPTIONAL_PORTS]);

/** What a supplied port must tell the scenario about its response, so that no field is guessed. */
export const REQUIRED_CAPTURES: Partial<Record<PortName, readonly string[]>> = {
  'operator.submission.get': ['files'], // [{path, sha256, size}] of the finalized submission's manifest
  'operator.import': ['candidateId', 'identity', 'newWarnings'], // identity: the nine sign-off identity keys
};
export const IDENTITY_KEYS = ['linkId', 'submissionRevisionId', 'submissionManifestSha256', 'resultsVersion', 'manifestSha256', 'packageInputRevisionId', 'diagnosticsSha256', 'validatorVersion', 'snapshotRevision'] as const;

// A route that bypasses sign-in is refused by name, whoever supplied it.
const BYPASS = /(?:^|[/._-])(?:test|testing|dev|fake|mock|double|stub|bypass|impersonat\w*|become|login-as|session|dev-login|e2e)(?:$|[/._-])/i;
const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

export function portProblems(name: string, port: unknown): string[] {
  const p: string[] = [];
  if (!KNOWN.has(name)) return [`${name}: unknown port`];
  if (!isPlain(port)) return [`${name}: not an object`];
  const extra = Object.keys(port).filter((k) => !['method', 'path', 'actor', 'captures', 'containsOriginal', 'contentType'].includes(k));
  if (extra.length) p.push(`${name}: unknown fields ${extra.join(',')}`);
  if (!['GET', 'HEAD', 'POST', 'PUT'].includes(port.method as string)) p.push(`${name}: method must be GET, HEAD, POST or PUT`);
  const path = port.path;
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('..') || path.includes('#') || /\s/.test(path)) p.push(`${name}: path must be one absolute path of this origin`);
  else {
    const [pathname, query, ...more] = path.split('?');
    if (more.length || (query !== undefined && !/^\/[a-z]+$/.test(query))) p.push(`${name}: only a SvelteKit form action (?/name) may carry a query`);
    for (const m of pathname.matchAll(PLACEHOLDER)) if (!(VARS as readonly string[]).includes(m[1])) p.push(`${name}: unknown placeholder {${m[1]}}`);
    if (/[{}]/.test(pathname.replace(PLACEHOLDER, ''))) p.push(`${name}: malformed placeholder`);
    if (BYPASS.test(pathname.replace(PLACEHOLDER, 'x'))) p.push(`${name}: route name looks like an authentication bypass`);
  }
  if (port.actor !== undefined && port.actor !== 'clientA' && port.actor !== 'operatorB') p.push(`${name}: actor must be clientA or operatorB`);
  if (port.captures !== undefined && (!isPlain(port.captures) || Object.values(port.captures).some((v) => typeof v !== 'string' || !/^(?:\/[^/]*)+$/.test(v)))) p.push(`${name}: captures must map names to JSON pointers`);
  if (port.contentType !== undefined && (typeof port.contentType !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/.test(port.contentType))) p.push(`${name}: contentType must be a media type`);
  if (port.containsOriginal !== undefined && typeof port.containsOriginal !== 'boolean') p.push(`${name}: containsOriginal must be true or false`);
  for (const c of REQUIRED_CAPTURES[name as PortName] ?? []) if (!isPlain(port.captures) || typeof port.captures[c] !== 'string') p.push(`${name}: must declare capture ${c}`);
  if (name === 'recovery.export' && port.actor === undefined) p.push(`${name}: must name its actor`);
  return p;
}

export interface Resolved { ports: Partial<Record<PortName, Port>>; unresolved: PortName[]; problems: string[] }

/** Defaults plus the supplied routes file (parsed JSON, or null when none was supplied). */
export function resolveRoutes(file: unknown): Resolved {
  const problems: string[] = [];
  const ports: Partial<Record<PortName, Port>> = { ...(DEFAULT_PORTS as Record<string, Port>) };
  if (file !== null) {
    if (!isPlain(file) || !exactKeys(file, ['schema', 'ports']) || file.schema !== 'clearcase.native-journey-routes/1' || !isPlain(file.ports)) problems.push('routes file: need exactly {schema: clearcase.native-journey-routes/1, ports}');
    else for (const [name, port] of Object.entries(file.ports)) {
      const bad = portProblems(name, port);
      if (bad.length) problems.push(...bad);
      else ports[name as PortName] = port as unknown as Port;
    }
  }
  const unresolved = UNRESOLVED_PORTS.filter((n) => !ports[n]);
  return { ports, unresolved, problems };
}

/** A path with its placeholders filled; every value is encoded as one segment. A missing value throws: nothing is guessed. */
export function expand(path: string, vars: Partial<Record<Var, string>>): string {
  return path.replace(PLACEHOLDER, (_, v: Var) => {
    const value = vars[v];
    if (value === undefined || value === '') throw new Error(`route needs {${v}}`);
    return encodeURIComponent(value);
  });
}

/** JSON pointer (RFC 6901) lookup; undefined when absent. */
export function pointer(doc: unknown, ptr: string): unknown {
  let cur: unknown = doc;
  for (const raw of ptr.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur) && /^\d+$/.test(key)) cur = cur[Number(key)];
    else if (isPlain(cur) && Object.hasOwn(cur, key)) cur = cur[key];
    else return undefined;
  }
  return cur;
}
