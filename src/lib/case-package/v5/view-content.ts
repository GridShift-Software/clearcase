import type { DiagSink } from '../diagnostics.ts';
import { Code, decodeEntities, findScope, hasReserved, markupStream, markupText, parseHtml, partsOf, poison, scriptRegions, select, SENT_CLOSE, SENT_OPEN, tokenize, type El, type Part, type Range, type ScopeSpec, type Stream } from './js-scan.ts';

import type { ViewValue } from '../view-content.ts';

export type { ViewValue };
export type ViewContent = Record<string, Record<string, ViewValue>>;

export type Selector =
  | { call: string; arg: number; nth?: number }
  | { lit: 'table' | 'array' | 'object'; binding?: string; nth?: number; path: (string | number)[] }
  | { ret: number }
  | { orDefault: string }
  | { pattern: string; on?: 'str' | 're'; nth?: number }
  | { html: string; attr?: string; all?: boolean };

export interface Param { name: string; expect: string }

export interface Entry {
  view: string;
  field: string;
  checklist: string;
  scope: ScopeSpec;
  sel: Selector;
  kind: 'text' | 'template' | 'number' | 'list';
  markup?: boolean;
  params?: Param[];
  fallback?: boolean;
  required: boolean;
}

export interface Omission { view: string; field: string; checklist: string; reason: string }

export interface FieldStatus { view: string; field: string; status: 'extracted' | 'missing' | 'ambiguous' | 'shape'; line: number | null; detail?: string }

export interface ViewContentResult {
  data: ViewContent;
  fields: FieldStatus[];
  unmapped: { scope: string; line: number; words: number }[];
}

export const PROSE_MIN_WORDS = 8;
const WORD = /\p{L}[\p{L}\p{M}'’-]+/gu;
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/;
const PARAM_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
export const VIEW_CODE_MAX_CHARS = 8 * 1024 * 1024;
export const VIEW_CONTENT_DEADLINE_MS = 20_000;

class Miss extends Error {
  readonly status: 'missing' | 'ambiguous' | 'shape';
  constructor(status: 'missing' | 'ambiguous' | 'shape', message: string) { super(message); this.status = status; }
}

interface Sel { parts: Part[]; toks: number[]; line: number; range?: Range; list?: Part[][] }

const pick = <T>(xs: T[], nth: number | undefined, what: string): T => {
  if (nth !== undefined) { if (nth >= xs.length) throw new Miss('missing', `${what}: ${xs.length} found, #${nth} wanted`); return xs[nth]!; }
  if (xs.length === 0) throw new Miss('missing', `${what}: not found`);
  if (xs.length > 1) throw new Miss('ambiguous', `${what}: ${xs.length} candidates`);
  return xs[0]!;
};

export class ViewCodeReader {
  readonly code: Code;
  private readonly scopes = new Map<string, { range: Range; count: number; conditional: boolean } | null>();
  private readonly streams = new Map<string, { s: Stream; root: El }>();
  private readonly markupEnd: number;
  readonly size: number;
  constructor(html: string, skipLines: number[] = []) {
    const starts: number[] = [0];
    for (let k = 0; k < html.length; k++) if (html.charCodeAt(k) === 10) starts.push(k + 1);
    const cuts = skipLines.filter((n) => n >= 1 && n <= starts.length).map((n) => [starts[n - 1]!, n < starts.length ? starts[n]! : html.length] as const).sort((a, b) => a[0] - b[0]);
    const regions: [number, number][] = [];
    for (const [a, b] of scriptRegions(html)) {
      let from = a;
      for (const [c, d] of cuts) if (c >= from && c < b) { if (c > from) regions.push([from, c]); from = Math.max(from, d); }
      if (from < b) regions.push([from, b]);
    }
    this.size = regions.reduce((n, [a, b]) => n + b - a, 0);
    this.code = new Code(html, regions);
    const firstScript = html.search(/<script\b/i);
    this.markupEnd = firstScript < 0 ? html.length : firstScript;
  }

  scope(spec: ScopeSpec) {
    if (!this.scopes.has(spec)) this.scopes.set(spec, spec === 'markup' ? null : findScope(this.code, spec));
    return this.scopes.get(spec) ?? null;
  }

  private stream(spec: ScopeSpec): { s: Stream; root: El } | null {
    if (this.streams.has(spec)) return this.streams.get(spec)!;
    let s: Stream;
    if (spec === 'markup') s = { text: poison(this.code.src.slice(0, this.markupEnd)), segs: [], runs: [] };
    else { const sc = this.live(spec); s = markupStream(this.code, sc.range); }
    const v = { s, root: parseHtml(s.text) };
    this.streams.set(spec, v);
    return v;
  }

  private live(spec: ScopeSpec): { range: Range; count: number } {
    const sc = this.scope(spec);
    if (!sc) throw new Miss('missing', `scope ${spec} not found`);
    const render = spec.startsWith('render:');
    if (render && sc.conditional && sc.count === 1) throw new Miss('missing', `scope ${spec} is not proven to run`);
    if (sc.count > 1 && (!render || sc.conditional)) throw new Miss('ambiguous', `scope ${spec} is defined ${sc.count} times${sc.conditional ? ', not all unconditionally' : ''}`);
    return sc;
  }

  literalTokens(spec: ScopeSpec): number[] {
    const sc = this.scope(spec);
    if (!sc) return [];
    const out: number[] = [];
    for (let k = sc.range.a; k < sc.range.b; k++) { const t = this.code.toks[k]!; if (t.t === 'str' || t.t === 'tpl') out.push(k); }
    return out;
  }

  resolve(scope: ScopeSpec, sel: Selector): Sel {
    const C = this.code;
    const T = C.toks;
    if ('html' in sel) {
      const st = this.stream(scope)!;
      let els: El[];
      try { els = select(st.root, sel.html); } catch (e) { throw new Miss('shape', (e as Error).message); }
      const one = (el: El): { parts: Part[]; toks: number[] } => {
        const from = sel.attr ? el.start : el.innerStart, to = sel.attr ? el.innerStart : el.innerEnd;
        const toks = st.s.segs.filter((g) => g.to > from && g.from < to).map((g) => g.tok);
        if (sel.attr) {
          if (!el.attrs.has(sel.attr)) throw new Miss('missing', `attribute ${sel.attr} not present`);
          return { parts: sentinelParts(decodeEntities(el.attrs.get(sel.attr)!), st.s.runs), toks };
        }
        return { parts: sentinelParts(markupText(st.s.text.slice(from, to)), st.s.runs), toks };
      };
      const line = (el: El) => {
        const g = st.s.segs.find((x) => x.to > el.start);
        return g ? C.line(T[g.tok]!.s) : C.line(el.start);
      };
      if (sel.all) {
        if (!els.length) throw new Miss('missing', `${sel.html}: not found`);
        const each = els.map(one);
        return { parts: [], list: each.map((x) => x.parts), toks: each.flatMap((x) => x.toks), line: line(els[0]!) };
      }
      const el = pick(els, undefined, sel.html);
      return { ...one(el), line: line(el) };
    }
    const { a, b } = this.live(scope).range;
    const fromRange = (r: Range): Sel => {
      const parts = partsOf(C, r);
      return { parts, toks: parts.flatMap((p) => ('text' in p ? p.toks : [])), line: C.line(T[r.a]!.s), range: r };
    };
    if ('call' in sel) {
      const calls: number[] = [];
      for (let k = a; k < b; k++) if (C.is(k, 'id', sel.call) && C.is(k + 1, 'p', '(') && !C.is(k - 1, 'p', '.') && !C.is(k - 1, 'id', 'function')) calls.push(k);
      const k = pick(calls, sel.nth, `call ${sel.call}()`);
      const args = C.elements(k + 1);
      if (!args[sel.arg]) throw new Miss('shape', `call ${sel.call}() has ${args.length} arguments`);
      const [x, y] = args[sel.arg]!;
      return fromRange({ a: x, b: y });
    }
    if ('ret' in sel) {
      const rets: number[] = [];
      for (let k = a; k < b; k++) if (C.is(k, 'id', 'return')) rets.push(k);
      const k = pick(rets, sel.ret, 'return');
      return fromRange({ a: k + 1, b: C.exprEnd(k + 1, b) });
    }
    if ('orDefault' in sel) {
      const path = sel.orDefault.split('.');
      const hits: number[] = [];
      for (let k = a; k < b; k++) {
        let j = k, ok = true;
        for (let n = 0; n < path.length && ok; n++) { ok = C.is(j, 'id', path[n]!) && (n === path.length - 1 || C.is(j + 1, 'p', '.')); j += n === path.length - 1 ? 1 : 2; }
        if (ok && !C.is(k - 1, 'p', '.') && C.is(j, 'p', '||') && C.is(j + 1, 'str')) hits.push(j + 1);
      }
      const k = pick(hits, undefined, `${sel.orDefault} || <default>`);
      return fromRange({ a: k, b: k + 1 });
    }
    if ('pattern' in sel) {
      let re: RegExp;
      try { re = new RegExp(sel.pattern, 's'); } catch (e) { throw new Miss('shape', (e as Error).message); }
      const hits: { k: number; v: string }[] = [];
      for (let k = a; k < b; k++) {
        const t = T[k]!;
        if (sel.on === 're' ? t.t !== 're' : t.t !== 'str' && t.t !== 'tpl') continue;
        const m = re.exec(t.v as string);
        if (m && m[1] !== undefined) hits.push({ k, v: poison(m[1]) });
      }
      const h = pick(hits, sel.nth, `pattern /${sel.pattern}/`);
      return { parts: [{ text: h.v, toks: [h.k] }], toks: [h.k], line: C.line(T[h.k]!.s) };
    }
    let k: number;
    const opener = sel.lit === 'object' ? '{' : '[';
    if (scope.startsWith('const:') && sel.binding === undefined && sel.nth === undefined) k = a;
    else if (sel.binding !== undefined) {
      const hits: number[] = [];
      for (let j = a; j < b; j++) if ((C.is(j, 'id', 'const') || C.is(j, 'id', 'let') || C.is(j, 'id', 'var')) && C.is(j + 1, 'id', sel.binding) && C.is(j + 2, 'p', '=')) hits.push(j + 3);
      k = pick(hits, undefined, `binding ${sel.binding}`);
    } else {
      const hits: number[] = [];
      for (let j = a; j < b; j++) {
        if (!C.is(j, 'p', opener) || !isExprStart(C, j - 1)) continue;
        if (sel.lit === 'table' && !C.is(j + 1, 'p', '[')) continue;
        hits.push(j);
      }
      k = pick(hits, sel.nth, `${sel.lit} literal`);
    }
    if (!C.is(k, 'p', opener)) throw new Miss('shape', `not an ${sel.lit} literal`);
    let r: Range = { a: k, b: C.matchOf(k) + 1 };
    for (const step of sel.path) {
      if (!C.is(r.a, 'p', typeof step === 'number' ? '[' : '{') || C.matchOf(r.a) !== r.b - 1) throw new Miss('shape', `path step ${step} is not inside a literal`);
      const els = C.elements(r.a);
      if (typeof step === 'number') {
        if (!els[step]) throw new Miss('missing', `element ${step} not present`);
        r = { a: els[step]![0], b: els[step]![1] };
      } else {
        const props = els.filter(([x]) => (C.is(x, 'id', step) || C.is(x, 'str', step)) && C.is(x + 1, 'p', ':'));
        const prop = pick(props, undefined, `property ${step}`);
        r = { a: prop[0] + 2, b: prop[1] };
      }
    }
    if (C.is(r.a, 'p', '[') && C.matchOf(r.a) === r.b - 1) {
      const items = C.elements(r.a).map(([x, y]) => partsOf(C, { a: x, b: y }));
      return { parts: [], list: items, toks: items.flat().flatMap((p) => ('text' in p ? p.toks : [])), line: C.line(T[r.a]!.s), range: r };
    }
    return fromRange(r);
  }

  extract(e: Entry): { value?: ViewValue; status: FieldStatus; toks: number[] } {
    const base = { view: e.view, field: e.field };
    try {
      const s = this.resolve(e.scope, e.sel);
      const finish = (parts: Part[]) => (e.markup && !('html' in e.sel) ? remark(parts) : parts);
      let value: ViewValue;
      switch (e.kind) {
        case 'text': {
          const p = finish(s.parts);
          if (s.list || p.some((x) => 'code' in x)) throw new Miss('shape', 'expected literal text, found code');
          value = p.map((x) => (x as { text: string }).text).join('');
          if (!value.trim()) throw new Miss('shape', 'empty text');
          break;
        }
        case 'template': {
          const p = finish(s.parts);
          const codes = p.filter((x): x is { code: Range } => 'code' in x);
          const want = e.params ?? [];
          if (s.list || codes.length !== want.length) throw new Miss('shape', `expected ${want.length} interpolations, found ${codes.length}`);
          codes.forEach((c, i) => { if (!sameTokens(this.code, c.code, want[i]!.expect)) throw new Miss('shape', `interpolation ${i + 1} does not read ${want[i]!.expect}`); });
          if (!p.some((x) => 'text' in x && x.text.trim())) throw new Miss('shape', 'template without literal text');
          let n = 0;
          value = { template: p.filter((x) => !('text' in x) || x.text.length > 0).map((x) => ('text' in x ? x.text : { param: want[n++]!.name })) };
          break;
        }
        case 'number': {
          let num: number | null = null;
          if (s.range) {
            let r = s.range;
            if (e.fallback) {
              const T = this.code.toks;
              let last = -1;
              for (let j = r.a; j < r.b; j++) { if (C_is(T, j, '||') || C_is(T, j, '??')) last = j; const t = T[j]!; if (t.t === 'p' && (t.v === '(' || t.v === '[' || t.v === '{') && this.code.matchOf(j) > j) j = this.code.matchOf(j); }
              if (last < 0) throw new Miss('shape', 'no default operand');
              r = { a: last + 1, b: r.b };
            }
            const neg = this.code.is(r.a, 'p', '-');
            const t = this.code.toks[neg ? r.a + 1 : r.a];
            if (t?.t === 'num' && r.b === (neg ? r.a + 2 : r.a + 1)) num = neg ? -t.v : t.v;
            if (num !== null) s.toks.push(neg ? r.a + 1 : r.a);
          } else if (s.parts.length === 1 && 'text' in s.parts[0]! && NUMBER_TEXT.test(s.parts[0].text.trim())) num = Number(s.parts[0].text.trim());
          if (num === null || !Number.isFinite(num)) throw new Miss('shape', 'expected a number literal');
          value = num;
          break;
        }
        case 'list': {
          if (!s.list) throw new Miss('shape', 'expected a list');
          value = s.list.map((item) => {
            const p = finish(item);
            if (p.some((x) => 'code' in x)) throw new Miss('shape', 'list item is code');
            return p.map((x) => (x as { text: string }).text).join('');
          });
          if (!(value as string[]).length) throw new Miss('shape', 'empty list');
          break;
        }
      }
      const strings = typeof value === 'string' ? [value] : Array.isArray(value) ? value : typeof value === 'object' ? value.template.filter((x): x is string => typeof x === 'string') : [];
      if (strings.some(hasReserved)) throw new Miss('shape', 'the literal holds a reserved private-use character');
      return { value, status: { ...base, status: 'extracted', line: s.line }, toks: s.toks };
    } catch (err) {
      if (!(err instanceof Miss)) throw err;
      return { status: { ...base, status: err.status, line: null, detail: err.message }, toks: [] };
    }
  }
}

const C_is = (T: Code['toks'], j: number, v: string) => T[j]?.t === 'p' && T[j]!.v === v;

function sameTokens(C: Code, r: Range, expect: string): boolean {
  let { a, b } = r;
  while (a < b && C.is(a, 'p', '+')) a++;
  while (b > a && C.is(b - 1, 'p', '+')) b--;
  const want = tokenize(expect);
  if (want.length !== b - a) return false;
  return want.every((w, i) => { const t = C.toks[a + i]!; return t.t === w.t && t.v === w.v; });
}

function isExprStart(C: Code, k: number): boolean {
  const t = C.toks[k];
  if (!t) return true;
  if (t.t === 'id') return /^(?:return|case|in|of|typeof|void|yield|await)$/.test(t.v);
  if (t.t === 'p') return t.v !== ')' && t.v !== ']' && t.v !== '}';
  return false;
}

function dropOpenTail(s: string): string {
  const re = /<[A-Za-z!]/g;
  re.lastIndex = s.lastIndexOf('>') + 1;
  const m = re.exec(s);
  return m ? s.slice(0, m.index) : s;
}

function sentinelParts(text: string, runs: Range[]): Part[] {
  const out: Part[] = [];
  const re = new RegExp(`${SENT_OPEN}(\\d+)${SENT_CLOSE}`, 'g');
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index), toks: [] });
    const run = runs[Number(m[1])];
    if (!run) throw new Miss('shape', 'marker without a code run');
    out.push({ code: run });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), toks: [] });
  return out;
}

function remark(parts: Part[]): Part[] {
  const codes: Range[] = [];
  const joined = parts.map((p) => ('text' in p ? p.text : SENT_OPEN + (codes.push(p.code) - 1) + SENT_CLOSE)).join('');
  return sentinelParts(markupText(joined), codes);
}

export function checkMap(entries: readonly Entry[], omissions: readonly Omission[]): void {
  const seen = new Set<string>();
  for (const e of [...entries, ...omissions]) {
    const id = `${e.view}.${e.field}`;
    if (seen.has(id)) throw new Error(`view-content map: duplicate ${id}`);
    seen.add(id);
    if (!/^_?[a-z][a-z0-9_]*$/.test(e.view) || !/^[a-z][A-Za-z0-9]*$/.test(e.field)) throw new Error(`view-content map: bad id ${id}`);
  }
  for (const e of entries) {
    for (const p of e.params ?? []) if (!PARAM_NAME.test(p.name)) throw new Error(`view-content map: bad param ${p.name} in ${e.view}.${e.field}`);
    if ((e.kind === 'template') !== (e.params !== undefined)) throw new Error(`view-content map: params belong to templates only (${e.view}.${e.field})`);
  }
}

export function extractViewContent(html: string, entries: readonly Entry[], omissions: readonly Omission[], opts: { skipLines?: number[]; audit?: readonly ScopeSpec[]; sink?: DiagSink; maxChars?: number; deadlineMs?: number } = {}): ViewContentResult {
  checkMap(entries, omissions);
  const started = Date.now();
  const maxChars = opts.maxChars ?? VIEW_CODE_MAX_CHARS, deadlineMs = opts.deadlineMs ?? VIEW_CONTENT_DEADLINE_MS;
  const stop = (why: string): ViewContentResult => {
    opts.sink?.add('V5_VIEW_CONTENT_LIMIT', `view-content extraction stopped: ${why}; no view content extracted`, { file: 'input', subject: 'view-content' });
    return { data: {}, fields: entries.map((e) => ({ view: e.view, field: e.field, status: 'missing', line: null, detail: why })), unmapped: [] };
  };
  if (html.length > maxChars * 2) return stop(`the HTML exceeds ${maxChars * 2} characters`);
  const reader = new ViewCodeReader(html, opts.skipLines);
  if (reader.size > maxChars) return stop(`the viewer code exceeds ${maxChars} characters`);
  const late = () => Date.now() - started > deadlineMs;
  const data: ViewContent = {};
  const fields: FieldStatus[] = [];
  const consumed = new Set<number>();
  for (const e of entries) {
    if (late()) return stop(`the ${deadlineMs} ms deadline passed`);
    const r = reader.extract(e);
    fields.push(r.status);
    r.toks.forEach((k) => consumed.add(k));
    if (r.value !== undefined) (data[e.view] ??= {})[e.field] = r.value;
    else if (opts.sink && (e.required || r.status.status === 'ambiguous')) {
      const code = r.status.status === 'ambiguous' ? 'V5_VIEW_CONTENT_AMBIGUOUS' : 'V5_VIEW_CONTENT_MISSING';
      opts.sink.add(code, `${e.view}.${e.field} (${e.checklist}): ${r.status.detail}; not extracted`, { file: 'input', subject: `${e.view}.${e.field}` });
    }
  }
  const unmapped: ViewContentResult['unmapped'] = [];
  for (const spec of opts.audit ?? []) {
    if (late()) return stop(`the ${deadlineMs} ms deadline passed`);
    for (const k of reader.literalTokens(spec)) {
      if (consumed.has(k)) continue;
      const t = reader.code.toks[k]!;
      const visible = markupText(dropOpenTail((t.v as string).replace(/^[^<]*?(?:"|')\s*\/?>/, '')));
      const words = (visible.match(WORD) ?? []).length;
      if (words < PROSE_MIN_WORDS) continue;
      const line = reader.code.line(t.s);
      unmapped.push({ scope: spec, line, words });
    }
  }
  const sorted: ViewContent = {};
  for (const v of Object.keys(data).sort()) sorted[v] = Object.fromEntries(Object.keys(data[v]!).sort().map((f) => [f, data[v]![f]!]));
  return { data: sorted, fields, unmapped };
}
