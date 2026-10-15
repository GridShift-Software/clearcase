// Diagnostic collection. Every instance is fingerprinted, including instances beyond the
// listed cap, so an acknowledgement can cover diagnostics that appear only in totals.
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical.ts';
import { CODES, type Code, type Diagnostic, type Severity } from './codes.ts';
import { LIMITS } from './limits.ts';
import { cutText } from './strict-json.ts';

/** `identity` binds the fingerprint to what the subject names (an original's indexed sha256, size and path); it is never listed. */
export interface At { file?: string; pointer?: string; subject?: string; stablePointer?: string; identity?: string }

/**
 * sha256 over code, file, the pointer with array indexes replaced by "*" (or a caller-built
 * stable pointer that names the containing record), the subject and, when given, the
 * identity. Reordering records does not change it; a different record (subject) or a
 * different document under the same package-local ref (identity) does.
 */
export function fingerprint(code: string, at: At): string {
  const pointer = at.stablePointer ?? (at.pointer ?? '').replace(/\/\d+(?=\/|$)/g, '/*');
  const identity = at.identity === undefined ? '' : `\u0000${at.identity}`;
  return createHash('sha256').update(`${code}\u0000${at.file ?? ''}\u0000${pointer}\u0000${at.subject ?? ''}${identity}`).digest('hex').slice(0, 32);
}

type Pending = Omit<Diagnostic, 'baseline'>;

export class DiagSink {
  private readonly byCode = new Map<Code, Pending[]>();
  readonly counts = new Map<Code, number>();
  readonly warningFingerprints = new Set<string>();
  readonly errorFingerprints = new Set<string>();
  private readonly cap: number;
  constructor(cap: number = LIMITS.diagnosticsPerCode) { this.cap = cap; }

  add(code: Code, message: string, at: At = {}): void {
    const def = CODES[code];
    const n = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, n);
    const fp = fingerprint(code, at);
    if (def.severity === 'warning') this.warningFingerprints.add(fp);
    else if (def.severity === 'error') this.errorFingerprints.add(fp);
    let list = this.byCode.get(code);
    if (!list) { list = []; this.byCode.set(code, list); }
    list.push({
      code, severity: def.severity, cls: def.cls,
      ...(at.file !== undefined && { file: at.file.toWellFormed() }),
      ...(at.pointer !== undefined && { pointer: at.pointer.toWellFormed() }),
      ...(at.subject !== undefined && { subject: cutText(at.subject, 200).toWellFormed() }),
      message: message.toWellFormed(), hint: def.hint, fingerprint: fp,
    });
    if (list.length >= 2 * this.cap) { list.sort(compareDiagnostics); list.length = this.cap; }
  }

  count(sev: Severity): number {
    let n = 0;
    for (const [c, k] of this.counts) if (CODES[c].severity === sev) n += k;
    return n;
  }
  get errors(): number { return this.count('error'); }
  has(code: Code): boolean { return (this.counts.get(code) ?? 0) > 0; }

  finish(trusted: ReadonlySet<string> = new Set()): Diagnostic[] {
    const out: Pending[] = [];
    for (const list of this.byCode.values()) out.push(...[...list].sort(compareDiagnostics).slice(0, this.cap));
    for (const [c, n] of this.counts) {
      if (n > this.cap) {
        out.push({ code: 'DIAG_TRUNCATED', severity: 'info', cls: 'quality', subject: c,
          message: `${n - this.cap} more ${c} not listed (${n} in total)`, hint: CODES.DIAG_TRUNCATED.hint, fingerprint: fingerprint('DIAG_TRUNCATED', { subject: c }) });
      }
    }
    out.sort(compareDiagnostics);
    return out.map((d) => ({ ...d, baseline: d.severity !== 'error' && trusted.has(d.fingerprint) ? 'known' : 'new' }));
  }
}

const SEV_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
export function compareDiagnostics(a: Pending, b: Pending): number {
  return SEV_ORDER[a.severity] - SEV_ORDER[b.severity]
    || cmp(a.code, b.code) || cmp(a.file ?? '', b.file ?? '') || cmp(a.pointer ?? '', b.pointer ?? '')
    || cmp(a.subject ?? '', b.subject ?? '') || cmp(a.message, b.message);
}
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Digest of the baseline-independent diagnostic content (what an acknowledgement binds). */
export function diagnosticsDigest(validatorVersion: string, diagnostics: Diagnostic[], counts: Record<string, number>, warningFingerprints: string[]): string {
  const body = {
    validatorVersion,
    counts,
    warningFingerprints,
    diagnostics: diagnostics.map(({ baseline: _b, ...d }) => d),
  };
  return 'sha256:' + createHash('sha256').update(canonicalJson(body)).digest('hex');
}

export function countBy<T>(xs: Iterable<T>, key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}
