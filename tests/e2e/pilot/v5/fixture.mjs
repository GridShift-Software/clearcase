// The local, case-bearing fixture locator (.local/v5-verification.json, ignored) and everything read from it at run
// time: the v5 main HTML, the extracted case folder, GRS-9's inventory and summary, the literal expected examples
// (pinned by scripts/fixtures/profiles/v5-002.json) and GRS-10's accepted package identities. Committed code holds
// no case values; it only reads these files. Conversion uses GRS-10's converter unchanged (cli.ts convert), which
// parses the data lines of the HTML without executing it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { REPO, sha256File } from './env.mjs';

export const PROFILE = join(REPO, 'scripts', 'fixtures', 'profiles', 'v5-002.json');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const SHA_ID = /^sha256:[0-9a-f]{64}$/;

export class ConfigError extends Error {}

/**
 * Load and check the locator. Refuses (ConfigError) when a required entry is missing, when the main HTML or the
 * expected-examples file differs from its recorded sha256, or when the expected-examples sha256 differs from the
 * committed profile pin.
 */
export async function loadConfig(file = join(REPO, '.local', 'v5-verification.json')) {
	if (!existsSync(file)) throw new ConfigError(`fixture locator ${file} is missing (copy it from the GRS-10 worktree and extend it; see the runner header)`);
	const cfg = readJson(file);
	const need = (cond, what) => { if (!cond) throw new ConfigError(`${file}: ${what}`); };
	need(typeof cfg.caseFolder === 'string' && isAbsolute(cfg.caseFolder) && existsSync(cfg.caseFolder), 'caseFolder must be an existing absolute path');
	need(typeof cfg.caseId === 'string' && cfg.caseId, 'caseId is required');
	need(cfg.mainHtml?.path && /^[0-9a-f]{64}$/.test(cfg.mainHtml?.sha256 ?? ''), 'mainHtml {path, sha256} is required');
	need(cfg.references?.inventory && existsSync(cfg.references.inventory), 'references.inventory must exist');
	need(cfg.expectedExamples?.path && existsSync(cfg.expectedExamples.path) && /^[0-9a-f]{64}$/.test(cfg.expectedExamples?.sha256 ?? ''), 'expectedExamples {path, sha256} is required');
	need(SHA_ID.test(cfg.accepted?.resultsVersion ?? '') && SHA_ID.test(cfg.accepted?.diagnosticsSha256 ?? ''), 'accepted {resultsVersion, diagnosticsSha256} (GRS-10 accepted identities, full values) are required');
	const summaryPath = resolve(REPO, cfg.references.summary ?? 'docs/reference/v5-summary.json');
	const profile = readJson(PROFILE);
	const got = { mainHtml: await sha256File(cfg.mainHtml.path), expected: await sha256File(cfg.expectedExamples.path), inventory: await sha256File(cfg.references.inventory), summary: await sha256File(summaryPath) };
	need(got.mainHtml === cfg.mainHtml.sha256, `main HTML sha256 ${got.mainHtml} differs from the locator`);
	need(cfg.mainHtml.sha256 === profile.mainHtml.sha256, 'main HTML sha256 differs from the committed profile');
	need(cfg.expectedExamples.sha256 === profile.expectedExamplesSha256, `expected-examples sha256 in the locator differs from the profile pin ${profile.expectedExamplesSha256}`);
	need(got.expected === profile.expectedExamplesSha256, `expected-examples file sha256 ${got.expected} differs from the profile pin; refusing to run`);
	const pilot = cfg.pilot ?? {};
	return {
		file, cfg, profile,
		caseFolder: cfg.caseFolder, caseId: cfg.caseId,
		workDir: resolve(REPO, pilot.workDir ?? '.local/v5-lanes-work'),
		packageDir: pilot.packageDir ? resolve(REPO, pilot.packageDir) : null,
		accepted: cfg.accepted,
		summaryPath,
		summary: readJson(summaryPath),
		inventory: readJson(cfg.references.inventory),
		examples: readJson(cfg.expectedExamples.path),
		sha256: { mainHtml: got.mainHtml, expectedExamples: got.expected, inventory: got.inventory, summary: got.summary, archive: cfg.archive?.sha256 ?? null },
	};
}

/** One line per fixture identity, for lane headers. */
export const fixtureLine = (fx) => `fixture: main HTML sha256 ${fx.sha256.mainHtml}; expected-examples sha256 ${fx.sha256.expectedExamples} (profile pin ok); inventory sha256 ${fx.sha256.inventory}; v5-summary sha256 ${fx.sha256.summary}${fx.sha256.archive ? `; archive sha256 ${fx.sha256.archive} (from the locator, not rehashed)` : ''}`;

/** Expected value of an example: its `rewrite` expectation when present, else `source`. */
export const expectOf = (ex) => ex.expect.rewrite ?? ex.expect.source;
export const examplesOfKind = (fx, kind) => fx.examples.examples.filter((e) => e.kind === kind);

/** GRS-10's converter, unchanged: `bun scripts/case-package/cli.ts convert ... --out DIR --report FILE`. */
export function convert({ html, caseFolder, caseId, out, report }) {
	const args = [join(REPO, 'scripts', 'case-package', 'cli.ts'), 'convert', '--html', html, '--case-folder', caseFolder, '--case-id', caseId, '--out', out, '--report', report];
	const t0 = performance.now();
	const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
	const ms = performance.now() - t0;
	return { command: `${process.execPath} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`, exit: r.status, ms, stderr: (r.stderr ?? '').slice(-2000), report: existsSync(report) ? readJson(report) : null };
}

/** GRS-10's validator on an existing package directory. */
export function validate({ pkg, caseFolder, report }) {
	const args = [join(REPO, 'scripts', 'case-package', 'cli.ts'), 'validate', '--package', pkg, '--case-folder', caseFolder, '--report', report];
	const t0 = performance.now();
	const r = spawnSync(process.execPath, args, { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 });
	return { command: `${process.execPath} ${args.join(' ')}`, exit: r.status, ms: performance.now() - t0, stderr: (r.stderr ?? '').slice(-2000), report: existsSync(report) ? readJson(report) : null };
}

/**
 * The v5 package: the locator's pilot.packageDir when its manifest carries the accepted resultsVersion (then
 * validated again for its report), else a fresh conversion into `dir`.
 */
export function v5Package(fx, dir) {
	if (fx.packageDir && existsSync(join(fx.packageDir, 'manifest.json'))) {
		const m = readJson(join(fx.packageDir, 'manifest.json'));
		if (m.resultsVersion === fx.accepted.resultsVersion) {
			const v = validate({ pkg: fx.packageDir, caseFolder: fx.caseFolder, report: `${dir}.validate-report.json` });
			return { dir: fx.packageDir, reused: true, ...v };
		}
	}
	const c = convert({ html: fx.cfg.mainHtml.path, caseFolder: fx.caseFolder, caseId: fx.caseId, out: dir, report: `${dir}.convert-report.json` });
	return { dir, reused: false, ...c };
}

/** Parsed package files used for expectations (the package is the app's input, so this is not the app's output). */
export function readPackage(dir) {
	const ds = (k) => readJson(join(dir, 'datasets', `${k}.json`));
	return { manifest: readJson(join(dir, 'manifest.json')), assets: readJson(join(dir, 'assets.json')).assets, chronology: ds('chronology').data, dataset: ds };
}
