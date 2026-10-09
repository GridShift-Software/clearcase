// Typed reading of the `view-content` dataset (v5.view-content@1): code-embedded case content
// that v5 hard-coded in its renderers and ClearCase imports as data. Views read it here, never
// from literals in the app. Every value is untrusted text: put it in a text node, or pass a
// narrative through renderNarrative(). Template params are filled from imported data, which is
// untrusted too. Browser-safe: no Node built-ins.

export const VIEW_CONTENT_KEY = 'view-content';

export type ViewTemplatePart = string | { param: string };
export type ViewTemplate = { template: ViewTemplatePart[] };
export type ViewValue = string | number | string[] | ViewTemplate;

export interface FilledText {
  text: string;
  /** params the template names that the caller did not supply (filled with an empty string) */
  missing: string[];
}

export interface ViewContentReader {
  views(): string[];
  fields(view: string): string[];
  /** the stored value, or null when the field is absent or not a view-content value */
  value(view: string, field: string): ViewValue | null;
  /** plain text; null unless the field is plain text */
  text(view: string, field: string): string | null;
  number(view: string, field: string): number | null;
  list(view: string, field: string): string[] | null;
  /** text or template as text, params filled from `params` (String() of each value) */
  fill(view: string, field: string, params?: Readonly<Record<string, string | number>>): FilledText | null;
  /** a template's param names in order; [] for plain text, null when absent */
  params(view: string, field: string): string[] | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

export function isViewTemplate(v: unknown): v is ViewTemplate {
  return isRecord(v) && Array.isArray(v.template) && v.template.length > 0 &&
    v.template.every((p) => typeof p === 'string' || (isRecord(p) && typeof p.param === 'string'));
}

export function isViewValue(v: unknown): v is ViewValue {
  return typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || (Array.isArray(v) && v.every((x) => typeof x === 'string')) || isViewTemplate(v);
}

/**
 * Wrap the `data` of the view-content dataset, e.g. `readViewContent(datasetOf(store, rv, 'view-content'))`.
 * Absent or malformed data reads as empty: every accessor returns null and the view shows the
 * field as unavailable rather than falling back to a literal.
 */
export function readViewContent(data: unknown): ViewContentReader {
  const root = isRecord(data) ? data : {};
  const fieldsOf = (view: string): Record<string, unknown> => (Object.hasOwn(root, view) && isRecord(root[view]) ? (root[view] as Record<string, unknown>) : {});
  const value = (view: string, field: string): ViewValue | null => {
    const f = fieldsOf(view);
    const v = Object.hasOwn(f, field) ? f[field] : undefined;
    return isViewValue(v) ? v : null;
  };
  return {
    views: () => Object.keys(root).filter((v) => isRecord(root[v])).sort(),
    fields: (view) => Object.keys(fieldsOf(view)).filter((f) => isViewValue(fieldsOf(view)[f])).sort(),
    value: (view, field) => { const v = value(view, field); return v !== null && typeof v === 'object' ? structuredClone(v) : v; },
    text: (view, field) => { const v = value(view, field); return typeof v === 'string' ? v : null; },
    number: (view, field) => { const v = value(view, field); return typeof v === 'number' ? v : null; },
    list: (view, field) => { const v = value(view, field); return Array.isArray(v) ? [...v] : null; },
    params: (view, field) => {
      const v = value(view, field);
      if (typeof v === 'string') return [];
      return isViewTemplate(v) ? v.template.flatMap((p) => (typeof p === 'string' ? [] : [p.param])) : null;
    },
    fill: (view, field, params = {}) => {
      const v = value(view, field);
      if (typeof v === 'string') return { text: v, missing: [] };
      if (!isViewTemplate(v)) return null;
      const missing: string[] = [];
      const text = v.template.map((p) => {
        if (typeof p === 'string') return p;
        if (Object.hasOwn(params, p.param)) return String(params[p.param]);
        missing.push(p.param);
        return '';
      }).join('');
      return { text, missing };
    },
  };
}
