// The journey's command line. This is the only entry that touches the network, and it always uses the real `fetch` and
// the supplied real sessions: there is no flag, variable or import that substitutes a test double.
//   bun tests/native-alpha-journey/run.ts <upload-import | signoff-publish | after-restart | verify>
// Exit codes: 0 PASS (a phase after the human step, or the whole journey) · 1 FAIL · 2 usage · 3 HOLD (a prerequisite is
// missing: nothing was sent) · 4 awaiting the human sign-off (phase 1 finished cleanly). HOLD is never a pass.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomHex, secretLike } from './common.ts';
import { PHASES, loadConfig, type Config, type Phase } from './config.ts';
import { buildFixture } from './fixtures.ts';
import { makeActor } from './http.ts';
import { parseReadback, serializeReadback, type Readback } from './readback.ts';
import { FILE, parseState, sealReport, serializeReport, verifyJourney, type Files } from './report.ts';
import { afterRestart, signoffPublish, uploadImport, type Ctx, type Obs, type State } from './scenario.ts';

const read = (p: string): string | null => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const repoRoot = path.resolve(import.meta.dirname, '../..');
const out = (o: unknown) => process.stdout.write(`${typeof o === 'string' ? o : JSON.stringify(o, null, 1)}\n`);
function hold(reasons: string[]): never { out({ verdict: 'HOLD', reasons, note: 'nothing was sent; HOLD is not a pass' }); process.exit(3); }

async function main(argv: string[]) {
  const [cmd, ...rest] = argv;
  if (rest.length || (cmd !== 'verify' && !(PHASES as readonly string[]).includes(cmd ?? ''))) { out(`usage: run.ts <${[...PHASES, 'verify'].join(' | ')}> (configuration is the CLEARCASE_JOURNEY_* environment; see docs/acceptance/native-alpha-journey.md)`); process.exit(2); }
  if (cmd === 'verify') return verify();
  const phase = cmd as Phase;
  const loaded = loadConfig(phase, { env: process.env, read, repoRoot, nowMs: Date.now() });
  if (loaded.kind === 'hold') hold(loaded.reasons);
  const cfg = (loaded as { config: Config }).config;
  mkdirSync(cfg.outDir, { recursive: true });
  const at = (n: string) => path.join(cfg.outDir, n);

  let runId = randomHex(6), humanDigest: string | null = null;
  // a new journey starts clean: no state, readback or report of an earlier run can be mistaken for this one's
  if (phase === 'upload-import') for (const n of [FILE.state, FILE.readback, FILE.after, ...PHASES.map(FILE.report)]) rmSync(at(n), { force: true });
  if (phase !== 'upload-import') {
    const text = read(at(FILE.state));
    const st = text === null ? null : parseState(text);
    if (!st || !st.ok) hold([`${FILE.state} is missing or invalid in CLEARCASE_JOURNEY_OUT: run upload-import first (${st && !st.ok ? st.problems.join('; ') : 'no file'})`]);
    const state = (st as { state: State }).state;
    if (state.deployedSha !== cfg.expectedSha || state.caseId !== cfg.caseId) hold(['the phase 1 state is for another commit or case']);
    runId = state.runId;
    if (phase === 'signoff-publish') {
      humanDigest = cfg.human!.identitySha256;
      if (humanDigest !== state.identityDigest) hold(['CLEARCASE_JOURNEY_HUMAN_SIGNOFF_IDENTITY_SHA256 does not match the candidate identity phase 1 recorded: the human must review and confirm this exact candidate']);
    }
  }
  const fixture = await buildFixture(runId);
  const who = (n: string, k: keyof Config['sessions'] | null) => makeActor(n, cfg.base, k ? cfg.sessions[k] ?? null : null, fetch);
  const ctx: Ctx = {
    plan: { origin: cfg.base.origin, expectedSha: cfg.expectedSha, caseId: cfg.caseId, foreignCaseId: cfg.foreignCaseId, ports: cfg.resolved.ports },
    actors: { anon: who('anon', null), clientA: who('clientA', 'clientA'), operatorB: who('operatorB', 'operatorB'), otherClient: who('otherClient', 'otherClient'), revoked: who('revoked', 'revoked'), reviewer: cfg.sessions.reviewer ? who('reviewer', 'reviewer') : null },
    fixture, newId: () => `op-${randomHex(10)}`,
  };

  let obs: Obs[], readbackDigest: string | null = null, verdictIfClean: 'PASS' | 'AWAITING-HUMAN-SIGNOFF' = 'PASS';
  if (phase === 'upload-import') {
    const r = await uploadImport(ctx);
    obs = r.obs;
    verdictIfClean = 'AWAITING-HUMAN-SIGNOFF';
    if (r.state) {
      writeFileSync(at(FILE.state), `${JSON.stringify(r.state, null, 1)}\n`, { mode: 0o600 });
      out({ review: 'a human must review this private candidate (its preview and this identity), then confirm it for phase 2', candidateId: r.state.candidateId, identity: r.state.identity, newWarnings: r.state.newWarnings, CLEARCASE_JOURNEY_HUMAN_SIGNOFF_IDENTITY_SHA256: r.state.identityDigest });
    }
  } else if (phase === 'signoff-publish') {
    const state = (parseState(read(at(FILE.state))!) as { state: State }).state;
    const r = await signoffPublish(ctx, state, { reviewerRef: cfg.human!.reviewerRef });
    obs = r.obs;
    if (r.readback) { writeFileSync(at(FILE.readback), serializeReadback(r.readback), { mode: 0o600 }); readbackDigest = r.readback.digest; }
  } else {
    const parsed = read(at(FILE.readback));
    const before = parsed === null ? null : parseReadback(parsed);
    if (!before || !before.ok) hold([`${FILE.readback} is missing or invalid: run signoff-publish first`]);
    const r = await afterRestart(ctx, (before as { readback: Readback }).readback);
    obs = r.obs;
    if (r.readback) { writeFileSync(at(FILE.after), serializeReadback(r.readback), { mode: 0o600 }); readbackDigest = r.readback.digest; }
  }
  const report = sealReport({ phase, deployedSha: cfg.expectedSha, host: cfg.base.hostname, caseId: cfg.caseId, runId, observations: obs, readbackDigest, humanIdentitySha256: humanDigest, reviewerRef: cfg.human?.reviewerRef ?? null, verdictIfClean });
  const text = serializeReport(report);
  if (secretLike(text)) { out('REFUSED: the report contains secret-like text and was not written'); process.exit(1); }
  writeFileSync(at(FILE.report(phase)), text, { mode: 0o600 });
  const bad = obs.filter((o) => !o.ok);
  out({ phase, verdict: report.verdict, deployedSha: cfg.expectedSha, checks: obs.length, failed: bad.map((o) => `${o.id}: ${o.detail}`), notChecked: report.notChecked, report: at(FILE.report(phase)) });
  process.exit(report.verdict === 'PASS' ? 0 : report.verdict === 'AWAITING-HUMAN-SIGNOFF' ? 4 : 1);
}

function verify() {
  const sha = process.env.CLEARCASE_JOURNEY_EXPECTED_SHA, dir = process.env.CLEARCASE_JOURNEY_OUT;
  if (!sha || !/^[0-9a-f]{40}$/.test(sha) || !dir || !path.isAbsolute(dir)) hold(['CLEARCASE_JOURNEY_EXPECTED_SHA (40 hex) and CLEARCASE_JOURNEY_OUT (absolute) are required']);
  const files: Files = {};
  for (const n of [FILE.state, FILE.readback, FILE.after, ...PHASES.map(FILE.report)]) files[n] = read(path.join(dir!, n));
  const v = verifyJourney(files, sha!);
  if (v.kind === 'hold') hold(v.reasons);
  if (v.kind === 'fail') { out({ verdict: 'FAIL', reasons: v.reasons }); process.exit(1); }
  out(`JOURNEY PASS ${v.sha} evidence ${v.digest}`);
  process.exit(0);
}

main(process.argv.slice(2)).catch((e) => { out(`FAIL: ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
