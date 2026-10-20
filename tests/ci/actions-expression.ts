// Evaluates a GitHub Actions expression the way GitHub does, for the subset the workflows use, so a test can ask what a
// job's `if:` decides for an event instead of reading its text. Semantics from GitHub's "Evaluate expressions in
// workflows and actions": strings compare case-insensitively, mismatched types compare as numbers, `&&` and `||` return
// an operand, and a missing property is null. Comparisons other than == and !=, `.*` filters and functions outside
// contains, startsWith, endsWith and the status checks throw, as does a context the caller did not supply, so a test
// fails rather than guesses when a workflow outgrows this subset.

export type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
type Node = (contexts: Record<string, Value>) => Value;

const STATUS = /\b(success|failure|always|cancelled)\(/i;
const TOKEN = /\s*(?:(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|'((?:[^']|'')*)'|([A-Za-z_][\w-]*)|(==|!=|&&|\|\||[!.()[\],]))/y;

export function truthy(v: Value): boolean {
	return !(v === null || v === false || v === 0 || v === '' || Number.isNaN(v));
}

function toNumber(v: Value): number {
	if (v === null) return 0;
	if (typeof v === 'boolean') return v ? 1 : 0;
	if (typeof v === 'number') return v;
	if (typeof v === 'string') return v === '' ? 0 : /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(v) ? Number(v) : NaN;
	return NaN;
}

function looseEquals(a: Value, b: Value): boolean {
	if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
	if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') return a === b;
	if (a === null && b === null) return true;
	if (typeof a === typeof b && typeof a !== 'object') return a === b;
	const x = toNumber(a), y = toNumber(b);
	return !Number.isNaN(x) && x === y;
}

function toText(v: Value, fn: string): string {
	if (v === null) return '';
	if (typeof v === 'object') throw new Error(`actions-expression: ${fn}() of an object or array is not supported here`);
	return String(v);
}

function property(target: Value, key: Value): Value {
	if (Array.isArray(target)) return typeof key === 'number' ? (target[key] ?? null) : null;
	if (target === null || typeof target !== 'object') return null;
	const wanted = String(key).toLowerCase();
	const hit = Object.keys(target).find((k) => k.toLowerCase() === wanted);
	return hit === undefined ? null : (target[hit] ?? null);
}

const FUNCTIONS: Record<string, (args: Value[], status: Status) => Value> = {
	contains: ([search = null, item = null]) =>
		Array.isArray(search) ? search.some((e) => looseEquals(e, item)) : toText(search, 'contains').toLowerCase().includes(toText(item, 'contains').toLowerCase()),
	startswith: ([s = null, v = null]) => toText(s, 'startsWith').toLowerCase().startsWith(toText(v, 'startsWith').toLowerCase()),
	endswith: ([s = null, v = null]) => toText(s, 'endsWith').toLowerCase().endsWith(toText(v, 'endsWith').toLowerCase()),
	success: (_, status) => status === 'success',
	failure: (_, status) => status === 'failure',
	cancelled: (_, status) => status === 'cancelled',
	always: () => true,
};

/** The state of the job's dependencies (or earlier steps) that the status functions read. */
export type Status = 'success' | 'failure' | 'cancelled';

export function parse(source: string, status: Status = 'success'): Node {
	const tokens: { kind: 'num' | 'str' | 'id' | 'op'; text: string }[] = [];
	TOKEN.lastIndex = 0;
	while (TOKEN.lastIndex < source.length && source.slice(TOKEN.lastIndex).trim() !== '') {
		const at = TOKEN.lastIndex;
		const m = TOKEN.exec(source);
		if (!m) throw new Error(`actions-expression: cannot read ${JSON.stringify(source.slice(at, at + 20))} in ${source}`);
		if (m[1] !== undefined) tokens.push({ kind: 'num', text: m[1] });
		else if (m[2] !== undefined) tokens.push({ kind: 'str', text: m[2].replaceAll("''", "'") });
		else if (m[3] !== undefined) tokens.push({ kind: 'id', text: m[3] });
		else tokens.push({ kind: 'op', text: m[4]! });
	}
	let i = 0;
	const peek = (text: string) => tokens[i]?.kind === 'op' && tokens[i]!.text === text;
	const take = (text: string) => {
		if (!peek(text)) throw new Error(`actions-expression: expected ${text} at token ${i} of ${source}`);
		i++;
	};
	const binary = (next: () => Node, ops: string[], apply: (op: string, l: Node, r: Node) => Node) => () => {
		let left = next();
		while (ops.some(peek)) {
			const op = tokens[i++]!.text, right = next();
			left = apply(op, left, right);
		}
		return left;
	};
	const primary = (): Node => {
		const t = tokens[i++];
		if (!t) throw new Error(`actions-expression: unexpected end of ${source}`);
		if (t.kind === 'num') { const n = Number(t.text); return () => n; }
		if (t.kind === 'str') return () => t.text;
		if (t.kind === 'op' && t.text === '(') { const inner = or(); take(')'); return inner; }
		if (t.kind !== 'id') throw new Error(`actions-expression: unexpected ${t.text} in ${source}`);
		const word = t.text.toLowerCase();
		if (word === 'true' || word === 'false') { const b = word === 'true'; return () => b; }
		if (word === 'null') return () => null;
		if (peek('(')) {
			const fn = FUNCTIONS[word];
			if (!fn) throw new Error(`actions-expression: the function ${t.text}() is not supported here`);
			take('(');
			const args: Node[] = [];
			while (!peek(')')) { args.push(or()); if (!peek(')')) take(','); }
			take(')');
			return (c) => fn(args.map((a) => a(c)), status);
		}
		return (c) => {
			const hit = Object.keys(c).find((k) => k.toLowerCase() === word);
			if (hit === undefined) throw new Error(`actions-expression: the context ${t.text} was not supplied for ${source}`);
			return c[hit] ?? null;
		};
	};
	const postfix = (): Node => {
		let node = primary();
		for (;;) {
			if (peek('.')) {
				i++;
				const t = tokens[i++];
				if (t?.kind !== 'id') throw new Error(`actions-expression: only .name property access is supported here, in ${source}`);
				const target = node;
				node = (c) => property(target(c), t.text);
			} else if (peek('[')) {
				i++;
				const key = or();
				take(']');
				const target = node;
				node = (c) => property(target(c), key(c));
			} else return node;
		}
	};
	const unary = (): Node => {
		if (peek('!')) { i++; const inner = unary(); return (c) => !truthy(inner(c)); }
		return postfix();
	};
	const equality = binary(unary, ['==', '!='], (op, l, r) => (c) => looseEquals(l(c), r(c)) === (op === '=='));
	const and = binary(equality, ['&&'], (_, l, r) => (c) => { const v = l(c); return truthy(v) ? r(c) : v; });
	const or: () => Node = binary(and, ['||'], (_, l, r) => (c) => { const v = l(c); return truthy(v) ? v : r(c); });
	const tree = or();
	if (i !== tokens.length) throw new Error(`actions-expression: unexpected ${tokens[i]!.text} in ${source}`);
	return tree;
}

/** Whether a job or step with this `if:` runs: GitHub strips ${{ }}, and without a status function it requires success(). */
export function runs(condition: unknown, contexts: Record<string, Value>, status: Status = 'success'): boolean {
	if (condition === undefined || condition === null) return status === 'success';
	if (typeof condition === 'boolean') return condition && status === 'success';
	if (typeof condition !== 'string') throw new Error(`actions-expression: an if: of type ${typeof condition}`);
	const source = condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
	if (source.includes('${{')) throw new Error(`actions-expression: an if: that mixes text and \${{ }} is not supported here: ${condition}`);
	const value = truthy(parse(source, status)(contexts));
	return STATUS.test(source) ? value : value && status === 'success';
}
