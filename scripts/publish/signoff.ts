// `signoff`: a person accepts this build, or one amendment of it, for publication. The attestation binds the manifest's or
// amendment's sha256 and names every warning code of the import with the signer's reason; a code left unacknowledged, or
// acknowledged but absent, refuses.
import { CODES } from '../../src/lib/case-package/codes.ts';
import type { D1Exec } from './d1.ts';
import { signoffSql, signoffsQuery, type Acknowledgement } from './sql.ts';
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

export interface Signed {
  acknowledgements: Acknowledgement[];
  /** This attestation's `signoff_id`. */
  id: number;
  /** True when this exact attestation (signer, target, acknowledgements) was already recorded: nothing new was written. */
  replayed: boolean;
  /** Everyone who has attested the target, oldest first. */
  signers: string[];
}

/**
 * Records `signer`'s attestation of the version's manifest, or of the amendment whose sha256 is `target`. An exact replay
 * reports idempotent success; another signer, or another acknowledgement set, appends its own attestation beside the
 * earlier ones. The owner signs an agent-signed version this way, with no rebuild.
 */
export async function signoff(d1: D1Exec, r: BuildRecord, a: { signer: string; acks: readonly string[]; at: string; target?: string }): Promise<Signed> {
  if (!EMAIL.test(a.signer)) throw new Error('--signer must be an email address');
  const acks = acknowledgements(r, a.acks);
  if (!acks.ok) throw new Error(`sign-off refused:\n  ${acks.problems.join('\n  ')}`);
  const target = a.target ?? r.shardManifestSha256, json = JSON.stringify(acks.acknowledgements);
  const mine = (rows: { signoff_id: number; signer: string; acknowledgements_json: string }[]) => rows.find((x) => x.signer === a.signer && x.acknowledgements_json === json);
  const earlier = mine(await d1.all(signoffsQuery(r.resultsVersion, target)));
  if (!earlier) await d1.file(signoffSql(r, { target, signer: a.signer, at: a.at, acknowledgements: acks.acknowledgements }));
  const rows = await d1.all<{ signoff_id: number; signer: string; acknowledgements_json: string }>(signoffsQuery(r.resultsVersion, target));
  const row = mine(rows);
  if (!row) throw new Error(`no sign-off was recorded: ${target} is not a manifest or amendment registered for ${r.resultsVersion} (run register first, or amend for an amendment)`);
  return { acknowledgements: acks.acknowledgements, id: Number(row.signoff_id), replayed: !!earlier, signers: [...new Set(rows.map((x) => x.signer))] };
}
