// Types for scripts/browser-lock.mjs, which stays plain JavaScript because it imports nothing from the repository.
export const ADMISSION_FIX: string;
/** `base` without its GIT_* variables. */
export function gitEnv(base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export type Admission = { lock: string | null; source: 'explicit' | 'discovered' | 'none'; problem?: undefined } | { problem: string; lock?: undefined; source?: undefined };
export function resolveBrowserLock(options?: { env?: NodeJS.ProcessEnv; repo?: string }): Admission;
export function describeAdmission(admission: { lock: string | null; source: 'explicit' | 'discovered' | 'none' }): string;
