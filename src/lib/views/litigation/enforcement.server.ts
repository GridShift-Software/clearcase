import { createHash } from 'node:crypto';
import { canonicalJson } from '../../case-package/canonical.ts';

export const stepKey = (s: { phase: string; step: string }) => createHash('sha256').update(canonicalJson({ phase: s.phase, step: s.step })).digest('hex');
