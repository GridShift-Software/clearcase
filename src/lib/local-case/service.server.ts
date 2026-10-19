import { createHash } from 'node:crypto';
import { mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
	acceptedWarnings, canActivate, importCandidate, newWarningFingerprints, VALIDATOR_VERSION, verifyCandidateBytes,
	type Acknowledgement, type ActivationReason, type Diagnostic, type ImportResult, type Progress,
} from '../case-package/index.ts';
import { diagnosticsDigest } from '../case-package/diagnostics.ts';
import { now as clock } from '../components/clock.ts';
import type { LocalCaseConfig } from './config.server.ts';
import { isBusy, Storage } from './db.server.ts';
import { procFdAvailable, within } from './fsafe.server.ts';
import { project, readModelDigest } from './project.server.ts';
import { CasePackError, ConversionRefused, prepareCasePack, type PackProgress } from './case-pack.server.ts';
import { versionPath, type CaseSummary } from './model.ts';
import { CaseStore, type CaseVersionRow, type Verification } from './store.server.ts';
import { UserWork } from './user-work.server.ts';

export type AppCode = 'APP_INPUT_INVALID' | 'APP_CONVERSION_REFUSED' | 'APP_CASE_FOLDER_OVERLAPS_DATA' | 'APP_VERSION_CONFLICT' | 'APP_VERSION_RETIRED' | 'APP_CASE_FOLDER_DIFFERS' | 'APP_ORIGINALS_CHANGED' | 'APP_UNLISTED_IGNORED';
export interface AppDiagnostic { code: AppCode; severity: 'error' | 'info'; message: string; hint: string }

export const IMPORT_REPORT = 'clearcase.pilot.import-report/1';
export interface ImportReport {
	report: typeof IMPORT_REPORT;
	verdict: 'accept' | 'report' | 'reject';
	caseId: string | null;
	caseLabel: string | null;
	resultsVersion: string | null;
	manifestSha256: string | null;
	diagnosticsSha256: string;
	validatorVersion: string;
	counts: Record<string, number>;
	warningFingerprints: string[];
	errorFingerprints: string[];
	newWarnings: string[];
	diagnostics: Diagnostic[];
	app: AppDiagnostic[];
	ms: number;
}

export type ImportOutcome = { kind: 'stored' | 'rejected' | 'identical' | 'repaired'; importId: number };
export interface AckInput { resultsVersion: string; manifestSha256: string; diagnosticsSha256: string; validatorVersion: string; warningFingerprints: string[]; acknowledgedBy?: string }
export type ActivationKind = 'activate' | 'rollback' | 'recovery';
export type ActivationRefusal = { message: string; reasons?: ActivationReason[] };

export type CaseRecovery = { caseId: string; configured: string; effective: string | null; reason: string; at: string };
export interface StartupReport { at: string; ms: number; cleaned: string[]; pruned: string[]; checked: Record<string, Verification>; pruneError: string | null }

const now = () => clock().toISOString();

export class LocalCase {
	readonly storage: Storage;
	readonly store: CaseStore;
	readonly userWork: UserWork;
	storageError: string | null = null;
	retryAt: number | null = null;
	readonly cases = new Map<string, CaseRecovery>();
	readonly warnings = new Map<string, string>();
	startupReport: StartupReport | null = null;
	#verified = new Map<string, Verification>();
	#verifiedAt: string | null = null;
	#current: { packageSource: string; startedAt: string; progress: Progress | PackProgress | null; abort: AbortController } | null = null;
	#queue: Promise<unknown> = Promise.resolve();
	#backupTimer: ReturnType<typeof setTimeout> | null = null;
	#retrying: Promise<void> | null = null;

	readonly config: LocalCaseConfig;

	constructor(config: LocalCaseConfig) {
		this.config = config;
		this.storage = new Storage(config.dataDir);
		this.store = new CaseStore(this.storage);
		this.userWork = new UserWork(this.storage, this.store, () => this.scheduleUserWorkBackup());
	}


	async startup(): Promise<void> {
		const t0 = performance.now();
		const cleaned: string[] = [], pruned: string[] = [], checked: Record<string, Verification> = {};
		let pruneError: string | null = null;
		this.storageError = null;
		this.retryAt = null;
		this.cases.clear();
		try {
			if (!procFdAvailable()) throw new Error('/proc/self/fd is not available; ClearCase needs Linux procfs to open originals safely');
			mkdirSync(this.storage.backupDir, { recursive: true, mode: 0o700 });
			for (const n of readdirSync(this.storage.backupDir)) if (n.startsWith('.tmp-')) { rmSync(path.join(this.storage.backupDir, n), { force: true }); cleaned.push(path.join('backups', n)); }
			rmSync(this.serveTmpDir, { recursive: true, force: true });
			this.storage.db();
			for (const s of ['main', 'work'] as const) {
				const r = this.storage.quickCheck(s);
				if (r !== 'ok') throw new Error(`${s === 'main' ? 'results.sqlite' : 'work.sqlite'} failed PRAGMA quick_check: ${r}`);
			}
			const pointers = this.store.activePointers();
			if (this.storage.workCreatedAtOpen && this.store.listImports().some((i) => i.outcome === 'stored'))
				this.warnings.set('work-missing', `work.sqlite (user work, the active pointer and the activation log) was missing when ClearCase started and has been created empty. If that was not intended, stop ClearCase, copy the newest ${path.join(this.storage.backupDir, 'work-*.sqlite')} to work.sqlite (with no work.sqlite-journal, -wal or -shm next to it) and start it again.`);
			for (const p of pointers) {
				const v = this.verify(p.version_id, true);
				checked[p.version_id] = v;
				const log = this.store.activationLog(p.case_id);
				const last = log[0];
				const ver = v.ok ? this.store.getVersion(p.version_id) : undefined;
				const agrees = !!last && last.version_id === p.version_id && !!ver && ver.manifest_sha256 === last.manifest_sha256 && ver.read_model_sha256 === last.read_model_sha256;
				if (v.ok && agrees) continue;
				const reason = !v.ok ? (v.reason ?? 'verification failed')
					: `the active pointer (${p.version_id}) differs from the activation log (last activation: ${last ? `${last.version_id}, ${last.kind} at ${last.at}` : 'none'}); it was changed outside ClearCase`;
				let effective: string | null = null;
				for (const e of log) {
					if (e.version_id === p.version_id && !v.ok) continue;
					const ev = this.store.getVersion(e.version_id);
					if (!ev || ev.manifest_sha256 !== e.manifest_sha256 || ev.read_model_sha256 !== e.read_model_sha256) { checked[e.version_id] ??= { ok: false, reason: 'differs from activation record', ms: 0 }; continue; }
					const r = (checked[e.version_id] = this.verify(e.version_id, true));
					if (r.ok) { effective = e.version_id; break; }
				}
				if (effective === p.version_id && v.ok) effective = null;
				this.cases.set(p.case_id, { caseId: p.case_id, configured: p.version_id, effective, reason, at: now() });
				console.error(`RECOVERY case ${p.case_id}: active ${p.version_id}: ${reason}; ${effective ? `showing ${effective}, the newest verified activation` : 'no verified activation to fall back to'}`);
			}
			try { pruned.push(...(await this.store.pruneCandidates(this.config.keepCandidates))); }
			catch (e) { pruneError = String((e as Error).message ?? e); console.error('retention skipped at startup:', pruneError); }
		} catch (e) {
			this.storageError = String((e as Error).message ?? e);
			if (isBusy(e)) this.retryAt = Date.now() + 2000;
			console.error(`STORAGE UNAVAILABLE at startup${this.retryAt ? ' (locked by another process; will retry)' : ''}:`, e);
		}
		this.startupReport = { at: now(), ms: Math.round(performance.now() - t0), cleaned, pruned, checked, pruneError };
		console.log(`startup checks: ${JSON.stringify({ ms: this.startupReport.ms, cleaned: cleaned.length, pruned, pruneError, verified: Object.fromEntries(Object.entries(checked).map(([k, v]) => [k, v.ok ? `ok ${v.ms}ms` : v.reason])), recovery: [...this.cases.values()], warnings: [...this.warnings.keys()], storageError: this.storageError })}`);
	}

	async retryStartupIfDue(): Promise<void> {
		if (!this.storageError || this.retryAt === null || Date.now() < this.retryAt) return;
		this.#retrying ??= this.startup().finally(() => { this.#retrying = null; });
		await this.#retrying;
	}

	/**
	 * Verify a version. Cached per process, but dropped as soon as ANOTHER connection commits to either store file, so
	 * rows changed on disk are re-verified on the next request instead of being served until restart.
	 */
	verify(vid: string, force = false): Verification {
		let dv: string | null = null;
		try { dv = this.storage.dataVersion(); } catch {}
		if (dv === null || dv !== this.#verifiedAt) { this.#verified.clear(); this.#verifiedAt = dv; }
		if (!force && this.#verified.has(vid)) return this.#verified.get(vid)!;
		let r: Verification;
		try { r = this.store.verifyVersion(vid); } catch (e) { r = { ok: false, reason: `verification error: ${(e as Error).message}`, ms: 0 }; }
		this.#verified.set(vid, r);
		return r;
	}

	effectiveActive(caseId: string): string | undefined {
		const r = this.cases.get(caseId);
		if (r) return r.effective ?? undefined;
		return this.store.activeVersionId(caseId);
	}
	currentActive(): { caseId: string; vid: string | undefined } | undefined {
		const p = this.store.activePointers()[0];
		return p && { caseId: p.case_id, vid: this.effectiveActive(p.case_id) };
	}
	anyRecovery(): CaseRecovery | undefined { return [...this.cases.values()][0]; }
	listCases(): CaseSummary[] {
		const byCase = new Map<string, CaseVersionRow[]>();
		for (const v of this.store.caseVersions()) byCase.set(v.case_id, [...(byCase.get(v.case_id) ?? []), v]);
		const order = [...new Set([...this.store.activePointers().map((p) => p.case_id), ...byCase.keys()])].filter((id) => byCase.has(id));
		return order.map((caseId) => {
			const rows = byCase.get(caseId)!;
			const recovery = this.cases.get(caseId);
			const effective = this.effectiveActive(caseId);
			const shown = rows.find((r) => r.id === (effective ?? recovery?.configured)) ?? rows[0];
			const status = recovery ? 'recovery' : effective ? 'active' : 'candidate';
			const href = effective ? `${versionPath(effective)}/overview` : recovery ? '/recovery' : `/import/${shown.import_id}`;
			return {
				caseId, caseLabel: shown.case_label, status, versions: rows.length, href,
				version: { id: shown.id, importId: shown.import_id, created: shown.created, storedAt: shown.stored_at, documents: shown.documents },
			};
		});
	}

	trustedFor(caseId: string): Set<string> {
		const active = this.effectiveActive(caseId);
		return new Set([...(active ? this.store.acceptedWarningsOf(active) ?? [] : []), ...this.store.trustedRegister(caseId)]);
	}


	get serveTmpDir() { return path.join(this.config.dataDir, 'serve-tmp'); }
	importProgress() { return this.#current && { packageSource: this.#current.packageSource, startedAt: this.#current.startedAt, progress: this.#current.progress }; }
	cancelImport(): boolean { if (!this.#current) return false; this.#current.abort.abort(); return true; }

	async checkInputs(caseFolder: string, packageSource: string): Promise<{ app: AppDiagnostic[]; caseRoot?: { path: string; dev: string; ino: string } }> {
		const app: AppDiagnostic[] = [];
		const bad = (code: AppCode, message: string, hint: string) => app.push({ code, severity: 'error', message, hint });
		if (!path.isAbsolute(caseFolder)) bad('APP_INPUT_INVALID', 'the case folder must be an absolute path', 'Enter the full path of the folder that holds the originals.');
		if (!path.isAbsolute(packageSource)) bad('APP_INPUT_INVALID', 'the results package must be an absolute path', 'Enter the full path of the package folder or .zip file.');
		if (app.length) return { app };
		const cst = await stat(caseFolder, { bigint: true }).catch(() => null);
		if (!cst?.isDirectory()) bad('APP_INPUT_INVALID', 'the case folder does not exist or is not a folder', 'Check the path of the case folder.');
		const pst = await stat(packageSource).catch(() => null);
		if (!pst || !(pst.isDirectory() || (pst.isFile() && packageSource.toLowerCase().endsWith('.zip')))) bad('APP_INPUT_INVALID', 'the results package is neither a folder nor a .zip file', 'Check the path of the results package.');
		if (app.length) return { app };
		const cfReal = await realpath(caseFolder);
		const dataReal = await realpath(this.config.dataDir).catch(() => path.resolve(this.config.dataDir));
		if (within(dataReal, cfReal) || within(cfReal, dataReal))
			bad('APP_CASE_FOLDER_OVERLAPS_DATA', 'the case folder equals, contains or lies inside the ClearCase data directory', `Choose the folder that holds the originals; ClearCase keeps its own data in ${dataReal}, which may not be part of a case folder.`);
		if (app.length) return { app };
		const rst = await stat(cfReal, { bigint: true });
		return { app, caseRoot: { path: cfReal, dev: String(rst.dev), ino: String(rst.ino) } };
	}

	async importCasePack(source: string, destination: string, caseLabel?: string): Promise<ImportOutcome | { kind: 'failed'; message: string }> {
		if (this.#current) return { kind: 'failed', message: 'Another import is still running. Wait for it to finish or cancel it, then import again.' };
		const abort = new AbortController();
		this.#current = { packageSource: source, startedAt: now(), progress: null, abort };
		const created: string[] = [];
		const t0 = performance.now();
		let keep = false;
		try {
			const onProgress = (p: PackProgress) => { if (this.#current?.abort === abort) this.#current.progress = p; };
			const { caseFolder, packageDir } = await prepareCasePack(source, destination, { signal: abort.signal, onProgress, dataDir: this.config.dataDir, appDir: process.cwd(), caseLabel }, created);
			const r = await this.importPackage(caseFolder, packageDir, abort);
			keep = r.kind !== 'rejected';
			return r;
		} catch (e) {
			if (abort.signal.aborted) return { kind: 'failed', message: 'The import was cancelled. Nothing was imported, and the active case is unchanged.' };
			if (e instanceof ConversionRefused) return this.#recordRefusedConversion(source, e, performance.now() - t0).catch((err) => ({ kind: 'failed' as const, message: `${e.message} The refusal could not be recorded: ${(err as Error).message}` }));
			if (e instanceof CasePackError) return { kind: 'failed', message: e.message };
			console.error('case pack import failed', e);
			return { kind: 'failed', message: `The import failed: ${(e as Error).message}. Nothing was imported, and the active case is unchanged.` };
		} finally {
			if (!keep) for (const p of created.reverse()) await rm(p, { recursive: true, force: true }).catch(() => {});
			if (this.#current?.abort === abort) this.#current = null;
		}
	}

	/**
	 * A workspace HTML the converter refuses is a rejected import with the converter's diagnostics, as a rejected package is,
	 * and the HTML as received is kept under the data directory (owner only, never in Git) for the user to review.
	 */
	async #recordRefusedConversion(source: string, e: ConversionRefused, ms: number): Promise<ImportOutcome> {
		const at = now();
		const dir = path.join(this.config.dataDir, 'refused-inputs');
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const kept = path.join(dir, `${sha256Hex(e.received)}.html`);
		const partial = `${kept}.partial`;
		await writeFile(partial, e.received, { mode: 0o600 });
		await rename(partial, kept);
		const counts: Record<string, number> = {};
		for (const d of e.diagnostics) counts[d.code] = (counts[d.code] ?? 0) + 1;
		const fingerprints = (severity: Diagnostic['severity']) => [...new Set(e.diagnostics.filter((d) => d.severity === severity).map((d) => d.fingerprint))].sort();
		const warningFingerprints = fingerprints('warning');
		const report: ImportReport = {
			report: IMPORT_REPORT, verdict: 'reject', caseId: e.caseId, caseLabel: e.caseLabel, resultsVersion: null, manifestSha256: null,
			diagnosticsSha256: diagnosticsDigest(VALIDATOR_VERSION, e.diagnostics, counts, warningFingerprints), validatorVersion: VALIDATOR_VERSION, counts,
			warningFingerprints, errorFingerprints: fingerprints('error'), newWarnings: [], diagnostics: e.diagnostics,
			app: [{ code: 'APP_CONVERSION_REFUSED', severity: 'error', message: `${e.htmlName} could not be converted, so no results package was made and nothing was imported. The HTML as received is kept privately at ${kept}.`, hint: 'Fix what the diagnostics name, or convert the case another way, then import again. The kept copy stays on this computer.' }],
			ms: Math.round(ms),
		};
		const importId = await this.store.recordRejected({ at, case_folder: e.caseFolder, package_source: source, case_id: e.caseId, results_version: null, manifest_sha256: null, verdict: 'reject', report: JSON.stringify(report) });
		return { kind: 'rejected', importId };
	}

	async importPackage(caseFolder: string, packageSource: string, own?: AbortController): Promise<ImportOutcome> {
		const t0 = performance.now();
		const at = now();
		const reject = (report: ImportReport) => this.store.recordRejected({ at, case_folder: caseFolder, package_source: packageSource, case_id: report.caseId, results_version: report.resultsVersion, manifest_sha256: report.manifestSha256, verdict: 'reject', report: JSON.stringify(report) })
			.then((importId) => ({ kind: 'rejected' as const, importId }));
		const inputs = await this.checkInputs(caseFolder, packageSource);
		if (!inputs.caseRoot) return reject(appOnlyReport(inputs.app, performance.now() - t0));
		if (this.#current && this.#current.abort !== own) return reject(appOnlyReport([{ code: 'APP_INPUT_INVALID', severity: 'error', message: 'another import is still running', hint: 'Wait for it to finish or cancel it, then import again.' }], 0));
		const abort = own ?? new AbortController();
		this.#current = { packageSource, startedAt: at, progress: null, abort };
		try {
			const progress = { signal: abort.signal, onProgress: (p: Progress) => { if (this.#current) this.#current.progress = p; }, concurrency: 4 };
			let result = await importCandidate(packageSource, inputs.caseRoot.path, progress);
			const app: AppDiagnostic[] = [];
			const unlisted = result.diagnostics.filter((d) => d.code === 'PKG_UNLISTED_FILE');
			if (result.candidate && unlisted.length) {
				const snap = new Map([...result.candidate.snapshot()].map(({ path: p, bytes }) => [p, bytes]));
				app.push({ code: 'APP_UNLISTED_IGNORED', severity: 'info', message: `${result.counts.PKG_UNLISTED_FILE ?? unlisted.length} file(s) in the package are not in its manifest and were ignored: ${unlisted.slice(0, 5).map((d) => d.subject).join(', ')}${unlisted.length > 5 ? ', …' : ''}`, hint: 'Nothing of them was read or stored. Remove them from the package, or list them in the manifest, if they belong to it.' });
				result = await importCandidate({ files: snap }, inputs.caseRoot.path, progress);
			}
			const report = toReport(result, app, result.candidate ? this.trustedFor(result.candidate.caseId) : new Set(), performance.now() - t0);
			if (result.verdict === 'reject') return reject(report);
			const c = result.candidate;
			const existing = this.store.getVersion(c.resultsVersion);
			const conflict = (code: AppCode, message: string, hint: string) => reject({ ...report, verdict: 'reject', app: [...report.app, { code, severity: 'error', message, hint }] });
			if (existing && existing.manifest_sha256 !== c.manifestSha256)
				return conflict('APP_VERSION_CONFLICT', `${c.resultsVersion} is already stored (import #${existing.import_id}) with a different manifest`, 'Results versions are immutable. Export the changed package as a new results version.');
			if (existing && existing.case_root !== inputs.caseRoot.path)
				return conflict('APP_CASE_FOLDER_DIFFERS', `${c.resultsVersion} was imported against the case folder ${existing.case_root}; this import names ${inputs.caseRoot.path}`, 'Import it against the same case folder, or export a new results version for the other folder.');
			if (existing && this.verify(existing.id, true).ok) {
				const proj = project(c, result.counts);
				if (result.diagnosticsSha256 !== existing.diagnostics_sha256 || readModelDigest({ ...proj, expect: JSON.stringify(proj.expect) }) !== existing.read_model_sha256)
					return conflict('APP_ORIGINALS_CHANGED', `the case folder no longer matches what was validated when ${c.resultsVersion} was stored (import #${existing.import_id}); the diagnostics below are the current ones`, `A stored results version never changes, so importing this package again cannot update it. Restore the changed or missing originals byte for byte and activate import #${existing.import_id} again, or convert the case folder and import the package as a new results version.`);
				if (existing.case_dev !== inputs.caseRoot.dev || existing.case_ino !== inputs.caseRoot.ino) await this.store.rebindCaseRoot(existing.id, inputs.caseRoot.dev, inputs.caseRoot.ino);
				return { kind: 'identical', importId: existing.import_id };
			}
			const files = [...c.snapshot()].map(({ path: p, bytes }) => ({ path: p, bytes, size: bytes.byteLength, sha256: sha256Hex(bytes) }));
			const write = {
				attempt: { at, case_folder: caseFolder, package_source: packageSource, case_id: c.caseId, results_version: c.resultsVersion, manifest_sha256: c.manifestSha256, verdict: result.verdict, report: JSON.stringify(report) },
				version: {
					id: c.resultsVersion, case_id: c.caseId, case_label: c.manifest.case.label ?? null, input_revision_id: c.inputRevisionId, created: c.manifest.created,
					case_folder: caseFolder, case_root: inputs.caseRoot.path, case_dev: inputs.caseRoot.dev, case_ino: inputs.caseRoot.ino,
					verdict: result.verdict, stored_at: at, manifest_sha256: c.manifestSha256, diagnostics_sha256: result.diagnosticsSha256,
					validator_version: result.validatorVersion, warning_fingerprints: JSON.stringify(result.warningFingerprints),
				},
				files,
				projection: project(c, result.counts),
			};
			if (existing) {
				const res = await this.store.repairVersion(write);
				if (res.kind !== 'repaired') return conflict('APP_VERSION_CONFLICT', `${c.resultsVersion} changed while it was being repaired`, 'Import it again.');
				this.storage.checkpointResults();
				const check = this.verify(c.resultsVersion, true);
				const rec = this.cases.get(c.caseId);
				if (check.ok && rec?.configured === c.resultsVersion) this.cases.delete(c.caseId);
				return { kind: 'repaired', importId: res.importId };
			}
			const res = await this.store.storeVersion(write);
			if (res.kind === 'identical') return { kind: 'identical', importId: res.existing.import_id };
			if (res.kind === 'conflict') return conflict('APP_VERSION_CONFLICT', `${c.resultsVersion} was stored concurrently with a different manifest`, 'Results versions are immutable. Export a new results version.');
			if (res.kind === 'retired') return conflict('APP_VERSION_RETIRED', `${c.resultsVersion} was imported before with a different manifest and removed by the retention policy on ${res.retiredAt}`, 'A results version id is never reused for different content. Export a new results version.');
			this.storage.checkpointResults();
			await this.store.pruneCandidates(this.config.keepCandidates, c.resultsVersion).catch((e) => console.error('retention failed', e));
			return { kind: 'stored', importId: res.kind === 'stored' || res.kind === 'repaired' ? res.importId : 0 };
		} finally {
			this.#current = null;
		}
	}


	#serially<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(fn, fn);
		this.#queue = run.catch(() => {});
		return run;
	}

	activate(vid: string, ack: AckInput | null, kind: ActivationKind = 'activate'): Promise<ActivationRefusal | null> {
		return this.#serially(() => this.#activateNow(vid, ack, kind));
	}

	async #activateNow(vid: string, ackInput: AckInput | null, kind: ActivationKind): Promise<ActivationRefusal | null> {
		const v = this.store.getVersion(vid);
		if (!v) return { message: 'No stored results version with that id.' };
		if (this.store.activeVersionId(v.case_id) === vid && this.effectiveActive(v.case_id) === vid) return null;
		const check = this.verify(vid, true);
		if (!check.ok) return { message: `Activation refused: the stored copy of ${vid} failed verification (${check.reason}). Import the same package again to repair it.` };
		const root = await stat(v.case_root, { bigint: true }).catch(() => null);
		if (!root || String(root.dev) !== v.case_dev || String(root.ino) !== v.case_ino)
			return { message: `Activation refused: the case folder ${v.case_root} is missing, or was moved or replaced since import. Nothing was changed.` };
		const files = this.store.packageFiles(vid);
		const bytes = verifyCandidateBytes(files, { resultsVersion: v.id, manifestSha256: v.manifest_sha256 });
		if (!bytes.ok) return { message: `Activation refused: stored package bytes do not verify (${bytes.problems.slice(0, 3).join('; ')}).` };
		const register = this.store.trustedRegister(v.case_id);
		const trusted = kind === 'activate' ? this.trustedFor(v.case_id) : new Set([...(this.store.acceptedWarningsOf(vid) ?? []), ...register]);
		const fresh = await importCandidate({ files }, v.case_root, { trustedBaseline: trusted, concurrency: 4 });
		if (fresh.verdict === 'reject') {
			const errs = fresh.diagnostics.filter((d) => d.severity === 'error').slice(0, 3).map((d) => `${d.code} ${d.subject}`.trim());
			return { message: `Activation refused: revalidating ${vid} against the case folder now rejects it (${errs.join('; ') || 'rejected'}). An original changed or became unreadable since import. Nothing was changed.` };
		}
		const proj = project(fresh.candidate, fresh.counts);
		const digest = readModelDigest({ ...proj, expect: JSON.stringify(proj.expect) });
		if (digest !== v.read_model_sha256)
			return { message: `Activation refused: the case folder no longer matches what was previewed for ${vid} (originals changed, moved or became unavailable). Restore the originals byte for byte and activate again, or convert the case folder and import a new results version: a stored version never changes, so importing this package again only shows the current diagnostics. Nothing was changed.` };
		const ack: Acknowledgement | null = ackInput ? {
			acknowledgement: 'clearcase.acknowledgement/1', resultsVersion: ackInput.resultsVersion, manifestSha256: ackInput.manifestSha256,
			diagnosticsSha256: ackInput.diagnosticsSha256, validatorVersion: ackInput.validatorVersion,
			warningFingerprints: [...new Set(ackInput.warningFingerprints)].sort(), acknowledgedBy: ackInput.acknowledgedBy ?? 'local operator', at: now(),
		} : null;
		const decision = canActivate(fresh, ack, trusted);
		if (!decision.ok) return { message: `Activation refused: ${decision.reasons.map((r) => `${r.code}: ${r.message}`).join('; ')}. Nothing was changed.`, reasons: decision.reasons };
		const bound = decision.newWarnings.length > 0 ? ack : null;
		const wrote = await this.store.writeActivation(v, kind, bound, acceptedWarnings(fresh, bound, trusted));
		this.cases.delete(v.case_id);
		if (wrote) this.backupNow(`${kind}-${vid.slice(7, 19)}`);
		return null;
	}

	rollback(caseId: string, expect: string | null, to: string | null): Promise<ActivationRefusal | null> {
		return this.#serially(async () => {
			const cur = this.effectiveActive(caseId);
			const prev = this.previousVersion(caseId);
			if (!prev) return { message: 'There is no previous version to return to.' };
			if (!expect || cur !== expect) return { message: `Nothing was changed: the active version is now ${cur ?? 'none'}, not ${expect ?? 'the one this page showed'}. Reload the page to see the current state.` };
			if (to && to !== prev) return { message: `Nothing was changed: the previous version is now ${prev}, not ${to}. Reload the page to see the current state.` };
			return this.#activateNow(prev, null, 'rollback');
		});
	}

	adoptRecovery(caseId: string): Promise<ActivationRefusal | null> {
		const r = this.cases.get(caseId);
		if (!r?.effective) return Promise.resolve({ message: 'Nothing to adopt.' });
		return this.#serially(() => this.#activateNow(r.effective!, null, 'recovery'));
	}

	previousVersion(caseId: string): string | null {
		const cur = this.effectiveActive(caseId);
		const ptr = this.store.activePointers().find((p) => p.case_id === caseId);
		const prev = ptr?.previous_version_id && ptr.previous_version_id !== cur ? ptr.previous_version_id : this.store.activationLog(caseId).find((e) => e.version_id !== cur)?.version_id;
		return prev && this.store.getVersion(prev) ? prev : null;
	}


	backupNow(label: string) {
		try {
			this.store.backupWork(label, this.config.keepBackups);
			this.warnings.delete('backup-failed');
		} catch (e) {
			console.error('work.sqlite backup failed (the change itself was saved):', e);
			this.warnings.set('backup-failed', `The last backup of work.sqlite failed (${String((e as Error).message ?? e).slice(0, 200)}). Your change was saved, but ${this.storage.backupDir} has no copy of it yet.`);
		}
	}
	scheduleUserWorkBackup() {
		if (this.#backupTimer) clearTimeout(this.#backupTimer);
		this.#backupTimer = setTimeout(() => { this.#backupTimer = null; this.backupNow('user-work'); }, this.config.userWorkBackupDelayMs);
		this.#backupTimer.unref?.();
	}
	shutdown() {
		if (this.#backupTimer) { clearTimeout(this.#backupTimer); this.#backupTimer = null; this.backupNow('user-work'); }
		this.#current?.abort.abort();
		this.storage.close();
	}

	restoreHelp(): string {
		const d = this.config.dataDir;
		return `The data directory was left untouched. To restore user work from a backup: stop ClearCase; move work.sqlite AND its sidecar files (work.sqlite-journal, and any old work.sqlite-wal or work.sqlite-shm) out of ${d}; copy the newest ${path.join(d, 'backups', 'work-*.sqlite')} to ${path.join(d, 'work.sqlite')}; start ClearCase. Backups are written at every activation, after user-work editing pauses, and on clean shutdown when a backup is pending. Results versions can always be imported again from their packages.`;
	}
}

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function toReport(result: ImportResult, app: AppDiagnostic[], trusted: Set<string>, ms: number): ImportReport {
	const c = result.candidate;
	return {
		report: IMPORT_REPORT,
		verdict: app.some((d) => d.severity === 'error') ? 'reject' : result.verdict,
		caseId: c?.caseId ?? null, caseLabel: c?.manifest.case.label ?? null, resultsVersion: c?.resultsVersion ?? null, manifestSha256: c?.manifestSha256 ?? null,
		diagnosticsSha256: result.diagnosticsSha256, validatorVersion: result.validatorVersion, counts: { ...result.counts },
		warningFingerprints: [...result.warningFingerprints], errorFingerprints: [...result.errorFingerprints],
		newWarnings: c ? newWarningFingerprints(result, trusted) : [],
		diagnostics: [...result.diagnostics], app, ms: Math.round(ms),
	};
}

function appOnlyReport(app: AppDiagnostic[], ms: number): ImportReport {
	return { report: IMPORT_REPORT, verdict: 'reject', caseId: null, caseLabel: null, resultsVersion: null, manifestSha256: null, diagnosticsSha256: '', validatorVersion: '', counts: {}, warningFingerprints: [], errorFingerprints: [], newWarnings: [], diagnostics: [], app, ms: Math.round(ms) };
}
