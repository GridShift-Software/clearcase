// The per-phase report and the final verdict. A report is canonical JSON sealed with its own digest and refused whole
// if any text in it looks like a secret. `verifyJourney` accepts a journey only when all three phase reports and both
// readbacks are present, parse exactly, name one commit, one case and one run, and agree with each other.
import { PART, SHA, SHA1, canon, exactKeys, isPlain, secretLike, sha256Hex } from './common.ts';
import type { Obs, State } from './scenario.ts';
import { STATE_SCHEMA } from './scenario.ts';
import { compareReadbacks, parseReadback, type Readback } from './readback.ts';
import { PHASES, type Phase } from './config.ts';

export const REPORT_SCHEMA = 'clearcase.native-journey-report/1';
export type Verdict = 'PASS' | 'FAIL' | 'AWAITING-HUMAN-SIGNOFF';
export interface Report {
  schema: typeof REPORT_SCHEMA; phase: Phase; verdict: Verdict; deployedSha: string; host: string; caseId: string; runId: string;
  observations: Obs[]; notChecked: string[]; readbackDigest: string | null; humanIdentitySha256: string | null; reviewerRef: string | null; digest: string;
}
const KEYS = ['schema', 'phase', 'verdict', 'deployedSha', 'host', 'caseId', 'runId', 'observations', 'notChecked', 'readbackDigest', 'humanIdentitySha256', 'reviewerRef', 'digest'];

export function sealReport(b: Omit<Report, 'digest' | 'schema' | 'notChecked' | 'verdict'> & { verdictIfClean: Verdict }): Report {
  const { verdictIfClean, ...rest } = b;
  const failed = rest.observations.some((o) => !o.ok);
  const body = { ...rest, schema: REPORT_SCHEMA as typeof REPORT_SCHEMA, verdict: (failed ? 'FAIL' : verdictIfClean) as Verdict, notChecked: rest.observations.filter((o) => o.detail.startsWith('NOT CHECKED')).map((o) => o.id) };
  return { ...body, digest: sha256Hex(canon(body)) };
}
export const serializeReport = (r: Report): string => `${canon(r)}\n`;

export type ParsedReport = { ok: true; report: Report } | { ok: false; problems: string[] };
export function parseReport(text: string): ParsedReport {
  if (secretLike(text)) return { ok: false, problems: ['the report contains secret-like text'] };
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, problems: ['not JSON'] }; }
  if (!isPlain(v) || !exactKeys(v, KEYS)) return { ok: false, problems: ['the report must have exactly the report keys'] };
  const p: string[] = [];
  if (v.schema !== REPORT_SCHEMA) p.push('schema');
  if (!(PHASES as readonly unknown[]).includes(v.phase)) p.push('phase');
  if (v.verdict !== 'PASS' && v.verdict !== 'FAIL' && v.verdict !== 'AWAITING-HUMAN-SIGNOFF') p.push('verdict');
  if (typeof v.deployedSha !== 'string' || !SHA1.test(v.deployedSha)) p.push('deployedSha');
  if (typeof v.host !== 'string' || !/^[a-z0-9.-]+$/.test(v.host)) p.push('host');
  if (typeof v.caseId !== 'string' || !PART.test(v.caseId)) p.push('caseId');
  if (typeof v.runId !== 'string' || !/^[0-9a-f]{12}$/.test(v.runId)) p.push('runId');
  if (!Array.isArray(v.observations) || v.observations.length === 0 || !v.observations.every((o) => isPlain(o) && exactKeys(o, ['id', 'ok', 'status', 'detail']) && typeof o.id === 'string' && typeof o.ok === 'boolean' && (o.status === null || Number.isInteger(o.status)) && typeof o.detail === 'string')) p.push('observations');
  if (!Array.isArray(v.notChecked) || !v.notChecked.every((x) => typeof x === 'string')) p.push('notChecked');
  if (v.readbackDigest !== null && !(typeof v.readbackDigest === 'string' && SHA.test(v.readbackDigest))) p.push('readbackDigest');
  if (v.humanIdentitySha256 !== null && !(typeof v.humanIdentitySha256 === 'string' && SHA.test(v.humanIdentitySha256))) p.push('humanIdentitySha256');
  if (v.reviewerRef !== null && typeof v.reviewerRef !== 'string') p.push('reviewerRef');
  if (typeof v.digest !== 'string' || !SHA.test(v.digest)) p.push('digest');
  if (p.length) return { ok: false, problems: p.map((x) => `invalid ${x}`) };
  const { digest, ...body } = v as Record<string, unknown>;
  if (sha256Hex(canon(body)) !== digest) return { ok: false, problems: ['the digest does not seal the report'] };
  if (text !== `${canon(v)}\n`) return { ok: false, problems: ['the report is not in canonical form'] };
  const r = v as unknown as Report;
  // a verdict must follow from its observations: a hand-edited PASS over a failed check is refused
  const failed = r.observations.some((o) => !o.ok);
  if (failed && r.verdict !== 'FAIL') return { ok: false, problems: ['the verdict is not FAIL although an observation failed'] };
  if (!failed && r.verdict === 'FAIL') return { ok: false, problems: ['the verdict is FAIL although no observation failed'] };
  return { ok: true, report: r };
}

export function parseState(text: string): { ok: true; state: State } | { ok: false; problems: string[] } {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { ok: false, problems: ['not JSON'] }; }
  const keys = ['schema', 'runId', 'deployedSha', 'caseId', 'operationId', 'assetId', 'resultsVersion', 'candidateId', 'identity', 'identityDigest', 'newWarnings'];
  if (!isPlain(v) || !exactKeys(v, keys) || v.schema !== STATE_SCHEMA) return { ok: false, problems: ['the state must have exactly the state keys'] };
  const ok = typeof v.runId === 'string' && /^[0-9a-f]{12}$/.test(v.runId) && typeof v.deployedSha === 'string' && SHA1.test(v.deployedSha) && typeof v.caseId === 'string' && PART.test(v.caseId)
    && typeof v.operationId === 'string' && typeof v.assetId === 'string' && PART.test(v.assetId) && typeof v.resultsVersion === 'string' && /^sha256:[0-9a-f]{64}$/.test(v.resultsVersion)
    && typeof v.candidateId === 'string' && PART.test(v.candidateId) && isPlain(v.identity) && Object.values(v.identity).every((x) => typeof x === 'string')
    && typeof v.identityDigest === 'string' && SHA.test(v.identityDigest) && Array.isArray(v.newWarnings) && v.newWarnings.every((x) => typeof x === 'string');
  if (!ok) return { ok: false, problems: ['the state has an invalid field'] };
  if (sha256Hex(canon({ candidateId: v.candidateId, identity: v.identity })) !== v.identityDigest) return { ok: false, problems: ['the identity digest does not match the candidate identity'] };
  return { ok: true, state: v as unknown as State };
}

export interface Files { [name: string]: string | null }
export const FILE = { state: 'state.json', readback: 'readback.json', after: 'readback-after-restart.json', report: (p: Phase) => `report-${p}.json` } as const;
export type Verified = { kind: 'pass'; sha: string; digest: string } | { kind: 'hold'; reasons: string[] } | { kind: 'fail'; reasons: string[] };

/** The journey's final verdict from the files the three phases left. Pure: the caller reads the files. */
export function verifyJourney(files: Files, expectedSha: string): Verified {
  const missing = [FILE.state, FILE.readback, FILE.after, ...PHASES.map(FILE.report)].filter((n) => files[n] === null || files[n] === undefined);
  if (missing.length) return { kind: 'hold', reasons: [`not yet produced: ${missing.join(', ')}`] };
  const why: string[] = [];
  const reports = new Map<Phase, Report>();
  for (const p of PHASES) {
    const r = parseReport(files[FILE.report(p)]!);
    if (!r.ok) why.push(`${FILE.report(p)}: ${r.problems.join('; ')}`); else reports.set(p, r.report);
  }
  const st = parseState(files[FILE.state]!);
  if (!st.ok) why.push(`${FILE.state}: ${st.problems.join('; ')}`);
  const rb = parseReadback(files[FILE.readback]!), ra = parseReadback(files[FILE.after]!);
  if (!rb.ok) why.push(`${FILE.readback}: ${rb.problems.join('; ')}`);
  if (!ra.ok) why.push(`${FILE.after}: ${ra.problems.join('; ')}`);
  if (why.length) return { kind: 'fail', reasons: why };
  const [r1, r2, r3] = PHASES.map((p) => reports.get(p)!), state = (st as { state: State }).state;
  if (r1.verdict !== 'AWAITING-HUMAN-SIGNOFF') why.push('phase 1 did not end awaiting the human sign-off');
  if (r2.verdict !== 'PASS') why.push('phase 2 is not PASS');
  if (r3.verdict !== 'PASS') why.push('phase 3 is not PASS');
  for (const r of [r1, r2, r3]) {
    if (r.deployedSha !== expectedSha) why.push(`${r.phase} names another commit than the expected one`);
    if (r.caseId !== state.caseId || r.runId !== state.runId) why.push(`${r.phase} names another case or run than the phase 1 state`);
    if (r.host !== r1.host) why.push(`${r.phase} ran against another host`);
  }
  if (state.deployedSha !== expectedSha) why.push('the phase 1 state names another commit');
  if (r2.humanIdentitySha256 !== state.identityDigest) why.push('the human sign-off did not confirm the candidate identity phase 1 recorded');
  if (!r2.reviewerRef) why.push('phase 2 names no human reviewer');
  const b = (rb as { readback: Readback }).readback, a = (ra as { readback: Readback }).readback;
  if (r2.readbackDigest !== b.digest) why.push('the phase 2 report does not seal the phase 2 readback');
  if (r3.readbackDigest !== a.digest) why.push('the phase 3 report does not seal the phase 3 readback');
  if (b.deployedSha !== expectedSha || a.deployedSha !== expectedSha) why.push('a readback names another commit');
  if (b.resultsVersion !== state.resultsVersion) why.push('the readback is not of the imported results version');
  if (b.publication.kind !== 'published' || a.publication.kind !== 'published') why.push('a readback does not show the version published');
  if (!b.notes.length) why.push('the readback holds no note');
  const diff = compareReadbacks(b, a, { exportMustMatch: false });
  if (diff.length) why.push(`the facts differ after the restart: ${diff.join(', ')}`);
  if (b.exportSha256 === null || a.exportSha256 === null) why.push('an export is missing from a readback');
  return why.length ? { kind: 'fail', reasons: why } : { kind: 'pass', sha: expectedSha, digest: sha256Hex(canon([r1.digest, r2.digest, r3.digest, b.digest, a.digest])) };
}
