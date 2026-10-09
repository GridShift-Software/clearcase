// Static reading of the v5 viewer code, for the view-content extraction. The HTML and its
// JavaScript are opaque text: script blocks are tokenized (strings, templates, regex literals,
// numbers, identifiers, punctuators) and nothing is evaluated. Scopes (a RENDER.<view> body,
// a named function, a constant's initializer, the static page markup) are found by code shape,
// and selectors read literal values out of them. A selector never matches on case text.

export type Tok =
  /** string literal or template without substitutions; v = cooked value */
  | { t: 'str'; v: string; s: number; e: number }
  /** template chunk around ${...} substitutions */
  | { t: 'tpl'; v: string; s: number; e: number; part: 'head' | 'mid' | 'tail' }
  | { t: 'num'; v: number; s: number; e: number }
  | { t: 'id'; v: string; s: number; e: number }
  | { t: 'p'; v: string; s: number; e: number }
  /** regex literal; v = raw source including slashes and flags */
  | { t: 're'; v: string; s: number; e: number };

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of']);
const ID_START = /[\p{ID_Start}$_]/u;
const ID_REST = /[\p{ID_Continue}$‌‍]*/uy;
const NUMBER = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)n?/y;

const SIMPLE_ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/** Tokenize one script region [from, to) of `src`. Malformed input never throws: the token stops at the line end. */
export function tokenize(src: string, from = 0, to = src.length): Tok[] {
  const out: Tok[] = [];
  const braces: ('{' | '${')[] = [];
  let i = from;
  const regexAllowed = () => {
    const last = out[out.length - 1];
    if (!last) return true;
    if (last.t === 'num' || last.t === 'str' || last.t === 're' || (last.t === 'tpl' && last.part === 'tail')) return false;
    if (last.t === 'id') return REGEX_AFTER_KEYWORD.has(last.v);
    if (last.t === 'p') return last.v !== ')' && last.v !== ']' && last.v !== '}' && last.v !== '++' && last.v !== '--';
    return true;
  };
  /** Read string or template chars from i until one of the terminators; returns [cooked, endIndex, terminator]. */
  const readChars = (start: number, terms: string[]): [string, number, string] => {
    let v = '';
    let j = start;
    while (j < to) {
      const c = src[j]!;
      for (const t of terms) if (src.startsWith(t, j)) return [v, j, t];
      if ((c === '\n' || c === '\r') && !terms.includes('`')) return [v, j, '']; // unterminated string: stop at the line end
      if (c === '\\') {
        const n = src[j + 1] ?? '';
        if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(src.slice(j + 2, j + 4))) { v += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; continue; }
        if (n === 'u' && src[j + 2] === '{') {
          const close = src.indexOf('}', j + 3);
          const cp = close > 0 ? parseInt(src.slice(j + 3, close), 16) : NaN;
          if (Number.isInteger(cp) && cp <= 0x10ffff) { v += String.fromCodePoint(cp); j = close + 1; continue; }
        }
        if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(j + 2, j + 6))) { v += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue; }
        if (n === '\r' && src[j + 2] === '\n') { j += 3; continue; }
        if (n === '\n' || n === '\r' || n === ' ' || n === ' ') { j += 2; continue; }
        v += SIMPLE_ESC[n] ?? n;
        j += 2;
        continue;
      }
      v += c;
      j++;
    }
    return [v, j, ''];
  };
  const template = (start: number, part: 'head' | 'mid') => {
    const [v, j, term] = readChars(start, ['`', '${']);
    if (term === '${') {
      out.push({ t: 'tpl', v, s: start - 1, e: j + 2, part });
      braces.push('${');
      return j + 2;
    }
    if (part === 'head') out.push({ t: 'str', v, s: start - 1, e: j + 1 });
    else out.push({ t: 'tpl', v, s: start - 1, e: j + 1, part: 'tail' });
    return term ? j + 1 : j;
  };
  while (i < to) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿' || c === ' ' || c === ' ') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < to && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 || e >= to ? to : e + 2; continue; }
    if (c === '<' && src.startsWith('<!--', i)) { while (i < to && src[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      const [v, j, term] = readChars(i + 1, [c]);
      out.push({ t: 'str', v, s: i, e: term ? j + 1 : j });
      i = term ? j + 1 : j;
      continue;
    }
    if (c === '`') { i = template(i + 1, 'head'); continue; }
    if (c === '}' && braces[braces.length - 1] === '${') { braces.pop(); i = template(i + 1, 'mid'); continue; }
    if (ID_START.test(c) || c === '\\') {
      ID_REST.lastIndex = i + 1;
      const m = ID_REST.exec(src);
      const e = Math.min(to, i + 1 + (m ? m[0].length : 0));
      out.push({ t: 'id', v: src.slice(i, e), s: i, e });
      i = e;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      const raw = m ? m[0] : c;
      const clean = raw.replace(/_/g, '');
      const v = /^0[0-7]+$/.test(clean) ? parseInt(clean, 8) : clean.endsWith('n') ? Number(clean.slice(0, -1)) : Number(clean);
      out.push({ t: 'num', v, s: i, e: i + raw.length });
      i += raw.length;
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let cls = false;
      while (j < to && src[j] !== '\n') {
        const d = src[j]!;
        if (d === '\\') { j += 2; continue; }
        if (d === '[') cls = true;
        else if (d === ']') cls = false;
        else if (d === '/' && !cls) break;
        j++;
      }
      j++;
      while (j < to && /[a-z]/.test(src[j]!)) j++;
      out.push({ t: 're', v: src.slice(i, j), s: i, e: j });
      i = j;
      continue;
    }
    const p = PUNCT.find((x) => src.startsWith(x, i)) ?? c;
    if (p === '{') braces.push('{');
    else if (p === '}') braces.pop();
    out.push({ t: 'p', v: p, s: i, e: i + p.length });
    i += p.length;
  }
  return out;
}

/** Script element contents [start, end) in document order; external scripts (src=) are skipped. */
export function scriptRegions(html: string): [number, number][] {
  const out: [number, number][] = [];
  const open = /<script\b([^>]*)>/gi;
  const lower = html.toLowerCase();
  let m: RegExpExecArray | null;
  while ((m = open.exec(html))) {
    const start = m.index + m[0].length;
    const close = lower.indexOf('</script', start);
    const end = close < 0 ? html.length : close;
    if (!/\bsrc\s*=/i.test(m[1]!)) out.push([start, end]);
    open.lastIndex = end;
  }
  return out;
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** A tokenized document: tokens of every script region plus line lookup. */
export class Code {
  readonly toks: Tok[];
  /** index of the matching bracket for every bracket token (templates count as brackets) */
  private readonly match: Int32Array;
  private readonly lineStarts: number[];
  readonly src: string;
  constructor(src: string, regions: [number, number][]) {
    this.src = src;
    const perRegion = regions.map(([a, b]) => tokenize(src, a, b));
    this.toks = perRegion.flat();
    this.match = new Int32Array(this.toks.length).fill(-1);
    // brackets match within one script region and only with their own kind; a stray closer is ignored
    let base = 0;
    for (const toks of perRegion) {
      const stack: number[] = [];
      toks.forEach((t, i) => {
        const k = base + i;
        if ((t.t === 'p' && OPEN.has(t.v)) || (t.t === 'tpl' && t.part === 'head')) stack.push(k);
        else if ((t.t === 'p' && CLOSE[t.v]) || (t.t === 'tpl' && t.part === 'tail')) {
          const o = stack[stack.length - 1];
          if (o === undefined) return;
          const ot = this.toks[o]!;
          const want = t.t === 'tpl' ? ot.t === 'tpl' : ot.t === 'p' && ot.v === CLOSE[t.v as string];
          if (!want) return;
          stack.pop();
          this.match[o] = k;
          this.match[k] = o;
        }
      });
      base += toks.length;
    }
    this.lineStarts = [0];
    for (let k = 0; k < src.length; k++) if (src.charCodeAt(k) === 10) this.lineStarts.push(k + 1);
  }
  matchOf(k: number): number { return this.match[k]!; }
  line(offset: number): number {
    let lo = 0, hi = this.lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.lineStarts[mid]! <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }
  is(k: number, t: Tok['t'], v?: string | number): boolean { const x = this.toks[k]; return !!x && x.t === t && (v === undefined || x.v === v); }
  /**
   * End (exclusive) of the expression starting at token k: stops at a top-level ',' ';' or a
   * closing bracket of an enclosing scope, or at `limit`.
   */
  exprEnd(k: number, limit: number): number {
    let j = k;
    while (j < limit) {
      const t = this.toks[j]!;
      if (t.t === 'p' && (t.v === ',' || t.v === ';' || CLOSE[t.v])) return j;
      if ((t.t === 'p' && OPEN.has(t.v)) || (t.t === 'tpl' && t.part === 'head')) { const m = this.match[j]!; if (m < 0) return limit; j = m + 1; continue; }
      j++;
    }
    return limit;
  }
  /** Top-level elements of a bracketed list whose opening token is k: [start, end) per element. */
  elements(k: number): [number, number][] {
    const close = this.match[k]!;
    if (close < 0) return [];
    const out: [number, number][] = [];
    let j = k + 1;
    while (j < close) {
      const e = this.exprEnd(j, close);
      out.push([j, e]); // a hole (`[a, , c]`) is an empty element, so later indexes keep their position
      j = e + 1;
    }
    return out;
  }
  /** Raw source text of tokens [a, b). */
  text(a: number, b: number): string { return a < b ? this.src.slice(this.toks[a]!.s, this.toks[b - 1]!.e) : ''; }
}

/** A token range [a, b) plus the source text it belongs to. */
export interface Range { a: number; b: number }

export type ScopeSpec = `render:${string}` | `function:${string}` | `const:${string}` | 'markup';

/**
 * Find a scope by code shape. RENDER.<id> and functions take the last definition, which is the
 * live one in a classic script; `count` reports how many definitions were seen.
 */
export function findScope(code: Code, spec: ScopeSpec): { range: Range; count: number } | null {
  const T = code.toks;
  const hits: Range[] = [];
  const [kind, name] = spec.split(':') as [string, string];
  const bodyAfter = (k: number): Range | null => {
    // function ( params ) {   |   ( params ) => {   |   ident => {
    let j = k;
    if (code.is(j, 'id', 'async')) j++;
    if (code.is(j, 'id', 'function')) { j++; if (code.is(j, 'id')) j++; }
    if (code.is(j, 'p', '(')) j = code.matchOf(j) + 1;
    else if (code.is(j, 'id')) j++;
    else return null;
    if (j <= 0) return null;
    if (code.is(j, 'p', '=>')) j++;
    if (!code.is(j, 'p', '{')) return null;
    const close = code.matchOf(j);
    return close > j ? { a: j + 1, b: close } : null;
  };
  for (let k = 0; k < T.length; k++) {
    if (kind === 'render' && code.is(k, 'id', 'RENDER') && code.is(k + 1, 'p', '.') && code.is(k + 2, 'id', name) && code.is(k + 3, 'p', '=')) {
      const r = bodyAfter(k + 4);
      if (r) hits.push(r);
    } else if (kind === 'function' && code.is(k, 'id', 'function') && code.is(k + 1, 'id', name) && !code.is(k - 1, 'p', '.')) {
      const r = bodyAfter(k);
      if (r) hits.push(r);
    } else if (kind === 'const' && (code.is(k, 'id', 'const') || code.is(k, 'id', 'let') || code.is(k, 'id', 'var')) && code.is(k + 1, 'id', name) && code.is(k + 2, 'p', '=')) {
      const e = code.exprEnd(k + 3, T.length);
      if (e > k + 3) hits.push({ a: k + 3, b: e });
    }
  }
  if (!hits.length) return null;
  return { range: hits[hits.length - 1]!, count: hits.length };
}

// ---- expressions -------------------------------------------------------------------------------

/** Top-level operators that bind looser than `+` or are not concatenation: the whole expression is code. */
const WHOLE_CODE = new Set(['?', '||', '&&', '??', '-', '*', '/', '%', '**', '<', '>', '<=', '>=', '==', '===', '!=', '!==', '<<', '>>', '>>>', '&', '|', '^', '=', '=>', ',', '+=', '-=']);

/** Private-use code points reserved for markers; a literal holding one is refused (never read as a marker). */
export const RESERVED = /[\ue000-\ue004]/g;
export const POISON = '\ue004';
export const poison = (s: string): string => s.replace(RESERVED, POISON);

/** A value read from code: literal text runs and code runs (token ranges), in order. */
export type Part = { text: string; toks: number[] } | { code: Range };

/**
 * Split an expression into `+`-joined operands. Literals become text parts; a template's
 * substitutions and every other operand become code parts. An expression with a top-level
 * conditional or logical operator is one code part.
 */
export function partsOf(code: Code, r: Range): Part[] {
  const T = code.toks;
  for (let j = r.a; j < r.b; j++) {
    const t = T[j]!;
    if (t.t === 'p' && WHOLE_CODE.has(t.v)) return [{ code: r }];
    if (t.t === 'id' && (t.v === 'in' || t.v === 'instanceof')) return [{ code: r }];
    if ((t.t === 'p' && OPEN.has(t.v)) || (t.t === 'tpl' && t.part === 'head')) { const m = code.matchOf(j); if (m > j) j = m; }
  }
  const operands: Range[] = [];
  let start = r.a;
  for (let j = r.a; j < r.b; j++) {
    const t = T[j]!;
    if (t.t === 'p' && t.v === '+' && j > start) { operands.push({ a: start, b: j }); start = j + 1; continue; }
    if ((t.t === 'p' && OPEN.has(t.v)) || (t.t === 'tpl' && t.part === 'head')) { const m = code.matchOf(j); if (m > j) j = m; }
  }
  if (start < r.b) operands.push({ a: start, b: r.b });
  const out: Part[] = [];
  const text = (raw: string, k: number) => {
    const s = poison(raw);
    const last = out[out.length - 1];
    if (last && 'text' in last) { last.text += s; last.toks.push(k); } else out.push({ text: s, toks: [k] });
  };
  for (const o of operands) {
    const t = T[o.a]!;
    if (o.b - o.a === 1 && t.t === 'str') { text(t.v, o.a); continue; }
    if (t.t === 'tpl' && t.part === 'head' && code.matchOf(o.a) === o.b - 1) {
      let j = o.a;
      while (j < o.b) {
        const c = T[j] as Extract<Tok, { t: 'tpl' }>;
        text(c.v, j);
        if (c.part === 'tail') break;
        let n = j + 1;
        while (n < o.b) {
          const x = T[n]!;
          if (x.t === 'tpl' && x.part !== 'head') break;
          if ((x.t === 'p' && OPEN.has(x.v)) || (x.t === 'tpl' && x.part === 'head')) { const m = code.matchOf(n); if (m > n) { n = m + 1; continue; } }
          n++;
        }
        out.push({ code: { a: j + 1, b: n } });
        j = n;
      }
      continue;
    }
    out.push({ code: o });
  }
  return out;
}

// ---- markup stream -----------------------------------------------------------------------------

/** Private-use sentinels marking a code run inside reconstructed markup. */
export const SENT_OPEN = '\ue000';
export const SENT_CLOSE = '\ue001';

export interface Stream {
  text: string;
  /** stream offset -> source literal token, for every literal segment */
  segs: { from: number; to: number; tok: number }[];
  /** code runs by sentinel index */
  runs: Range[];
}

/**
 * Concatenate the literals of a scope in source order into one markup string. Operator runs
 * that only join markup (`+`, `;`, `h +=`) vanish; any other code run becomes a sentinel.
 * The static page markup (scope 'markup') is the raw HTML before the first script.
 */
export function markupStream(code: Code, r: Range): Stream {
  const T = code.toks;
  const s: Stream = { text: '', segs: [], runs: [] };
  // the accumulator is the identifier most often extended with `+=` (v5: h); only it joins markup
  const plusEq = new Map<string, number>();
  for (let k = r.a; k + 1 < r.b; k++) { const t = T[k]!; if (t.t === 'id' && code.is(k + 1, 'p', '+=')) plusEq.set(t.v, (plusEq.get(t.v) ?? 0) + 1); }
  const acc = [...plusEq].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))[0]?.[0];
  let run: number[] = [];
  const flush = () => {
    if (!run.length) return;
    const shape = run.map((k) => { const t = T[k]!; return t.t === 'id' ? (/^(?:let|const|var)$/.test(t.v) ? 'D' : t.v === acc ? 'A' : 'I') : t.t === 'p' ? t.v : '#'; }).join('');
    const join = /^(?:\+|;|A\+=|DA=)*$/.test(shape);
    if (s.text.length && !join) {
      s.text += SENT_OPEN + s.runs.length + SENT_CLOSE;
      s.runs.push({ a: run[0]!, b: run[run.length - 1]! + 1 });
    }
    run = [];
  };
  for (let k = r.a; k < r.b; k++) {
    const t = T[k]!;
    // a plain call's arguments are code (esc(x), docLink(u, 'label')); a call with a callback body may build markup
    if (t.t === 'id' && code.is(k + 1, 'p', '(') && !/^(?:if|for|while|switch|catch|function|return)$/.test(t.v)) {
      const close = code.matchOf(k + 1);
      if (close > k && close < r.b && !hasCallback(code, k + 2, close)) { for (let j = k; j <= close; j++) run.push(j); k = close; continue; }
    }
    if (t.t === 'str' || t.t === 'tpl') {
      if (t.t === 'tpl' && t.part !== 'head') { run.push(k); }
      flush();
      s.segs.push({ from: s.text.length, to: s.text.length + t.v.length, tok: k });
      s.text += poison(t.v);
      if (t.t === 'tpl' && t.part !== 'tail') run.push(k);
      continue;
    }
    run.push(k);
  }
  flush();
  return s;
}

function hasCallback(code: Code, a: number, b: number): boolean {
  for (let j = a; j < b; j++) if (code.is(j, 'p', '=>') || code.is(j, 'id', 'function')) return true;
  return false;
}

// ---- minimal HTML tree over a markup stream ------------------------------------------------------

export interface El { tag: string; attrs: Map<string, string>; start: number; innerStart: number; innerEnd: number; end: number; parent: El | null; children: El[] }

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style']);
const IMPLIED = new Set(['li', 'p', 'td', 'th', 'tr', 'option', 'dt', 'dd']);
const BLOCK = new Set(['p', 'div', 'table', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'blockquote']);
// quoted attribute values never span a '<', so a malformed tag costs at most the distance to the next one
const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:[^<>"']|"[^"<]*"|'[^'<]*')*)>|<!--[\s\S]*?-->/g;
const ATTR = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

export function parseHtml(text: string): El {
  const root: El = { tag: '#root', attrs: new Map(), start: 0, innerStart: 0, innerEnd: text.length, end: text.length, parent: null, children: [] };
  let cur = root;
  const lower = text.toLowerCase();
  /** open elements per tag name, so an unmatched end tag is ignored without walking the stack */
  const openCount = new Map<string, number>();
  const closeTo = (el: El, at: number, end: number) => {
    for (let c: El | null = cur; c && c !== el.parent; c = c.parent) {
      if (c !== el) { c.innerEnd = at; c.end = at; }
      openCount.set(c.tag, openCount.get(c.tag)! - 1);
    }
    el.innerEnd = at;
    el.end = end;
    cur = el.parent!;
  };
  TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG.exec(text))) {
    if (m[0].startsWith('<!--')) continue;
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      if (!openCount.get(tag)) continue;
      let el: El = cur;
      while (el.tag !== tag) el = el.parent!;
      closeTo(el, m.index, m.index + m[0].length);
      continue;
    }
    // implicit end tags: a new li/p/td/... closes an open one of the same kind; a block closes an open p
    if ((IMPLIED.has(tag) && cur.tag === tag) || (cur.tag === 'p' && BLOCK.has(tag))) closeTo(cur, m.index, m.index);
    const attrs = new Map<string, string>();
    ATTR.lastIndex = 0;
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(m[3]!))) attrs.set(a[1]!.toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '');
    const end = m.index + m[0].length;
    const el: El = { tag, attrs, start: m.index, innerStart: end, innerEnd: end, end, parent: cur, children: [] };
    cur.children.push(el);
    if (VOID.has(tag) || m[3]!.trimEnd().endsWith('/')) continue;
    if (RAW_TEXT.has(tag)) {
      const close = lower.indexOf(`</${tag}`, end);
      el.innerEnd = close < 0 ? text.length : close;
      const gt = close < 0 ? -1 : text.indexOf('>', close);
      el.end = gt < 0 ? text.length : gt + 1;
      TAG.lastIndex = el.end;
      continue;
    }
    cur = el;
    openCount.set(tag, (openCount.get(tag) ?? 0) + 1);
  }
  for (let c: El | null = cur; c && c !== root; c = c.parent) { c.innerEnd = text.length; c.end = text.length; }
  return root;
}

interface Compound { tag?: string; id?: string; classes: string[]; attrs: [string, string][]; eq?: number; child: boolean }

/** Selector subset: tag, #id, .class, [attr="v"], :eq(n), descendant (space) and child (>) combinators. */
export function parseSelector(sel: string): Compound[] {
  const out: Compound[] = [];
  const re = /\s*(>)?\s*([A-Za-z][\w-]*(?::(?!eq\()[A-Za-z][\w-]*)?|\*)?((?:#[\w-]+|\.[\w-]+|\[[\w:-]+="[^"]*"\])*)(?::eq\((\d+)\))?/y;
  let i = 0;
  while (i < sel.length) {
    re.lastIndex = i;
    const m = re.exec(sel);
    if (!m || m[0].length === 0) throw new Error(`bad selector at ${i}: ${sel}`);
    i += m[0].length;
    if (!m[2] && !m[3] && m[4] === undefined) { if (sel.slice(i).trim()) throw new Error(`bad selector: ${sel}`); break; }
    const c: Compound = { classes: [], attrs: [], child: !!m[1] };
    if (m[2] && m[2] !== '*') c.tag = m[2].toLowerCase();
    for (const x of m[3]!.match(/#[\w-]+|\.[\w-]+|\[[\w:-]+="[^"]*"\]/g) ?? []) {
      if (x[0] === '#') c.id = x.slice(1);
      else if (x[0] === '.') c.classes.push(x.slice(1));
      else { const [, k, v] = /^\[([\w:-]+)="([^"]*)"\]$/.exec(x)!; c.attrs.push([k!.toLowerCase(), v!]); }
    }
    if (m[4] !== undefined) c.eq = Number(m[4]);
    out.push(c);
  }
  return out;
}

const matches = (el: El, c: Compound) =>
  (!c.tag || el.tag === c.tag) &&
  (!c.id || el.attrs.get('id') === c.id) &&
  c.classes.every((k) => (el.attrs.get('class') ?? '').split(/\s+/).includes(k)) &&
  c.attrs.every(([k, v]) => el.attrs.get(k) === v);

export function select(root: El, sel: string): El[] {
  let ctx: El[] = [root];
  for (const c of parseSelector(sel)) {
    const found: El[] = [];
    const seen = new Set<El>();
    const visit = (el: El, direct: boolean) => {
      for (const ch of el.children) {
        if (matches(ch, c) && !seen.has(ch)) { seen.add(ch); found.push(ch); }
        if (!direct) visit(ch, false);
      }
    };
    for (const x of ctx) visit(x, c.child);
    found.sort((a, b) => a.start - b.start);
    ctx = c.eq === undefined ? found : found[c.eq] ? [found[c.eq]!] : [];
  }
  return ctx;
}

// ---- markup -> text ----------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', rarr: '→', larr: '←', harr: '↔', middot: '·', bull: '•', copy: '©', reg: '®', trade: '™', times: '×',
  laquo: '«', raquo: '»', sect: '§', para: '¶', deg: '°', plusmn: '±', euro: '€', pound: '£', cent: '¢', minus: '−', le: '≤', ge: '≥',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (cp >= 0xe000 && cp <= 0xe004) return POISON;
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Remove <script> and <style> elements with their content in one linear pass (an unclosed one runs to the end). */
function dropRawText(s: string): string {
  const lower = s.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const sc = lower.indexOf('<script', i), st = lower.indexOf('<style', i);
    const at = sc < 0 ? st : st < 0 ? sc : Math.min(sc, st);
    if (at < 0) return out + s.slice(i);
    const tag = at === sc ? 'script' : 'style';
    out += s.slice(i, at);
    const close = lower.indexOf(`</${tag}`, at);
    if (close < 0) return out;
    const gt = lower.indexOf('>', close);
    i = gt < 0 ? s.length : gt + 1;
  }
}

const BREAK = '\ue002';
const PARA = '\ue003';

/**
 * Visible text of a markup fragment as narrative text: tags removed, entities decoded, white
 * space collapsed as a browser would; <br> becomes a newline and block ends separate
 * paragraphs with a blank line (the renderNarrative convention). Sentinels pass through.
 */
export function markupText(fragment: string): string {
  const t = dropRawText(fragment)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, BREAK)
    .replace(/<\/(?:p|div|h[1-6]|li|tr|table|ul|ol|section|blockquote)\s*>|<(?:p|div|h[1-6]|li|tr|table|ul|ol|section|blockquote)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, PARA)
    .replace(/<\/?[A-Za-z][\w:-]*(?:[^>"']|"[^"]*"|'[^']*')*>/g, '');
  return decodeEntities(t.replace(/[ \t\r\n\f]+/g, ' '))
    .split(PARA)
    .map((p) => p.split(BREAK).map((l) => l.trim()).join('\n').trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
}
