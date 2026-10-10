// Legality & SIU Risk and Cause of Action: read-only views of authored analysis. Browser-safe.
import { viewById, type ViewEntry } from '../../components/views.ts';

/** v5's likelihood chip (legality_tab): /base/i is ok, else /material/i is danger, else warn. */
export const likelihoodClass = (prob: string): 'ok' | 'danger' | 'warn' => (/base/i.test(prob) ? 'ok' : /material/i.test(prob) ? 'danger' : 'warn');

/** v5 cleanName: a leading '(digits) ' and a trailing .pdf/.eml/.msg removed. */
export const cleanName = (f: unknown) => String(f ?? '').replace(/^\(\d+\)\s*/, '').replace(/\.(pdf|eml|msg)$/i, '');

/**
 * The view a cause-of-action element's "open →" goes to, or null for an id that names no view, which the page shows as
 * text, not a link (S-elements_tab-1, corrected: v5 opened its "Not found" page).
 */
export const elementTarget = (tab: unknown): ViewEntry | null => (typeof tab === 'string' && tab ? viewById(tab) ?? null : null);

/** The Cause of Action columns: the view-content list when it names all five, else neutral headings. */
export const ELEMENT_COLUMNS = Object.freeze(['Element', 'What must be proved', 'Evidence', 'Witness', 'Go to']);
export const elementColumns = (fromData: readonly string[] | null | undefined) => (fromData && fromData.length === 5 && fromData.every((c) => typeof c === 'string' && c.trim()) ? [...fromData] : [...ELEMENT_COLUMNS]);
