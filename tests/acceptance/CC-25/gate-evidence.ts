// What CC-25 item 1 reads from a gate summary: the verdict, not only that the run was eligible evidence. Each summary
// must record its own passing outcome in the fields its writer sets (scripts/parity/lib/compare.mjs and run.mjs for the
// scorecard, tests/e2e/pilot/v5-lanes.mjs for the lanes); an absent field is a failure, never a pass. Pure, so the
// negative fixtures in gate-evidence.test.ts can exercise it without a gate run.

export type GateKind = 'verify:pilot:v5' | 'parity --all --strict-register';

/** The v5 workspace's views: a parity run that compared fewer is not the full-coverage evidence item 1 asks for. */
const VIEWS = 42;

/** Why `doc` (a gate step's summary JSON) is not passing evidence for `head`; empty when it is. */
export function gateEvidenceProblems(kind: GateKind, doc: any, head: string): string[] {
  const problems: string[] = [];
  const bad = (m: string) => problems.push(`${kind}: ${m}`);
  if (doc.evidence !== true) bad('evidence is not true');
  if (doc.freshBuild?.head !== head) bad(`summary is for ${String(doc.freshBuild?.head).slice(0, 12)}, not HEAD`);
  if (doc.aborted) bad('the run was aborted');
  if (kind === 'verify:pilot:v5') {
    if (doc.ok !== true) bad(`ok is ${JSON.stringify(doc.ok ?? null)}, not true`);
    const lanes = Array.isArray(doc.lanes) ? doc.lanes : [];
    if (!lanes.length) bad('no lanes are recorded');
    const failed = lanes.filter((l: any) => l?.status !== 'PASS').length;
    if (failed) bad(`${failed} of ${lanes.length} lanes are not PASS`);
  } else {
    if (doc.result !== 'PASS') bad(`result is ${JSON.stringify(doc.result ?? null)}, not "PASS"`);
    if (doc.exit !== 0) bad(`exit is ${JSON.stringify(doc.exit ?? null)}, not 0`);
    if (doc.register?.strict !== true) bad('the register was not run strict (--strict-register)');
    const t = doc.total ?? {};
    for (const k of ['views', 'viewsExtractedV5', 'viewsComparedApp'] as const) if (t[k] !== VIEWS) bad(`${k} is ${JSON.stringify(t[k] ?? null)}, not ${VIEWS}`);
    for (const k of ['viewsNotImplemented', 'viewsExtractError', 'viewsFailed', 'unregistered'] as const) if (t[k] !== 0) bad(`${k} is ${JSON.stringify(t[k] ?? null)}, not 0`);
  }
  return problems;
}
