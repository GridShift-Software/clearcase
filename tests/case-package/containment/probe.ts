// Imports one synthetic package whose only original is indexed as linked/secret.pdf against the
// case folder in argv[2]. Adapted from the CC-23 / GRS-11 gate's containment-probe.ts.
import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { miniPackage } from '../hostile/cases.ts';

const bytes = new TextEncoder().encode('%PDF-1.4\n% invented containment original\n%%EOF\n');
const result = await importCandidate({
  files: miniPackage({ docs: [{ ref: 'GT-001', path: process.argv[3] ?? 'linked/secret.pdf', bytes }] }),
}, process.argv[2]!);
console.log(JSON.stringify({ verdict: result.verdict, counts: result.counts, candidate: !!result.candidate }));
