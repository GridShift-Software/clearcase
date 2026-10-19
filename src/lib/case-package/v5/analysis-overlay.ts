import type { DiagSink } from '../diagnostics.ts';
import { isObject, parseStrictJson, StrictJsonError, type JsonObject, type JsonValue } from '../strict-json.ts';

/** The newer viewer's hand-authored analysis lives in this code module, which merges `const X = {…}` into DATA at run time. */
export const OVERLAY_MODULE = 'mod_00_analysis.js';
export const OVERLAY_SOURCE_PATH = `${OVERLAY_MODULE}:X`;
const MODULE_MARKER = /^\/\* ===== module (\S+) ===== \*\/$/;
const LITERAL = /^\(function\(\)\{ const X = (\{.*\});$/;

/** Items in a value: list entries or object keys; text and numbers count 0. */
export const countOf = (v: JsonValue | undefined): number => (Array.isArray(v) ? v.length : isObject(v) ? Object.keys(v).length : 0);

/**
 * Finds the one line-anchored `(function(){ const X = {…};` of the analysis module and parses it as strict JSON,
 * never evaluating it. Returns null, with a warning, when the module is present but the literal cannot be read;
 * returns null silently when the export has no such module.
 */
export function readAnalysisOverlay(text: string, sink: DiagSink): JsonObject | null {
  const lines = text.split('\n');
  let inModule = false;
  let seen = false;
  const found: { n: number; json: string }[] = [];
  lines.forEach((raw, n) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const marker = MODULE_MARKER.exec(line);
    if (marker) { inModule = marker[1] === OVERLAY_MODULE; seen ||= inModule; return; }
    const lit = inModule ? LITERAL.exec(line) : null;
    if (lit) found.push({ n: n + 1, json: lit[1]! });
  });
  if (!seen) return null;
  const at = { file: 'input', subject: OVERLAY_SOURCE_PATH };
  if (found.length !== 1) {
    sink.add('V5_OVERLAY_UNREADABLE', `${OVERLAY_MODULE} holds ${found.length} line-anchored "const X = {…};" literals and exactly one is read; none of its analysis is imported`, at);
    return null;
  }
  try {
    const v = parseStrictJson(found[0]!.json);
    if (isObject(v)) return v;
    sink.add('V5_OVERLAY_UNREADABLE', `${OVERLAY_MODULE} line ${found[0]!.n}: the literal is not an object; none of its analysis is imported`, at);
  } catch (e) {
    if (!(e instanceof StrictJsonError)) throw e;
    sink.add('V5_OVERLAY_UNREADABLE', `${OVERLAY_MODULE} line ${found[0]!.n}: the literal is not strict JSON (${e.code}); none of its analysis is imported`, { ...at, pointer: e.pointer });
  }
  return null;
}
