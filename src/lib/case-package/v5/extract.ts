// Data-only extraction from the workspace HTML. The HTML and its JavaScript are treated as opaque
// text. Two generations are read, never evaluated:
//  * v5: four anchored payload lines (`const DATA = `, `const META = `, `window.__SCHED__ = `,
//    `window.__CASELINES_IDX__ = `) are sliced and handed to the strict JSON parser;
//  * the newer generation: the `<script id="app-data">` and `<script id="app-seed">` JSON script
//    tags are parsed the same way and mapped onto the v5 roots (json-workspace.ts).
// A payload that is not pure JSON is refused. NAV, IC, STORE_KEYS and the other code literals are
// viewer code and are only listed as ignored.
import type { DiagSink } from '../diagnostics.ts';
import { decodeUtf8Strict, isObject, parseStrictJson, StrictJsonError, type JsonValue } from '../strict-json.ts';
import { JSON_SCRIPT_IDS, toV5Roots, type JsonScriptId } from './json-workspace.ts';
import { isNewerGeneration } from './newer-workspace.ts';

export const V5_ROOTS = ['DATA', 'META', 'window.__SCHED__', 'window.__CASELINES_IDX__'] as const;
export type V5Root = (typeof V5_ROOTS)[number];
const REQUIRED: readonly V5Root[] = ['DATA', 'META'];
/** App code literals: viewer code, never imported. */
export const V5_CODE_LITERALS = ['NAV', 'IC', 'STORE_KEYS', 'ENF_OPTS', 'CBK', 'CBPH', 'CBHF', 'IFRAME_EXT'];

const ASSIGN = /^(?:const (DATA|META)|window\.(__SCHED__|__CASELINES_IDX__)) = (.*)$/;
const ASSIGN_LOOSE = /^\s*(?:(?:const|let|var)\s+(DATA|META)|window\.(__SCHED__|__CASELINES_IDX__))\s*=/;
const JSON_SCRIPT = /^\s*<script id="(app-data|app-seed)" type="application\/json">(.*)<\/script>\s*$/;

/**
 * Which generation of the workspace HTML the data was read from: the v5 payload lines, the same lines written by the
 * newer builder (`v5-js-newer`: META.version, a profile, changed dataset shapes), or the JSON script tags.
 */
export type Generation = 'v5-js' | 'v5-js-newer' | 'json-script';

export interface V5Source {
  generation: Generation;
  roots: Partial<Record<V5Root, JsonValue>>;
  /** 1-based line of each payload read as data: a v5 root, or a JSON script id */
  lines: Partial<Record<V5Root | JsonScriptId, number>>;
  html: { bytes: number; lineCount: number; bom: boolean; crlf: boolean };
  codeLiteralsSeen: string[];
}

export function extractV5(bytes: Uint8Array, sink: DiagSink): V5Source | null {
  let bom = false;
  let body = bytes;
  if (body.length >= 3 && body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) { bom = true; body = body.subarray(3); }
  let text: string;
  try {
    text = decodeUtf8Strict(body);
  } catch (e) {
    sink.add('JSON_BAD_UTF8', `workspace HTML is not valid UTF-8 (${(e as Error).message})`, { file: 'input' });
    return null;
  }
  const lines = text.split('\n');
  const crlf = lines.length > 1 && lines.every((l, i) => i === lines.length - 1 || l.endsWith('\r'));
  const out: V5Source = { generation: 'v5-js', roots: {}, lines: {}, html: { bytes: bytes.length, lineCount: lines.length, bom, crlf }, codeLiteralsSeen: [] };
  // the newer viewer reads its own JSON script (`var DATA = JSON.parse(...)`, `var META = DATA.meta`): code, not payload
  const jsonGeneration = lines.some((l) => l.includes('<script id="app-data"'));
  const seen = new Map<V5Root | JsonScriptId, number>();
  const scripts: Partial<Record<JsonScriptId, JsonValue>> = {};
  const parse = (name: V5Root | JsonScriptId, json: string, n: number, at: { file: string; subject: string }): JsonValue | undefined => {
    try {
      return parseStrictJson(json);
    } catch (e) {
      if (!(e instanceof StrictJsonError)) throw e;
      sink.add(e.code === 'JSON_MALFORMED' ? 'V5_PAYLOAD_NOT_JSON' : e.code, `${name} at line ${n + 1}: ${e.message}`, { ...at, pointer: e.pointer });
      return undefined;
    }
  };
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.endsWith('\r') ? lines[n]!.slice(0, -1) : lines[n]!;
    const loose = ASSIGN_LOOSE.exec(line);
    if (!loose) {
      const script = line.includes('<script id="app-') ? JSON_SCRIPT.exec(line) : null;
      if (script) {
        const id = script[1] as JsonScriptId;
        seen.set(id, (seen.get(id) ?? 0) + 1);
        if (seen.get(id)! > 1) { sink.add('V5_PAYLOAD_AMBIGUOUS', `${id} appears more than once (line ${n + 1})`, { file: 'input', subject: id }); continue; }
        const v = parse(id, script[2]!, n, { file: 'input', subject: id });
        if (v !== undefined) { scripts[id] = v; out.lines[id] = n + 1; }
        continue;
      }
      const lit = /^\s*(?:const|let|var)\s+([A-Z_]+)\s*=/.exec(line);
      if (lit && V5_CODE_LITERALS.includes(lit[1]!)) out.codeLiteralsSeen.push(lit[1]!);
      continue;
    }
    if (jsonGeneration && !/^[\[{]/.test(ASSIGN.exec(line)?.[3] ?? '')) continue;
    const root = (loose[1] ?? `window.${loose[2]}`) as V5Root;
    const at = { file: 'input', subject: root };
    seen.set(root, (seen.get(root) ?? 0) + 1);
    if (seen.get(root)! > 1) { sink.add('V5_PAYLOAD_AMBIGUOUS', `${root} is assigned more than once (line ${n + 1})`, at); continue; }
    const m = ASSIGN.exec(line);
    if (!m) { sink.add('V5_PAYLOAD_NOT_JSON', `${root} at line ${n + 1} is not "<name> = <json>;" at the start of a line`, at); continue; }
    const rhs = m[3]!.replace(/\s+$/, '');
    if (/^(?:JSON\.parse|atob|decodeURIComponent|unescape|eval|Function|new\s)/.test(rhs) || /^[A-Za-z_$]/.test(rhs)) {
      sink.add('V5_PAYLOAD_ENCODED', `${root} at line ${n + 1} is computed or encoded, not a JSON literal; refused, never evaluated`, at);
      continue;
    }
    if (!rhs.endsWith(';')) { sink.add('V5_PAYLOAD_NOT_JSON', `${root} at line ${n + 1} does not end with ";"`, at); continue; }
    const v = parse(root, rhs.slice(0, -1), n, at);
    if (v !== undefined) { out.roots[root] = v; out.lines[root] = n + 1; }
  }
  for (const id of JSON_SCRIPT_IDS) if ((seen.get(id) ?? 0) > 1) delete scripts[id];
  for (const r of V5_ROOTS) if ((seen.get(r) ?? 0) > 1) delete out.roots[r];
  if (seen.has('app-data')) {
    if (V5_ROOTS.some((r) => seen.has(r))) sink.add('V5_PAYLOAD_AMBIGUOUS', 'the HTML carries both v5 data lines and an app-data JSON script', { file: 'input', subject: 'app-data' });
    else if (scripts['app-data'] !== undefined) {
      out.generation = 'json-script';
      const data = scripts['app-data'], seed = scripts['app-seed'] ?? {};
      if (!isObject(data)) sink.add('V5_PAYLOAD_NOT_JSON', 'app-data must be a JSON object', { file: 'input', subject: 'app-data' });
      else if (!isObject(seed)) sink.add('V5_PAYLOAD_NOT_JSON', 'app-seed must be a JSON object', { file: 'input', subject: 'app-seed' });
      else out.roots = toV5Roots(data, seed, sink);
    }
  } else for (const r of REQUIRED) if (!seen.has(r)) sink.add('V5_PAYLOAD_MISSING', `${r} payload line not found`, { file: 'input', subject: r });
  if (out.roots.DATA !== undefined && !isObject(out.roots.DATA)) sink.add('V5_PAYLOAD_NOT_JSON', 'DATA must be a JSON object', { file: 'input', subject: 'DATA' });
  if (out.roots.META !== undefined && !isObject(out.roots.META)) sink.add('V5_PAYLOAD_NOT_JSON', 'META must be a JSON object', { file: 'input', subject: 'META' });
  if (out.generation === 'v5-js' && isObject(out.roots.DATA) && isObject(out.roots.META) && isNewerGeneration(out.roots.DATA, out.roots.META)) out.generation = 'v5-js-newer';
  return sink.errors === 0 ? out : null;
}
