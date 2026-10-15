import { viewById, type ViewEntry } from '../../components/views.ts';

export const likelihoodClass = (prob: string): 'ok' | 'danger' | 'warn' => (/base/i.test(prob) ? 'ok' : /material/i.test(prob) ? 'danger' : 'warn');

export const cleanName = (f: unknown) => String(f ?? '').replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');

export const elementTarget = (tab: unknown): ViewEntry | null => (typeof tab === 'string' && tab ? viewById(tab) ?? null : null);

export const ELEMENT_COLUMNS = Object.freeze(['Element', 'What must be proved', 'Evidence', 'Witness', 'Go to']);
export const elementColumns = (fromData: readonly string[] | null | undefined) => (fromData && fromData.length === 5 && fromData.every((c) => typeof c === 'string' && c.trim()) ? [...fromData] : [...ELEMENT_COLUMNS]);
