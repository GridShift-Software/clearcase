#!/usr/bin/env bun
// Operator CLI for the results-package library. Usage and exit codes: docs/results-package.md.
//   convert      v5 workspace HTML + case folder -> package directory, then full validation
//   validate     package directory or .zip + case folder -> validation report
//   acknowledge  validation report -> acknowledgement of its new warnings
// Exit codes: 0 candidate (verdict accept or report; with --activation-check also activatable),
// 1 rejected (no candidate), 2 usage or input error, 3 candidate that the activation check refuses.
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalText } from '../../src/lib/case-package/canonical.ts';
import type { ImportResult } from '../../src/lib/case-package/candidate.ts';
import { importCandidate } from '../../src/lib/case-package/import.ts';
import { acknowledge, canActivate } from '../../src/lib/case-package/policy.ts';
import { ACKNOWLEDGEMENT, CASE_ID, type Acknowledgement } from '../../src/lib/case-package/schema.ts';
import { parseStrictJson } from '../../src/lib/case-package/strict-json.ts';
import { convertV5, type ConvertResult } from '../../src/lib/case-package/v5/adapter.ts';
import { writePackageDir } from '../../src/lib/case-package/writer.ts';

class UsageError extends Error {}
const say = (s: string) => process.stderr.write(s + '\n');

async function within(child: string, parent: string): Promise<boolean> {
  const p = await realpath(parent);
  let c = path.resolve(child);
  // the output may not exist yet: resolve its nearest existing ancestor
  for (;;) {
    const r = await realpath(c).catch(() => null);
    if (r) { c = path.join(r, path.relative(c, path.resolve(child))); break; }
    const up = path.dirname(c);
    if (up === c) break;
    c = up;
  }
  return c === p || c.startsWith(p + path.sep);
}

function reportOf(command: string, result: ImportResult, extra: Record<string, unknown> = {}) {
  const c = result.candidate;
  return {
    report: 'clearcase.validation-report/1',
    command,
    verdict: result.verdict,
    caseId: c?.caseId ?? null,
    resultsVersion: c?.resultsVersion ?? null,
    manifestSha256: c?.manifestSha256 ?? null,
    inputRevisionId: c?.inputRevisionId ?? null,
    validatorVersion: result.validatorVersion,
    diagnosticsSha256: result.diagnosticsSha256,
    counts: result.counts,
    warningFingerprints: result.warningFingerprints,
    errorFingerprints: result.errorFingerprints,
    diagnostics: result.diagnostics,
    ...extra,
  };
}

async function readJsonFile(p: string): Promise<any> {
  return parseStrictJson(await readFile(p, 'utf8'));
}

async function trustedFrom(file: string | undefined): Promise<string[]> {
  if (!file) return [];
  const v = await readJsonFile(file);
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new UsageError('--baseline must be a JSON array of fingerprints');
  return v;
}

function summary(result: ImportResult): string {
  const c = result.candidate;
  const counts = Object.entries(result.counts).map(([k, n]) => `${k}=${n}`).join(' ');
  return `verdict: ${result.verdict}${c ? ` resultsVersion: ${c.resultsVersion}` : ''}\n${counts}`;
}

/** View-content coverage for the convert report: ids, counts and source lines only, never values. */
function viewContentSummary(v: ConvertResult['viewContent']) {
  const fields = v?.fields ?? [];
  const perView: Record<string, number> = {};
  for (const f of fields) if (f.status === 'extracted') perView[f.view] = (perView[f.view] ?? 0) + 1;
  return {
    extracted: fields.filter((f) => f.status === 'extracted').length,
    perView,
    notExtracted: fields.filter((f) => f.status !== 'extracted').map((f) => ({ view: f.view, field: f.field, status: f.status })),
    unmapped: v?.unmapped ?? [],
  };
}

async function convert(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    html: { type: 'string' }, 'case-folder': { type: 'string' }, 'case-id': { type: 'string' }, 'case-label': { type: 'string' },
    out: { type: 'string' }, report: { type: 'string' }, 'no-validate': { type: 'boolean' }, concurrency: { type: 'string' },
  }, strict: true });
  const html = values.html, caseFolder = values['case-folder'], caseId = values['case-id'], out = values.out;
  if (!html || !caseFolder || !caseId || !out) throw new UsageError('convert needs --html, --case-folder, --case-id and --out');
  if (!new RegExp(CASE_ID).test(caseId)) throw new UsageError(`--case-id must match ${CASE_ID}`);
  const cf = await stat(caseFolder).catch(() => null);
  if (!cf?.isDirectory()) throw new UsageError('--case-folder is not a directory');
  if (await within(out, caseFolder)) throw new UsageError('--out is inside the case folder; ClearCase never writes there');
  if (values.report && (await within(values.report, caseFolder))) throw new UsageError('--report is inside the case folder; ClearCase never writes there');
  const concurrency = values.concurrency ? Number(values.concurrency) : 4;
  const bytes = await readFile(html).catch(() => null);
  if (!bytes) throw new UsageError('--html cannot be read');
  const conv = await convertV5({ html: bytes, htmlName: path.basename(html), caseFolder, caseId, caseLabel: values['case-label'], concurrency });
  if (!conv.files) {
    say('conversion failed: ' + conv.diagnostics.filter((d) => d.severity === 'error').map((d) => `${d.code} ${d.message}`).join('; '));
    if (values.report) await writeFile(values.report, canonicalText({ report: 'clearcase.validation-report/1', command: 'convert', verdict: 'reject', conversion: conv.diagnostics, viewContent: viewContentSummary(conv.viewContent) }));
    return 1;
  }
  await writePackageDir(out, conv.files);
  say(`converted: ${conv.files.size} files, ${conv.stats.chronology} documents, ${conv.stats.assetsFile} originals fingerprinted`);
  const vc = viewContentSummary(conv.viewContent);
  say(`view content: ${vc.extracted} fields extracted from ${Object.keys(vc.perView).length} views; ${vc.notExtracted.length} not extracted; ${vc.unmapped.length} unmapped prose literals`);
  if (values['no-validate']) return conv.ok ? 0 : 1;
  const result = await importCandidate(out, caseFolder, { concurrency });
  say(summary(result));
  if (values.report) await writeFile(values.report, canonicalText(reportOf('convert', result, { conversion: conv.diagnostics, viewContent: vc })));
  return result.verdict === 'reject' ? 1 : 0;
}

async function validate(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    package: { type: 'string' }, 'case-folder': { type: 'string' }, report: { type: 'string' }, baseline: { type: 'string' },
    ack: { type: 'string' }, 'activation-check': { type: 'boolean' }, concurrency: { type: 'string' }, 'deadline-ms': { type: 'string' },
  }, strict: true });
  const pkg = values.package, caseFolder = values['case-folder'];
  if (!pkg || !caseFolder) throw new UsageError('validate needs --package and --case-folder');
  if (values.report && (await within(values.report, caseFolder))) throw new UsageError('--report is inside the case folder; ClearCase never writes there');
  const trusted = await trustedFrom(values.baseline);
  const limits = values['deadline-ms'] ? { validationDeadlineMs: Number(values['deadline-ms']) } : undefined;
  const result = await importCandidate(pkg, caseFolder, { trustedBaseline: trusted, concurrency: values.concurrency ? Number(values.concurrency) : 4, limits });
  say(summary(result));
  let activation: ReturnType<typeof canActivate> | null = null;
  if (values['activation-check']) {
    const ack = values.ack ? ((await readJsonFile(values.ack)) as Acknowledgement) : null;
    activation = canActivate(result, ack, trusted);
    say(`activation: ${activation.ok ? 'allowed' : 'refused'}${activation.reasons.map((r) => `\n  ${r.code}: ${r.message}`).join('')}`);
  }
  if (values.report) await writeFile(values.report, canonicalText(reportOf('validate', result, activation ? { activation } : {})));
  if (result.verdict === 'reject') return 1;
  return activation && !activation.ok ? 3 : 0;
}

async function acknowledgeCmd(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { report: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' }, by: { type: 'string' } }, strict: true });
  if (!values.report || !values.out) throw new UsageError('acknowledge needs --report and --out');
  const r = await readJsonFile(values.report);
  if (r.verdict === 'reject' || !r.resultsVersion) { say('a rejected import cannot be acknowledged'); return 1; }
  const trusted = new Set(await trustedFrom(values.baseline));
  const fresh = (r.warningFingerprints as string[]).filter((f) => !trusted.has(f));
  const ack: Acknowledgement = acknowledge({ ...r, candidate: { resultsVersion: r.resultsVersion, manifestSha256: r.manifestSha256 } } as never, fresh, values.by ? { acknowledgedBy: values.by } : undefined);
  if (ack.acknowledgement !== ACKNOWLEDGEMENT) return 1;
  await writeFile(values.out, canonicalText(ack));
  say(`acknowledged ${fresh.length} new warning(s) for ${r.resultsVersion}`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  const code = cmd === 'convert' ? await convert(rest) : cmd === 'validate' ? await validate(rest) : cmd === 'acknowledge' ? await acknowledgeCmd(rest) : (() => { throw new UsageError('usage: cli.ts convert|validate|acknowledge [flags]'); })();
  process.exit(code);
} catch (e) {
  if (e instanceof UsageError || (e as NodeJS.ErrnoException).code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || (e as Error).message === 'output directory is not empty') {
    say(`error: ${(e as Error).message}`);
    process.exit(2);
  }
  throw e;
}
