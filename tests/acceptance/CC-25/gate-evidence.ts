// What CC-25 item 1 reads from a gate summary: the verdict, not only that the run was eligible evidence. Pure, so the
// negative fixtures in gate-evidence.test.ts can exercise it without a gate run.

export type GateKind = 'verify:pilot:v5' | 'parity --all --strict-register';

/** Why `doc` (a gate step's summary JSON) is not passing evidence for `head`; empty when it is. */
export function gateEvidenceProblems(kind: GateKind, doc: any, head: string): string[] {
  const problems: string[] = [];
  if (doc.evidence !== true) problems.push(`${kind}: evidence is not true`);
  if (doc.ok === false) problems.push(`${kind}: ok is false`);
  if (doc.freshBuild?.head !== head) problems.push(`${kind}: summary is for ${String(doc.freshBuild?.head).slice(0, 12)}, not HEAD`);
  return problems;
}
