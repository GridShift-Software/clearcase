import { loadChronology } from '$lib/local-case/chronology';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ data, fetch }) => loadChronology(data, fetch);
