// Data-only extraction from the v5 workspace HTML. The HTML and its JavaScript are treated as
// opaque text: four anchored payload lines are sliced and handed to the strict JSON parser.
// Nothing is evaluated; a payload that is not pure JSON is refused. NAV, IC, STORE_KEYS and
// the other code literals are viewer code and are only listed as ignored.
import type { DiagSink } from '../diagnostics.ts';
import { decodeUtf8Strict, isObject, parseStrictJson, StrictJsonError, type JsonValue } from '../strict-json.ts';

export const V5_ROOTS = ['DATA', 'META', 'window.__SCHED__', 'window.__CASELINES_IDX__'] as const;
export type V5Root = (typeof V5_ROOTS)[number];
const REQUIRED: readonly V5Root[] = ['DATA', 'META'];
/** App code literals: viewer code, never imported. */
export const V5_CODE_LITERALS = ['NAV', 'IC', 'STORE_KEYS', 'ENF_OPTS', 'CBK', 'CBPH', 'CBHF', 'IFRAME_EXT'];

const ASSIGN = /^(?:const (DATA|META)|window\.(__SCHED__|__CASELINES_IDX__)) = (.*)$/;
const ASSIGN_LOOSE = /^\s*(?:(?:const|let|var)\s+(DATA|META)|window\.(__SCHED__|__CASELINES_IDX__))\s*=/;

export interface V5Source {
  roots: Partial<Record<V5Root, JsonValue>>;
  lines: Partial<Record<V5Root, number>>;
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
  const out: V5Source = { roots: {}, lines: {}, html: { bytes: bytes.length, lineCount: lines.length, bom, crlf }, codeLiteralsSeen: [] };
  const seen = new Map<V5Root, number>();
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n]!.endsWith('\r') ? lines[n]!.slice(0, -1) : lines[n]!;
    const loose = ASSIGN_LOOSE.exec(line);
    if (!loose) {
      const lit = /^\s*(?:const|let|var)\s+([A-Z_]+)\s*=/.exec(line);
      if (lit && V5_CODE_LITERALS.includes(lit[1]!)) out.codeLiteralsSeen.push(lit[1]!);
      continue;
    }
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
    try {
      out.roots[root] = parseStrictJson(rhs.slice(0, -1));
      out.lines[root] = n + 1;
    } catch (e) {
      if (!(e instanceof StrictJsonError)) throw e;
      sink.add(e.code === 'JSON_MALFORMED' ? 'V5_PAYLOAD_NOT_JSON' : e.code, `${root} at line ${n + 1}: ${e.message}`, { ...at, pointer: e.pointer });
    }
  }
  for (const r of REQUIRED) if (!seen.has(r)) sink.add('V5_PAYLOAD_MISSING', `${r} payload line not found`, { file: 'input', subject: r });
  for (const r of V5_ROOTS) if ((seen.get(r) ?? 0) > 1) delete out.roots[r];
  if (out.roots.DATA !== undefined && !isObject(out.roots.DATA)) sink.add('V5_PAYLOAD_NOT_JSON', 'DATA must be a JSON object', { file: 'input', subject: 'DATA' });
  if (out.roots.META !== undefined && !isObject(out.roots.META)) sink.add('V5_PAYLOAD_NOT_JSON', 'META must be a JSON object', { file: 'input', subject: 'META' });
  return sink.errors === 0 ? out : null;
}
