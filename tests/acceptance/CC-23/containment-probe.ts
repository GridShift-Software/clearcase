import { importCandidate } from '../../../src/lib/case-package/import.ts';
import { miniPackage } from '../../case-package/hostile/cases.ts';

const bytes = new TextEncoder().encode('%PDF-1.4\n% invented containment original\n%%EOF\n');
const result = await importCandidate({
  files: miniPackage({ docs: [{ ref: 'GT-001', path: 'linked/secret.pdf', bytes }] }),
}, process.argv[2]!);
console.log(JSON.stringify({ verdict: result.verdict, counts: result.counts, candidate: !!result.candidate }));
