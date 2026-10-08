// Derive a malformed copy of a dataset's data from its schema: one required member removed or
// retyped. Used by the per-dataset malformed-record tests and the independent schema check.
type S = { type?: string; required?: string[]; properties?: Record<string, S>; items?: S; patternProperties?: Record<string, S> };

const wrong = (sub: S | undefined): unknown => (sub?.type === 'string' ? 12345 : 'not-a-' + (sub?.type ?? 'value'));

export function malform(schema: unknown, original: unknown): unknown {
  const s = schema as S;
  const data = structuredClone(original) as any;
  if (s.type === 'array' && s.items?.type === 'object' && Array.isArray(data) && data.length) {
    const req = s.items.required ?? [];
    if (!req.length) return undefined;
    data[0][req[0]!] = wrong(s.items.properties?.[req[0]!]);
    return data;
  }
  if (s.type === 'array' && s.items && Array.isArray(data) && data.length) { data[0] = { not: 'an item' }; return data; }
  if (s.type === 'object' && s.required?.length) { delete data[s.required[0]!]; return data; }
  if (s.type === 'object' && s.patternProperties) {
    const k = Object.keys(data)[0];
    if (k === undefined) return undefined;
    const inner = Object.values(s.patternProperties)[0];
    data[k] = inner?.type === 'object' ? 'x' : { nested: true };
    return data;
  }
  return undefined;
}
