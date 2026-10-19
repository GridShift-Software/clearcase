// Shared by refusals.mjs and mutations.mjs: the evidence a passing hosted run writes, shaped as a real run shapes it
// (the key sets of .local/gate-hosted/<sha12>/<run>/*.json), and a gate run that writes it. Synthetic values only.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REFUSAL_MIN, REFUSAL_NAMES, REQUIRED, runHostedGate } from '../../../scripts/gate-hosted.mjs';
import { DRIVE_STEPS, featureOf, TEST_LEGS } from '../../../.agents/skills/verify-clearcase-hosted/lib/evidence.mjs';
import { gateFixture } from '../runtime/gate-fixture.ts';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');
export const SHA = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
export const PARENT = spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).stdout.trim();

const ARTIFACT = `sha256:${'a'.repeat(64)}`;
const RUN = 'run-2026-01-01T00-00-00-000Z';
const stamp = { revision: SHA, dirty: false, exported: false, builtAt: '2026-01-01T00:00:00.000Z', bun: '1.4.2', buildId: `${SHA.slice(0, 12)}-hosted-gate-1767225600000`, target: 'cloudflare', profile: 'hosted-gate' };
const state = { schema: 'clearcase.hosted-server/1', pid: 4242, port: 43800, base: 'http://127.0.0.1:43800', revision: SHA, profile: 'hosted-gate', artifact: ARTIFACT, runDir: `.local/hosted/${RUN}`, persist: `.local/hosted/${RUN}/persist`, runId: RUN, fixtureSha256: gateFixture().sha256, node: '24.0.0', startedAt: '2026-01-01T00:00:05.000Z' };
/** The inner run's steps in the order a real run records them: REQUIRED without the gate's own steps, the drive's steps before `drive`. */
const INNER_ORDER = REQUIRED.filter((id) => !['refusals', 'offline', 'cleanup', 'evidence-kept'].includes(id)).flatMap((id) => (id === 'drive' ? ['browser', ...DRIVE_STEPS, id] : [id]));
const driveResult = (id, i) => ({ id, feature: featureOf(id), title: `${id} (synthetic)`, status: 'PASS', ms: 10 + i, evidence: id === 'no-egress' ? { canaryHits: 0, backgroundHits: [], requests: 3, origins: ['http://127.0.0.1:43800'], consoleErrors: [] } : { shot: `screens/${i}.png` } });

/** The files a passing run writes into its evidence directory. */
export const validEvidence = () => ({
	'build.json': { sidecar: { schema: 'clearcase.hosted-build/1', stamp: { ...stamp }, artifact: ARTIFACT }, version: { version: SHA } },
	'health.json': { ok: true, runtime: 'Cloudflare-Workers', build: { ...stamp }, buildError: null, gate: { runId: `clearcase-test-double:hosted-gate/${RUN}`, fixtureSha256: gateFixture().sha256 }, probe: { ok: true, bindings: { DB: true, BUCKET: true, ASSETS: true }, probes: { d1: true, r2: true } }, identityProvider: 'test-identity-double' },
	'test-hosted.json': { schema: 'clearcase.hosted-test/1', revision: SHA, profile: 'hosted-gate', artifact: ARTIFACT, base: 'http://127.0.0.1:43800', runtime: 'workerd via wrangler dev --local', node: '24.0.0', bun: '1.4.2', pass: true, legs: TEST_LEGS.map((name) => ({ name, status: 'PASS', asserted: [`${name} asserted`, `${name} asserted again`] })), at: '2026-01-01T00:00:30.000Z' },
	'drive.json': { ok: true, partial: false, startedAt: 1767225640000, results: ['browser', ...DRIVE_STEPS].map(driveResult) },
	'inner.json': {
		ok: true, partial: false, revision: SHA, ports: { app: 43800, canary: 43899 }, stamp: { ...stamp }, state: { ...state },
		results: INNER_ORDER.map((id, i) => (['browser', ...DRIVE_STEPS].includes(id) ? { ...driveResult(id, i), drive: true } : { id, title: `${id} (synthetic)`, status: 'PASS', ms: 1, evidence: {} })),
	},
});

/** refusals.json as refusals.mjs writes it, with the fewest cases per refusal. */
export const validRefusals = () => ({
	schema: 'clearcase-hosted-gate-refusals/1', sha: SHA, control: { status: 'PASS', got: `GATE PASS ${SHA}` },
	refusals: REFUSAL_NAMES.map((name) => ({ name, status: 'PASS', cases: Array.from({ length: REFUSAL_MIN[name] }, (_, i) => ({ case: `${name} ${i}`, status: 'PASS', got: `GATE FAIL ${name} ${i}` })) })),
});

/** Which step of the gate each evidence file is judged under. */
export const FILE_STEP = { 'build.json': 'build', 'health.json': 'live-doctor', 'test-hosted.json': 'test:hosted', 'drive.json': 'drive', 'inner.json': 'offline' };

/** Runs the gate's own runHostedGate with the real validators and a run that writes `validEvidence()` after `edit`. */
export async function gateWith(edit = () => {}, scratch = tmpdir()) {
	const root = mkdtempSync(join(scratch, 'run-'));
	const files = validEvidence();
	edit(files);
	return runHostedGate({
		head: { sha: SHA, dirty: false }, env: {}, repo: REPO,
		pre: () => ({ ok: true, problems: [], facts: { node: { version: '24.0.0' }, tools: { chromium: 'refusal-test' }, lock: null } }),
		refusals: async () => ({ ok: true }),
		async hosted({ evidence }) {
			for (const [f, doc] of Object.entries(files)) if (doc !== undefined) { mkdirSync(dirname(join(evidence, f)), { recursive: true }); writeFileSync(join(evidence, f), JSON.stringify(doc)); }
			const results = files['inner.json']?.results;
			const steps = [...(Array.isArray(results) ? results.filter((r) => r !== null && typeof r === 'object') : []), ...['offline', 'cleanup', 'evidence-kept'].map((id) => ({ id, status: 'PASS', ms: 1 }))];
			return { ok: true, steps, inner: files['inner.json'] };
		},
		reread: () => ({ head: { sha: SHA, dirty: false } }),
		evidenceRoot: join(root, 'evidence'), scratchRoot: join(root, 'scratch'),
	});
}
