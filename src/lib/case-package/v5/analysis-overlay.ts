import type { DiagSink } from '../diagnostics.ts';
import { isObject, parseStrictJson, StrictJsonError, type JsonObject, type JsonValue } from '../strict-json.ts';
import { own } from './carry.ts';
import type { V5Root } from './extract.ts';

/** The newer viewer's hand-authored analysis lives in this code module, which merges `const X = {…}` into DATA at run time. */
export const OVERLAY_MODULE = 'mod_00_analysis.js';
export const OVERLAY_SOURCE_PATH = `${OVERLAY_MODULE}:X`;
const MODULE_MARKER = /^\/\* ===== module (\S+) ===== \*\/$/;
const LITERAL = /^\(function\(\)\{ const X = (\{.*\});$/;
const CLOSE = '})();';

/** Items in a value: list entries or object keys; text and numbers count 0. */
export const countOf = (v: JsonValue | undefined): number => (Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : 0);

/**
 * One statement by which the module merges a root of X into DATA: `assign` is `Object.assign(target, X.key)`, `push` is
 * `target.push.apply(target, X.key)`, and `fields` assigns only the named fields of X.key to the target.
 */
export interface Merge { key: string; target: string; op: 'assign' | 'push' | 'fields'; fields?: readonly string[] }

/** The merges of the V1 builder's analysis module, in its order, as counted from the newer export (GRS-149). */
export const V1_MERGES: readonly Merge[] = [
  { key: 'matter', target: 'DATA.matter', op: 'assign' },
  { key: 'timeline', target: 'DATA.timeline', op: 'fields', fields: ['phases', 'events'] },
  { key: 'riskMatrix', target: 'DATA.riskMatrix', op: 'push' },
  { key: 'legality', target: 'DATA.lit.legality', op: 'assign' },
  { key: 'defenceMatrix', target: 'DATA.defenceMatrix', op: 'push' },
  { key: 'elements', target: 'DATA.lit.elements', op: 'push' },
  { key: 'recon', target: 'DATA.lit.recon', op: 'push' },
  { key: 'settlement', target: 'DATA.lit.settlement', op: 'assign' },
  { key: 'enforcement', target: 'DATA.lit.enforcement', op: 'push' },
  { key: 'organogram', target: 'DATA.organogram', op: 'assign' },
  { key: 'witnesses', target: 'DATA.witnesses', op: 'push' },
  { key: 'anchors', target: 'DATA.anchors', op: 'push' },
  { key: 'contradictions', target: 'DATA.contradictions', op: 'assign' },
  { key: 'authorities', target: 'DATA.lit.authorities', op: 'push' },
  { key: 'crossexam_seed', target: 'DATA.lit.crossexam_seed', op: 'push' },
  { key: 'infoRequired', target: 'DATA.infoRequired', op: 'push' },
  { key: 'prescription', target: 'DATA.lit.prescription', op: 'push' },
  { key: 'prescSummary', target: 'DATA.lit.prescSummary', op: 'assign' },
  { key: 'interestBasis', target: 'DATA.lit.interestBasis', op: 'assign' },
];

/** A merge as the builder writes it. Statements are recognised by their text only; nothing in the module is evaluated. */
export const statementOf = (m: Merge): string =>
  m.op === 'assign' ? `Object.assign(${m.target}, X.${m.key})`
  : m.op === 'push' ? `${m.target}.push.apply(${m.target}, X.${m.key})`
  : `Object.assign(${m.target}, {${(m.fields ?? []).map((f) => `${f}: X.${m.key}.${f}`).join(', ')}})`;
const PINNED: ReadonlyMap<string, Merge> = new Map(V1_MERGES.map((m) => [statementOf(m), m]));

/**
 * The module's literal and the pinned merges among the statements that close it, in their order. `unrecognised` and
 * `repeated` count the statements that are not a pinned merge, and the pinned ones written again; when either is above
 * 0, `merges` is empty, because the module does something other than the V1 builder's merges.
 */
export interface AnalysisModule { X: JsonObject; merges: Merge[]; unrecognised: number; repeated: number }

/**
 * Finds the one line-anchored `(function(){ const X = {…};` of the analysis module and parses it as strict JSON, never
 * evaluating it. The statements after it, up to the line that ends `})();` within the same script, are matched by text
 * against the V1 builder's merges, and each must be one of them, once; otherwise no merge applies. Returns null, with a
 * warning, when the module is present but the literal cannot be read; returns null silently when the export has no
 * such module.
 */
export function readAnalysisOverlay(text: string, sink: DiagSink): AnalysisModule | null {
  const lines = text.split('\n');
  let inModule = false;
  let seen = false;
  const found: { n: number; json: string; tail: string[] | null }[] = [];
  let open: string[] | null = null;
  lines.forEach((raw, n) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const marker = MODULE_MARKER.exec(line);
    if (marker) { inModule = marker[1] === OVERLAY_MODULE; seen ||= inModule; open = null; return; }
    const lit = inModule ? LITERAL.exec(line) : null;
    if (lit) { open = []; found.push({ n: n + 1, json: lit[1]!, tail: null }); return; }
    if (!open) return;
    if (line.includes('</script>')) { open = null; return; }
    open.push(line);
    if (line.trimEnd().endsWith(CLOSE)) { found[found.length - 1]!.tail = open; open = null; }
  });
  if (!seen) return null;
  const at = { file: 'input', subject: OVERLAY_SOURCE_PATH };
  if (found.length !== 1) {
    sink.add('V5_OVERLAY_UNREADABLE', `${OVERLAY_MODULE} holds ${found.length} line-anchored "const X = {…};" literals and exactly one is read; none of its analysis is imported`, at);
    return null;
  }
  const { n, json, tail } = found[0]!;
  try {
    const v = parseStrictJson(json);
    if (isObject(v)) return { X: v, ...mergesOf(tail) };
    sink.add('V5_OVERLAY_UNREADABLE', `${OVERLAY_MODULE} line ${n}: the literal is not an object; none of its analysis is imported`, at);
  } catch (e) {
    if (!(e instanceof StrictJsonError)) throw e;
    sink.add('V5_OVERLAY_UNREADABLE', `${OVERLAY_MODULE} line ${n}: the literal is not strict JSON (${e.code}); none of its analysis is imported`, { ...at, pointer: e.pointer });
  }
  return null;
}

/**
 * The merges among the statements before `})();`, which fail closed: every non-empty `;` segment must be a pinned
 * statement and may appear once. Anything else (an assignment, a comment, a string, a repeat) is counted and no merge
 * applies, because the viewer would run it. A module that never closes its function runs no merge.
 */
function mergesOf(tail: string[] | null): Pick<AnalysisModule, 'merges' | 'unrecognised' | 'repeated'> {
  const none = { merges: [], unrecognised: 0, repeated: 0 };
  if (!tail) return none;
  const body = tail.join('\n').trimEnd().slice(0, -CLOSE.length);
  const merges: Merge[] = [];
  let unrecognised = 0;
  let repeated = 0;
  for (const seg of body.split(';').map((x) => x.trim()).filter(Boolean)) {
    const m = PINNED.get(seg);
    if (!m) unrecognised++;
    else if (merges.includes(m)) repeated++;
    else merges.push(m);
  }
  return unrecognised || repeated ? { ...none, unrecognised, repeated } : { merges, unrecognised, repeated };
}

type Roots = Partial<Record<V5Root, JsonValue>>;

const at = (o: JsonValue | undefined, segs: readonly string[]): JsonValue | undefined =>
  segs.reduce<JsonValue | undefined>((v, s) => (isObject(v) && Object.hasOwn(v, s) ? v[s] : undefined), o);
const put = (o: JsonObject, segs: readonly string[], v: JsonValue): JsonObject =>
  own({ ...o }, segs[0]!, segs.length === 1 ? v : put(o[segs[0]!] as JsonObject, segs.slice(1), v));
const assigned = (into: JsonObject, from: JsonObject): JsonObject => { const out = { ...into }; for (const [k, v] of Object.entries(from)) own(out, k, v); return out; };

/**
 * DATA as the viewer has it after the module's merges, built by copying. A merge applies only when X holds its root
 * and the DATA slot is the kind the statement needs (an object to assign to, a list to push onto); the viewer could
 * not merge anything else either. Whatever no merge placed stays in `rest`, so nothing is dropped; `placed` lists the
 * merges that applied.
 */
export function mergeAnalysis(roots: Roots, analysis: AnalysisModule): { roots: Roots; rest: JsonObject; placed: Merge[] } {
  const rest: JsonObject = {};
  const placed: Merge[] = [];
  for (const [k, v] of Object.entries(analysis.X)) own(rest, k, v);
  let DATA = roots.DATA;
  for (const m of analysis.merges) {
    if (!isObject(DATA) || !Object.hasOwn(rest, m.key)) continue;
    const v = rest[m.key]!;
    const segs = m.target.split('.').slice(1);
    const slot = at(DATA, segs);
    let merged: JsonValue | undefined;
    let left: JsonObject | undefined;
    if (m.op === 'push') merged = Array.isArray(slot) && Array.isArray(v) ? [...slot, ...v] : undefined;
    else if (!isObject(slot) || !isObject(v)) merged = undefined;
    else if (m.op === 'assign') merged = assigned(slot, v);
    else {
      const fields = m.fields ?? [];
      const taken: JsonObject = {};
      left = {};
      for (const [k, x] of Object.entries(v)) own(fields.includes(k) ? taken : left, k, x);
      merged = assigned(slot, taken);
    }
    if (merged === undefined) continue;
    DATA = put(DATA, segs, merged);
    placed.push(m);
    if (left && Object.keys(left).length) rest[m.key] = left;
    else delete rest[m.key];
  }
  return { roots: { ...roots, DATA }, rest, placed };
}
