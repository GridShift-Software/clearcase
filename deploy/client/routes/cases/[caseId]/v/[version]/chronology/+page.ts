import { loadChronology } from '$lib/local-case/chronology';
import type { ChronologySource } from '$lib/local-case/chronology';

export const load = ({ data, fetch }: { data: ChronologySource & Record<string, unknown>; fetch: typeof globalThis.fetch }) => loadChronology(data, fetch);
