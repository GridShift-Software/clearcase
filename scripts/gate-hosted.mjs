#!/usr/bin/env bun
// `bun run --bun gate:hosted`: the credential-free hosted gate. It proves one exact revision of the hosted artifact the
// way `gate` proves the local app, and stops at the first failure.
//
// Refused before any step runs: an unknown argument, a reduced-run variable (gate.mjs's REDUCED_ENV, even empty), a
// dirty tree, a binding missing from deploy/client/wrangler.toml (DB, BUCKET, ASSETS; every one local, no account_id),
// and a missing tool (the skill's preflight). Then `refusals` (tests/hosted-foundation/gate/refusals.mjs) proves each
// refusal on a throwaway checkout, and one offline network namespace runs the verify-clearcase-hosted lifecycle with
// the gate's checks: build:hosted (hosted-gate, stamped with HEAD), the emitted-artifact scan, GRS-106's probe
// `test:check`, each other hosting probe's check of its committed evidence (PROBE_CHECKS), the storage and notifications
// probes' own cases (PROBE_TESTS), start:hosted, the live doctor
// and its negatives, test:hosted (its smoke legs and the import-boundary negative test), the Chromium drive of the feature
// map, start:hosted --stop. The gate then re-reads every summary the
// run wrote and requires each to be evidence for HEAD, rechecks HEAD and the tree, and writes its own summary, with
// `evidence: true` only when nothing was reduced, stale, skipped or failed; a summary that does not validate fails it.
// The summary names each boundary real or a test double; no run is evidence for Clerk, Cloudflare D1 or R2, or email.
//
// Prints at most 30 lines: the head, one line per step, the tail of the first failure, the boundaries, then
// `GATE PASS <sha>` or `GATE FAIL <step> <sha>`. Logs and evidence: .local/gate-hosted/<sha12>/<run>/ (or
// $CLEARCASE_HOSTED_REPORT_DIR/<run>); scratch under $CLEARCASE_HOSTED_SCRATCH/gate or .local/gate-hosted/scratch.
// The browser drive takes a slot through $CLEARCASE_BROWSER_LOCK when it is set. One hosted gate per worktree
// (.local/gate-hosted/pid); `bun run --bun gate:hosted --stop` stops that group and its server only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gitEnv } from './browser-lock.mjs';
import { REDUCED_ENV } from './gate.mjs';
import { claimPidFile, releasePidFile, stopPidFile } from './pidfile.ts';
import { cleanupRun, FIXTURE_MODULE, hostedRun, LIFECYCLE, preflight, runId } from '../.agents/skills/verify-clearcase-hosted/lib/main.mjs';
import { BUN_PIN, buildFileProblem, driveProblem, healthProblem, innerProblem, keysProblem, PROFILE, stampProblem, testSummaryProblem, DRIVE_STEPS } from '../.agents/skills/verify-clearcase-hosted/lib/evidence.mjs';
import { IDENTITY, WRONG_CLIENT_IDENTITY } from '../.agents/skills/verify-clearcase-hosted/lib/steps.mjs';
import { gateFixture } from '../tests/hosted-foundation/runtime/gate-fixture.ts';

const REPO = resolve(import.meta.dirname, '..');
const OUT = join(REPO, '.local', 'gate-hosted');
const PID_FILE = join(OUT, 'pid');
const LEADER_ENV = 'CLEARCASE_HOSTED_GATE_LEADER';
export const PORTS = { app: 43800, canary: 43899 };
const CONFIG = join('deploy', 'client', 'wrangler.toml');
const MAX_LINES = 30, TAIL_LINES = 12;
const clip = (s) => (s.length > 160 ? `${s.slice(0, 159)}…` : s);

/** Steps whose log is not named after them. */
const LOG_OF = { start: 'server' };

/**
 * What a failed step prints: its cause, then the rest of its error without stack frames, within `room` lines. The cause
 * is the first GATE FAIL, forbidden or problem line of the step's log (build.log, test-hosted.log, ...), else the first
 * line of its error: for a failed build the error ends in Node's frames and the cause is only in the log.
 */
export function failureTail(step, evidence, room) {
	if (room < 1) return [];
	const error = String(step?.error ?? '').split('\n').filter((l) => l.trim() && !/^\s*at /.test(l));
	let log = [];
	try { log = readFileSync(join(evidence, `${LOG_OF[step.name] ?? step.name.replace(/[^\w.-]/g, '-')}.log`), 'utf8').split('\n'); } catch {}
	const cause = log.find((l) => /GATE FAIL|forbidden|problem/i.test(l)) ?? error[0];
	return [...(cause ? [`cause: ${cause.trim()}`] : []), ...error.filter((l) => l !== cause).slice(-TAIL_LINES)].slice(0, room).map(clip);
}

/**
 * Each hosting probe's check of its committed evidence (docs/acceptance/hosting/evidence/<probe>-summary.json), so that
 * drift (an input changed since the run, or a summary that no longer has the probe's shape) fails the gate instead of the
 * page that cites it. They read committed files and git only. A probe's own check command is the row's command, run
 * unchanged from the probe's directory.
 */
const EVIDENCE_DIR = join('docs', 'acceptance', 'hosting', 'evidence');
const probeDir = (probe) => join('tests', 'hosting-probe', probe);
const summaryOf = (probe) => join('..', '..', '..', EVIDENCE_DIR, `${probe}-summary.json`);
const probeCheck = (probe, cmd, cwd, title) => ({ id: `probe-check:${probe}`, at: 'build', title: `${probe} probe evidence: ${title}`, cmd, ...(cwd ? { cwd } : {}) });
export const PROBE_CHECKS = [
	probeCheck('deployment', [process.execPath, 'deploy/probes/summary-check.ts'], null, 'summary-check.ts: an ancestor sourceSha, each input as it was, the page naming it'),
	probeCheck('identity', [process.execPath, 'run', '--bun', 'check:evidence'], probeDir('identity'), 'check:evidence: the inputs\' digest, the route table and the counts'),
	...['storage', 'recovery', 'notifications'].map((probe) => probeCheck(probe, [process.execPath, 'run', '--bun', 'probe', '--check', summaryOf(probe)], probeDir(probe), 'probe --check: its exact shape, an ancestor sourceSha and its inputs as they were')),
];

/**
 * The hosting probes whose cases (`cases.ts`, run by their `test` script) no runner else executes: not the root Vitest, not CI
 * and not a probe's own `--check`. Each row runs `bun run --bun test` in the probe's directory, and a failing case fails the gate.
 */
export const PROBE_TESTS = ['storage', 'notifications'].map((probe) => ({ id: `probe-test:${probe}`, at: 'build', title: `${probe} probe cases: bun run --bun test in ${probeDir(probe)}`, cmd: [process.execPath, 'run', '--bun', 'test'], cwd: probeDir(probe) }));

/** The gate's checks inside the lifecycle: after the build, and against the running server. */
export const CHECKS = [
	{ id: 'artifact', at: 'build', title: 'scripts/ci/hosted-artifact.ts: the emitted modules hold no local-only import and only hosted-gate doubles', cmd: [process.execPath, 'scripts/ci/hosted-artifact.ts', '--profile', PROFILE] },
	{ id: 'probe-check', at: 'build', title: 'GRS-106 probe test:check: every mutation of a passing runtime summary is refused', cmd: [process.execPath, 'run', '--bun', 'test:check'], cwd: join('tests', 'hosting-probe', 'runtime') },
	...PROBE_CHECKS,
	...PROBE_TESTS,
	{ id: 'test:hosted', at: 'server', title: 'test:hosted: request, render, action, feature map, denials, sign-out and the import-boundary negative test on workerd', cmd: [process.execPath, 'run', '--bun', 'test:hosted'], env: { PORT: String(PORTS.app) } },
];
const testSummary = (sha) => join('.local', 'hosted', `test-${sha.slice(0, 12)}-${PROFILE}.json`);
/** Every step a passing run reports, in order. */
export const REQUIRED = ['refusals', 'net-offline', 'build', 'artifact', 'probe-check', ...PROBE_CHECKS.map((c) => c.id), ...PROBE_TESTS.map((c) => c.id), 'start', 'live-doctor', 'live-doctor-negative', 'test:hosted', 'drive', 'stop', 'offline', 'cleanup', 'evidence-kept'];

/** Which boundary each run exercised, real or a test double. A local gate never claims Clerk, Cloudflare or email. */
export const BOUNDARIES = {
	identity: { kind: 'double', what: 'test identity double (sessions in local D1); Clerk is not involved' },
	store: { kind: 'double', what: 'case identity and publication from local D1 fixture tables' },
	assets: { kind: 'double', what: 'originals from local R2, checked whole against the fixture before release' },
	audit: { kind: 'double', what: 'audit events written to local D1' },
	userWork: { kind: 'unavailable', what: 'user work answers unavailable' },
	results: { kind: 'unavailable', what: 'no published results; ResultsState pending' },
	d1: { kind: 'real-local', what: 'Miniflare D1 under wrangler dev --local, not Cloudflare D1' },
	r2: { kind: 'real-local', what: 'Miniflare R2 under wrangler dev --local, not Cloudflare R2' },
	runtime: { kind: 'real', what: 'native workerd, Wrangler hosted by Node, offline' },
	browser: { kind: 'real', what: 'Chromium, loopback origin only' },
};
export const NOT_EVIDENCE_FOR = ['Clerk', 'Cloudflare D1', 'Cloudflare R2', 'email', 'deployment'];

/** The reduced-run variables set in `env` (even empty), as problem lines. */
export const reducedRun = (env) => Object.entries(REDUCED_ENV).filter(([k]) => env[k] !== undefined).map(([k, what]) => `${k} is set (${JSON.stringify(env[k])}): it ${what}, so the run would not be evidence; unset it`);

/** What deploy/client/wrangler.toml lacks for a credential-free run: DB, BUCKET and ASSETS, every one local, no account. */
export function bindingProblems(text) {
	let doc;
	try {
		doc = Bun.TOML.parse(text);
	} catch (e) {
		return [`${CONFIG} does not parse: ${e.message}`];
	}
	const problems = [];
	const d1 = (doc.d1_databases ?? []).find((b) => b.binding === 'DB');
	if (!d1) problems.push(`${CONFIG} binds no D1 database as DB`);
	else if (d1.remote !== false) problems.push(`${CONFIG}: the DB binding is not remote = false`);
	const r2 = (doc.r2_buckets ?? []).find((b) => b.binding === 'BUCKET');
	if (!r2) problems.push(`${CONFIG} binds no R2 bucket as BUCKET`);
	else if (r2.remote !== false) problems.push(`${CONFIG}: the BUCKET binding is not remote = false`);
	if (doc.assets?.binding !== 'ASSETS' || typeof doc.assets?.directory !== 'string') problems.push(`${CONFIG} binds no assets directory as ASSETS`);
	if (/^\s*account_id\s*=/m.test(text)) problems.push(`${CONFIG} names an account_id: the gate runs with no Cloudflare account`);
	return problems;
}

export const SCOPE = 'credential-free local hosted regression: the hosted-gate artifact on local workerd with local D1 and R2 and named test doubles';
const FIXTURE_REL = relative(REPO, FIXTURE_MODULE);
const ARTIFACTS = { refusals: 'refusals.json', testHosted: 'test-hosted.json', drive: 'drive.json', health: 'health.json', screens: 'screens/' };
const text = (v) => typeof v === 'string' && v !== '';
const time = (v) => text(v) && !Number.isNaN(Date.parse(v));

/** Why the gate's own summary is not evidence for `sha`, or null. One expected shape: exact keys, types and values. */
export function gateSummaryProblem(doc, sha) {
	if (doc?.schema !== 'clearcase-hosted-gate/1') return `summary: not a clearcase-hosted-gate/1 summary`;
	if (doc.evidence !== true) return `summary: evidence is ${JSON.stringify(doc.evidence)}, not true`;
	if (doc.ok !== true) return `summary: ok is ${JSON.stringify(doc.ok)}`;
	if (!/^[0-9a-f]{40}$/.test(sha) || doc.sha !== sha) return `summary: for revision ${JSON.stringify(doc.sha)}, not HEAD ${sha}`;
	const shaped = keysProblem('summary', doc, ['schema', 'ok', 'evidence', 'scope', 'sha', 'runId', 'startedAt', 'finishedAt', 'fixture', 'boundaries', 'notEvidenceFor', 'build', 'tools', 'ports', 'reduced', 'skipped', 'steps', 'artifacts'])
		?? stampProblem('summary: the build stamp', doc.build, sha)
		?? keysProblem('summary: fixture', doc.fixture, ['module', 'sha256', 'identity', 'wrongClientIdentity', 'deploymentClient'])
		?? keysProblem('summary: tools', doc.tools, ['bun', 'node', 'wrangler', 'workerd', 'chromium'])
		?? keysProblem('summary: artifacts', doc.artifacts, ['evidence', ...Object.keys(ARTIFACTS)]);
	if (shaped) return shaped;
	if (!Array.isArray(doc.reduced) || doc.reduced.length || !Array.isArray(doc.skipped) || doc.skipped.length) return `summary: reduced ${JSON.stringify(doc.reduced)}, skipped ${JSON.stringify(doc.skipped)}`;
	if (doc.scope !== SCOPE) return `summary: scope is ${JSON.stringify(doc.scope)}, not the local gate's`;
	if (!text(doc.runId) || !time(doc.startedAt) || !time(doc.finishedAt) || Date.parse(doc.finishedAt) < Date.parse(doc.startedAt)) return `summary: runId ${JSON.stringify(doc.runId)}, startedAt or finishedAt is not a run's`;
	const steps = Array.isArray(doc.steps) ? doc.steps : [];
	const stepShape = steps.map((st, i) => keysProblem(`summary: step ${i}`, st, ['name', 'status', 'ms'])).find(Boolean);
	if (stepShape) return stepShape;
	const missing = REQUIRED.filter((n) => !steps.some((st) => st.name === n && st.status === 'PASS'));
	if (missing.length) return `summary: no PASS for ${missing.join(', ')}`;
	if (steps.some((st) => st.status !== 'PASS')) return `summary: steps not PASS: ${steps.filter((st) => st.status !== 'PASS').map((st) => st.name).join(', ')}`;
	if (!isDeepStrictEqual(steps.map((st) => st.name), REQUIRED) || steps.some((st) => typeof st.ms !== 'number')) return `summary: the steps are ${steps.map((st) => st.name).join(', ')}, not ${REQUIRED.join(', ')}`;
	if (!isDeepStrictEqual(doc.boundaries, BOUNDARIES)) return 'summary: boundaries differ from the gate\'s: a local gate run names identity, store, assets and audit doubles, user work and results unavailable, local D1 and R2, and says nothing is real that is not';
	if (!isDeepStrictEqual(doc.notEvidenceFor, NOT_EVIDENCE_FOR)) return `summary: notEvidenceFor must be exactly ${JSON.stringify(NOT_EVIDENCE_FOR)}: a local gate run disclaims Clerk, Cloudflare D1 and R2, email and deployment`;
	if (!isDeepStrictEqual(doc.fixture, { module: FIXTURE_REL, sha256: gateFixture().sha256, identity: IDENTITY, wrongClientIdentity: WRONG_CLIENT_IDENTITY, deploymentClient: 'client-a' })) return `summary: fixture ${JSON.stringify(doc.fixture?.sha256)} is not the committed gate fixture`;
	if (!isDeepStrictEqual(doc.ports, PORTS)) return `summary: ports ${JSON.stringify(doc.ports)}, not ${JSON.stringify(PORTS)}`;
	if (!Object.values(doc.tools).every(text) || doc.tools.bun !== BUN_PIN) return `summary: tools ${JSON.stringify(doc.tools)} name no version or not Bun ${BUN_PIN}`;
	if (!text(doc.artifacts.evidence) || Object.entries(ARTIFACTS).some(([k, v]) => doc.artifacts[k] !== v)) return `summary: artifacts ${JSON.stringify(doc.artifacts)}`;
	return null;
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };

/**
 * After the run: the gate re-reads what the run wrote and judges it itself, so a run that says PASS without evidence
 * for HEAD fails here. Each file is judged against its own expected shape (lib/evidence.mjs), then the files are tied to
 * one another: one build stamp and artifact across build, health, test and inner; one server state and fixture.
 * Returns [step, problem] pairs.
 */
export function evidenceProblems(evidence, sha) {
	const out = [];
	const build = readJson(join(evidence, 'build.json')), health = readJson(join(evidence, 'health.json')), test = readJson(join(evidence, 'test-hosted.json')), inner = readJson(join(evidence, 'inner.json'));
	const b = buildFileProblem(build, sha), h = healthProblem(health, sha, gateFixture().sha256), t = testSummaryProblem(test, sha);
	const i = innerProblem(inner, sha, [...LIFECYCLE, ...CHECKS.map((c) => c.id)]);
	if (b) out.push(['build', b]);
	if (h) out.push(['live-doctor', h]);
	if (t) out.push(['test:hosted', t]);
	const d = driveProblem(readJson(join(evidence, 'drive.json')));
	if (d) out.push(['drive', d]);
	if (i) out.push(['offline', i]);
	const stamp = build?.sidecar?.stamp, artifact = build?.sidecar?.artifact;
	if (!b && !h && !isDeepStrictEqual(health.build, stamp)) out.push(['live-doctor', `health.json: the served build ${health.build.buildId} is not the artifact build.json records (${stamp.buildId})`]);
	if (!b && !t && test.artifact !== artifact) out.push(['test:hosted', `test:hosted: the summary's artifact ${test.artifact} is not the built ${artifact}`]);
	if (!b && !i) {
		const st = inner.state;
		if (!isDeepStrictEqual(inner.stamp, stamp) || st.artifact !== artifact) out.push(['offline', `inner: the run's stamp or served artifact is not build.json's (${artifact})`]);
		if (st.fixtureSha256 !== gateFixture().sha256 || !isDeepStrictEqual(inner.ports, PORTS)) out.push(['offline', `inner: the server ran fixture ${st.fixtureSha256} on ports ${JSON.stringify(inner.ports)}, not the committed gate fixture on ${JSON.stringify(PORTS)}`]);
		if (!h && health.gate.runId !== `clearcase-test-double:hosted-gate/${st.runId}`) out.push(['live-doctor', `health.json answers for run ${health.gate.runId}, not this run's server ${st.runId}`]);
		if (!t && test.base !== st.base) out.push(['test:hosted', `test:hosted ran against ${test.base}, not this run's server ${st.base}`]);
	}
	return out;
}

export const REFUSAL_NAMES = ['dirty-tree', 'reduced-run', 'missing-binding', 'stale-stamp', 'summary-not-evidence', 'failure-tail', 'evidence-walk'];

/** The fewest cases each refusal runs (refusals.mjs): a refusal that ran fewer lost a case. */
export const REFUSAL_MIN = { 'dirty-tree': 3, 'reduced-run': Object.keys(REDUCED_ENV).length + 1, 'missing-binding': 5, 'stale-stamp': 6, 'summary-not-evidence': 21, 'failure-tail': 3, 'evidence-walk': 100 };

/** Why refusals.json (the refusal tests' summary) does not show every refusal PASS for `sha`, or null. */
export function refusalsProblem(doc, sha) {
	const shaped = keysProblem('refusals.json', doc, ['schema', 'sha', 'control', 'refusals']) ?? keysProblem('refusals.json: control', doc.control, ['status', 'got']);
	if (shaped) return shaped;
	if (doc.schema !== 'clearcase-hosted-gate-refusals/1') return `refusals.json: schema ${JSON.stringify(doc.schema)}`;
	if (doc.sha !== sha) return `refusals.json: for revision ${JSON.stringify(doc.sha)}, not HEAD ${sha}`;
	if (doc.control.status !== 'PASS' || !text(doc.control.got)) return 'refusals.json: the unchanged control did not give GATE PASS';
	const list = Array.isArray(doc.refusals) ? doc.refusals : [];
	const refusals = list.map((x, i) => keysProblem(`refusals.json: refusal ${i}`, x, ['name', 'status', 'cases'])).find(Boolean);
	if (refusals) return refusals;
	if (list.map((x) => x.name).join() !== REFUSAL_NAMES.join()) return `refusals.json: the refusals are ${list.map((x) => JSON.stringify(x.name)).join(', ')}, not ${REFUSAL_NAMES.join(', ')}`;
	for (const x of list) {
		const cases = Array.isArray(x.cases) ? x.cases : [];
		const shape = cases.map((c, i) => keysProblem(`refusals.json: ${x.name} case ${i}`, c, ['case', 'status', 'got'])).find(Boolean);
		if (shape) return shape;
		if (x.status !== 'PASS' || cases.length < REFUSAL_MIN[x.name] || cases.some((c) => c.status !== 'PASS' || !text(c.case) || !text(c.got))) return `refusals.json: ${x.name} is not PASS in all of at least ${REFUSAL_MIN[x.name]} cases (${cases.length} ran)`;
	}
	return null;
}

/** The refusal tests (tests/hosted-foundation/gate/refusals.mjs) in a child; their JSON summary must name every refusal PASS. */
export function runRefusals(evidence, sha) {
	const out = join(evidence, 'refusals.json'), log = join(evidence, 'refusals.log');
	const r = spawnSync(process.execPath, ['tests/hosted-foundation/gate/refusals.mjs', '--out', out], { cwd: REPO, encoding: 'utf8', timeout: 300_000 });
	writeFileSync(log, `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error}` : ''}`);
	const doc = readJson(out);
	const bad = refusalsProblem(doc, sha);
	if (r.status !== 0 || bad) return { ok: false, error: `refusal tests exited ${r.status ?? r.signal}; ${bad ?? 'refusals.json is fine'}; see ${relative(REPO, log)}` };
	return { ok: true, evidence: { refusals: doc.refusals.map((x) => `${x.name}: ${x.cases.length} cases`), log: relative(REPO, log) } };
}

/** Reads the full head SHA and tree state (untracked files count). */
export function readHead(repo = REPO) {
	const git = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8', env: gitEnv() });
	const sha = git('rev-parse', 'HEAD'), status = git('status', '--porcelain', '--untracked-files=all');
	if (sha.status !== 0 || status.status !== 0) return { error: `git failed: ${(sha.stderr || status.stderr).trim()}` };
	return { head: { sha: sha.stdout.trim(), dirty: status.stdout !== '', changes: status.stdout.split('\n').filter(Boolean).slice(0, 5) } };
}

const toolVersions = (pre) => ({
	bun: process.versions.bun,
	node: pre.facts.node?.version ?? null,
	wrangler: readJson(join(REPO, 'node_modules', 'wrangler', 'package.json'))?.version ?? null,
	workerd: readJson(join(REPO, 'node_modules', 'workerd', 'package.json'))?.version ?? null,
	chromium: pre.facts.tools?.chromium ?? null,
});

/**
 * The gate. `head` is { sha (full), dirty }. Everything with a side effect is injectable, so the refusal tests drive
 * this function with the real validators and a run that writes chosen evidence. Returns { pass, failed, lines, summary }.
 */
export async function runHostedGate({ head, argv = [], env = process.env, repo = REPO, pre = () => preflight({ port: PORTS }), refusals = runRefusals, hosted = hostedRun, reread = () => readHead(repo), evidenceRoot = env.CLEARCASE_HOSTED_REPORT_DIR ? resolve(env.CLEARCASE_HOSTED_REPORT_DIR) : join(repo, '.local', 'gate-hosted', head.sha.slice(0, 12)), scratchRoot = env.CLEARCASE_HOSTED_SCRATCH ? join(resolve(env.CLEARCASE_HOSTED_SCRATCH), 'gate') : join(repo, '.local', 'gate-hosted', 'scratch'), now = Date.now, log = () => {} }) {
	const sha = head.sha, lines = [`gate:hosted ${sha} ${head.dirty ? 'DIRTY tree' : 'clean tree'}`];
	const fail = (step, problems) => ({ pass: false, failed: step, lines: [...lines, ...problems.map(clip), `GATE FAIL ${step} ${sha}`], summary: null });
	const unknown = argv.filter((a) => a !== '--stop');
	if (unknown.length) return fail('usage', [`unknown argument ${unknown.join(' ')}: gate:hosted takes none (--stop stops a run); nothing reduces or skips it`]);
	const reduced = reducedRun(env);
	if (reduced.length) return fail('env', reduced);
	if (head.dirty) return fail('dirty', [`the tree has uncommitted or untracked files (${head.changes?.join('; ') ?? 'git status'}): commit first, so the artifact is exactly HEAD`]);
	const bindings = bindingProblems(existsSync(join(repo, CONFIG)) ? readFileSync(join(repo, CONFIG), 'utf8') : '');
	if (bindings.length) return fail('bindings', bindings);
	const p = pre();
	if (!p.ok) return fail('preflight', p.problems);

	const id = runId(), evidence = join(evidenceRoot, id), scratch = join(scratchRoot, id), started = new Date(now()).toISOString();
	mkdirSync(evidence, { recursive: true });
	const steps = [];
	const t0 = now();
	const ref = await refusals(evidence, sha);
	steps.push({ name: 'refusals', status: ref.ok ? 'PASS' : 'FAIL', ms: now() - t0, error: ref.error });
	let run = null;
	if (ref.ok) {
		const checks = CHECKS.map((c) => (c.id === 'test:hosted' ? { ...c, summary: testSummary(sha) } : c));
		run = await hosted({ revision: sha, evidence, scratch, port: PORTS, checks, node: p.facts.node, tools: p.facts.tools, lock: p.facts.lock, log });
		for (const s of run.steps) if (!['browser', ...DRIVE_STEPS].includes(s.id)) steps.push({ name: s.id, status: s.status, ms: s.ms, error: s.error });
		const driven = run.steps.filter((s) => [...DRIVE_STEPS].includes(s.id));
		const drive = steps.find((s) => s.name === 'drive');
		const wait = run.steps.find((s) => s.id === 'drive')?.evidence?.slotWaitMs;
		if (drive) drive.detail = `${driven.map((s) => `${s.id} ${s.status}`).join(', ')}${wait ? `; browser slot wait ${Math.round(wait / 1000)}s` : ''}`;
		// The run said what it said; the gate judges the files it wrote.
		for (const [name, problem] of run.ok ? evidenceProblems(evidence, sha) : []) {
			const s = steps.find((x) => x.name === name);
			if (s) Object.assign(s, { status: 'FAIL', error: problem });
			else steps.push({ name, status: 'FAIL', error: problem });
		}
	}
	const after = reread();
	if (after.error || after.head.sha !== sha || after.head.dirty) steps.push({ name: 'head', status: 'FAIL', error: after.error ?? `HEAD or the tree changed during the run (now ${after.head.sha}${after.head.dirty ? ', dirty' : ''}): rerun on a quiet checkout` });
	for (const name of REQUIRED) if (!steps.some((s) => s.name === name)) steps.push({ name, status: 'NOT RUN' });
	const failedStep = steps.find((s) => s.status === 'FAIL') ?? steps.find((s) => s.status !== 'PASS');
	const build = readJson(join(evidence, 'build.json'))?.sidecar?.stamp ?? null;
	const summary = {
		schema: 'clearcase-hosted-gate/1', ok: !failedStep, evidence: !failedStep,
		scope: SCOPE,
		sha, runId: id, startedAt: started, finishedAt: new Date(now()).toISOString(),
		fixture: { module: FIXTURE_REL, sha256: gateFixture().sha256, identity: IDENTITY, wrongClientIdentity: WRONG_CLIENT_IDENTITY, deploymentClient: 'client-a' },
		boundaries: BOUNDARIES, notEvidenceFor: NOT_EVIDENCE_FOR,
		build, tools: toolVersions(p), ports: PORTS,
		reduced: [], skipped: steps.filter((s) => s.status === 'NOT RUN').map((s) => s.name),
		steps: steps.map(({ name, status, ms, error }) => ({ name, status, ms: ms ?? null, ...(error ? { error: String(error).slice(0, 2000) } : {}) })),
		artifacts: { evidence: relative(repo, evidence) || evidence, ...ARTIFACTS },
	};
	const file = join(evidence, 'summary.json');
	writeFileSync(`${file}.tmp`, JSON.stringify(summary, null, 1) + '\n');
	renameSync(`${file}.tmp`, file);
	const bad = !failedStep && gateSummaryProblem(readJson(file), sha);
	if (bad) steps.push({ name: 'summary', status: 'FAIL', error: bad });
	const failed = failedStep?.name ?? (bad ? 'summary' : null);
	for (const s of steps) lines.push(`${s.status === 'NOT RUN' ? 'SKIP' : s.status} ${s.name}${s.ms === undefined || s.ms === null ? '' : ` ${Math.round(s.ms / 1000)}s`}${s.detail ? ` (${s.detail})` : ''}`);
	if (failed) lines.push(...failureTail(steps.find((x) => x.name === failed), evidence, MAX_LINES - lines.length - 4));
	lines.push(`boundaries: ${Object.entries(BOUNDARIES).map(([k, v]) => `${k} ${v.kind}`).join(', ')}`);
	lines.push(`not evidence for: ${NOT_EVIDENCE_FOR.join(', ')}; fixture ${IDENTITY} (sha256 ${gateFixture().sha256.slice(0, 12)})`);
	lines.push(`summary ${relative(repo, file) || file} (evidence: ${!failed})`);
	lines.push(failed ? `GATE FAIL ${failed} ${sha}` : `GATE PASS ${sha}`);
	return { pass: !failed, failed, lines, summary: failed ? null : summary };
}

export function admit(pidFile = PID_FILE) {
	const claim = claimPidFile(pidFile, { marker: { name: LEADER_ENV, value: REPO } });
	if (claim.claimed) return null;
	if (claim.orphan) return `GATE FAIL busy: processes of an earlier hosted gate (group ${claim.orphan}) still run after their leader died; stop them with \`bun run --bun gate:hosted --stop\``;
	if (!claim.owner) return 'GATE FAIL busy: another hosted gate is claiming this worktree right now; try again in a few seconds';
	return `GATE FAIL busy: a hosted gate (pid ${claim.owner.pid}) is already running in this worktree; wait for it, or stop it with \`bun run --bun gate:hosted --stop\``;
}

async function main() {
	const argv = process.argv.slice(2);
	if (argv.includes('--stop')) {
		const { ok, message } = await stopPidFile(PID_FILE, { group: true, graceMs: 15_000, marker: { name: LEADER_ENV, value: REPO } });
		const root = process.env.CLEARCASE_HOSTED_SCRATCH ? join(resolve(process.env.CLEARCASE_HOSTED_SCRATCH), 'gate') : join(OUT, 'scratch');
		const left = existsSync(root) ? readdirSync(root).map((id) => cleanupRun(join(root, id), PORTS.app)) : [];
		const stranded = left.filter((c) => c.survivors.length || !c.removed);
		console.log(`gate:hosted --stop: ${message}; ${left.length} stranded run(s) cleaned${stranded.length ? `, ${stranded.length} with survivors` : ''}`);
		return ok && !stranded.length ? 0 : 1;
	}
	if (process.env[LEADER_ENV] !== REPO) {
		const child = spawn(process.execPath, [import.meta.filename, ...argv], { cwd: REPO, stdio: 'inherit', detached: true, env: { ...process.env, [LEADER_ENV]: REPO } });
		for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { try { process.kill(-child.pid, sig); } catch {} });
		const [code, signal] = await new Promise((res) => child.on('exit', (c, s) => res([c, s])));
		return code ?? (signal ? 1 : 0);
	}
	const refused = admit();
	if (refused) {
		console.log(refused);
		return 1;
	}
	process.on('exit', () => releasePidFile(PID_FILE));
	const { head, error } = readHead();
	if (error) {
		console.log(`GATE FAIL git ${error}`);
		return 1;
	}
	const logFile = join(OUT, 'run.log');
	writeFileSync(logFile, '');
	const { pass, lines } = await runHostedGate({ head, argv, log: (s) => writeFileSync(logFile, s, { flag: 'a' }) });
	console.log(lines.join('\n'));
	return pass ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
