// `signoff`: a person accepts this build for publication. The row binds the shard manifest's sha256 and names every
// warning code of the import with the signer's reason; a code left unacknowledged, or acknowledged but absent, refuses.
import { CODES } from '../../src/lib/case-package/codes.ts';
import type { D1Exec } from './d1.ts';
import { signoffSql, sq, type Acknowledgement } from './sql.ts';
import type { BuildRecord } from './types.ts';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The acknowledgements of a build's warnings from `CODE=reason` arguments, or the reasons they are refused. */
export function acknowledgements(r: BuildRecord, acks: readonly string[]): { ok: true; acknowledgements: Acknowledgement[] } | { ok: false; problems: string[] } {
  const given = new Map<string, string>();
  const problems: string[] = [];
  for (const a of acks) {
    const i = a.indexOf('=');
    const code = i > 0 ? a.slice(0, i) : a, reason = i > 0 ? a.slice(i + 1).trim() : '';
    if (!reason) problems.push(`--ack ${code} has no reason (CODE=reason)`);
    else given.set(code, reason);
  }
  const warnings = Object.entries(r.diagnostics).filter(([code, n]) => n > 0 && (CODES as Record<string, { severity: string }>)[code]?.severity === 'warning');
  for (const [code] of warnings) if (!given.has(code)) problems.push(`warning ${code} is not acknowledged`);
  for (const code of given.keys()) if (!warnings.some(([c]) => c === code)) problems.push(`${code} is not a warning of this build`);
  if (problems.length) return { ok: false, problems };
  return { ok: true, acknowledgements: warnings.map(([code, count]) => ({ code, count, reason: given.get(code)! })).sort((a, b) => (a.code < b.code ? -1 : 1)) };
}

export async function signoff(d1: D1Exec, r: BuildRecord, a: { signer: string; acks: readonly string[]; at: string }): Promise<Acknowledgement[]> {
  if (!EMAIL.test(a.signer)) throw new Error('--signer must be an email address');
  const acks = acknowledgements(r, a.acks);
  if (!acks.ok) throw new Error(`sign-off refused:\n  ${acks.problems.join('\n  ')}`);
  await d1.file(signoffSql(r, { signer: a.signer, at: a.at, acknowledgements: acks.acknowledgements }));
  const rows = await d1.all<{ n: number }>(`SELECT COUNT(*) AS n FROM pub_version_signoff WHERE version_id = ${sq(r.resultsVersion)} AND shard_manifest_sha256 = ${sq(r.shardManifestSha256)}`);
  if (rows[0]?.n !== 1) throw new Error('no sign-off was recorded: the version is not registered with this shard manifest (run register first)');
  return acks.acknowledgements;
}
