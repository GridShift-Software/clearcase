// Canonical JSON (identity and file encodings) and the strict parser, against literal bytes.
import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalText } from '../../src/lib/case-package/canonical.ts';
import { inputRevisionId, resultsVersionOf, sha256Hex } from '../../src/lib/case-package/hash.ts';
import { parseStrictJson, decodeUtf8Strict, StrictJsonError } from '../../src/lib/case-package/strict-json.ts';
import { buildSynth } from './fixtures/build.ts';
import { cleanup, tempDir } from './fixtures/synth.ts';

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await cleanup(d); });

describe('canonical JSON', () => {
  it('orders integer-like keys as strings (JCS), unlike JSON.stringify', () => {
    const v = { '10': 1, '9': 2, a: 3, '1': 4 };
    expect(canonicalJson(v)).toBe('{"1":4,"10":1,"9":2,"a":3}');
    expect(JSON.stringify(v)).toBe('{"1":4,"9":2,"10":1,"a":3}');
  });

  it('orders keys by UTF-16 code units: a supplementary character sorts before U+FFFD', () => {
    expect(canonicalJson({ '�': 1, '\u{1F600}': 2, z: 3, 'é': 4 })).toBe('{"z":3,"é":4,"😀":2,"�":1}');
  });

  it('writes numbers in ECMAScript form', () => {
    expect(canonicalJson([1e-7, 0.000001, 123.456, -0.5, 1.5e-300, 0.1 + 0.2, 100, -0, 5e-324, 4503599627370495.5, 2 ** 53 - 1, 1.25e-7]))
      .toBe('[1e-7,0.000001,123.456,-0.5,1.5e-300,0.30000000000000004,100,0,5e-324,4503599627370495.5,9007199254740991,1.25e-7]');
    // integer-valued numbers beyond 2^53-1 (e.g. 1e21) are refused by the parser and the serializer alike
    expect(() => canonicalJson(1e21)).toThrow();
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
    expect(() => canonicalJson(2 ** 53)).toThrow();
  });

  it('escapes only what JCS escapes', () => {
    expect(canonicalJson('a"b\\c/d\u0001\u001f\b\t\n\f\r\u007f é😀')).toBe('"a\\"b\\\\c/d\\u0001\\u001f\\b\\t\\n\\f\\r\u007f é😀"');
  });

  it('rejects invalid Unicode, undefined, non-plain objects and excess depth', () => {
    expect(() => canonicalJson('\ud800')).toThrow(/surrogate/);
    expect(() => canonicalJson({ ['\udc00']: 1 })).toThrow(/surrogate/);
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(new Date(0))).toThrow();
    expect(() => canonicalJson(new Map())).toThrow();
    const nest = (n: number): unknown => (n === 0 ? 0 : [nest(n - 1)]);
    expect(() => canonicalJson(nest(32))).not.toThrow();
    expect(() => canonicalJson(nest(33))).toThrow(/nesting/);
  });

  it('writes the file encoding with two spaces, LF and one final newline', () => {
    expect(canonicalText({ b: [1, {}], a: [], c: { '10': true, '9': null } })).toBe('{\n  "a": [],\n  "b": [\n    1,\n    {}\n  ],\n  "c": {\n    "10": true,\n    "9": null\n  }\n}\n');
  });

  it('pins the identity digests to literal values', () => {
    const ir = inputRevisionId([{ role: 'workspace-html', sha256: 'a'.repeat(64), size: 10 }]);
    expect(ir).toBe('sha256:' + sha256Hex('[{"role":"workspace-html","sha256":"' + 'a'.repeat(64) + '","size":10}]'));
    const rv = resultsVersionOf({ formatVersion: 1, caseId: 'c', inputRevisionId: ir, files: [{ path: 'b', role: 'assets', sha256: 'b'.repeat(64), size: 2 }, { path: 'a', role: 'dataset', key: 'k', kind: 'generated', sha256: 'c'.repeat(64), size: 1 }] });
    expect(rv).toBe('sha256:' + sha256Hex(`{"caseId":"c","files":[{"key":"k","kind":"generated","path":"a","role":"dataset","sha256":"${'c'.repeat(64)}","size":1},{"path":"b","role":"assets","sha256":"${'b'.repeat(64)}","size":2}],"format":"clearcase.results-package","formatVersion":1,"inputRevisionId":"${ir}"}`));
  });
});

describe('the Python reproduction', () => {
  const py = path.resolve('scripts/case-package/canonical.py');
  const run = (args: string[]) => spawnSync('python3', ['-I', py, ...args], { encoding: 'utf8' });

  it('reproduces the vectors byte for byte (UTF-16 order, ES numbers, escaping)', async () => {
    const dir = await tempDir('py');
    dirs.push(dir);
    const vectors = { '10': [1e-7, 0.000001, 123.456, -0.5, 1.5e-300, 0.1 + 0.2, 100, 5e-324, 4503599627370495.5, 1.25e-7, -2.5e-8], '9': 'a"b\\\u0001\n 😀', '�': 1, '\u{1F600}': { z: null, 'é': [true, false, {}] } };
    const file = path.join(dir, 'v.json');
    await writeFile(file, canonicalJson(vectors));
    expect(run(['--compact', file]).stdout).toBe(canonicalJson(vectors));
    expect(run(['--pretty', file]).stdout).toBe(canonicalText(vectors));
  });

  it('reproduces every file of an emitted package', async () => {
    const b = await buildSynth('py-pkg');
    dirs.push(b.root);
    const files = (await readdir(b.pkgDir, { recursive: true })).filter((f) => f.endsWith('.json')).map((f) => path.join(b.pkgDir, f));
    const p = run(['--check', ...files]);
    expect(p.status, p.stderr).toBe(0);
  });
});

describe('strict JSON parser', () => {
  const code = (t: string) => { try { parseStrictJson(t); return null; } catch (e) { return (e as StrictJsonError).code; } };
  it('rejects what JSON.parse tolerates', () => {
    expect(code('{"a":1,"a":2}')).toBe('JSON_DUPLICATE_KEY');
    expect(code('{"a":1,"\\u0061":2}')).toBe('JSON_DUPLICATE_KEY');
    expect(code('"\\ud800"')).toBe('JSON_MALFORMED');
    expect(code('"\ud800"')).toBe('JSON_MALFORMED');
    expect(code('9007199254740993')).toBe('JSON_LIMIT');
    expect(code('1e400')).toBe('JSON_LIMIT');
    expect(code('NaN')).toBe('JSON_MALFORMED');
    expect(code('{} {}')).toBe('JSON_MALFORMED');
    expect(code('{/*c*/}')).toBe('JSON_MALFORMED');
    expect(code('[1,]')).toBe('JSON_MALFORMED');
    expect(code('"a\u0000"')).toBe('JSON_MALFORMED');
    expect(code('')).toBe('JSON_MALFORMED');
  });
  it('keeps __proto__ inert and bounds nesting before recursion', () => {
    const v = parseStrictJson('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.hasOwn(v, '__proto__')).toBe(true);
    expect(code('['.repeat(200_000))).toBe('JSON_LIMIT');
    expect(code('['.repeat(32) + ']'.repeat(32))).toBeNull();
    expect(code('['.repeat(33) + ']'.repeat(33))).toBe('JSON_LIMIT');
    expect(() => parseStrictJson('"' + 'x'.repeat(100) + '"', { stringChars: 50 })).toThrow(/longer/);
    expect(() => parseStrictJson('{"a":1,"b":2,"c":3}', { objectKeys: 2 })).toThrow(/keys/);
    expect(() => parseStrictJson('[1,2,3]', { arrayItems: 2 })).toThrow(/items/);
  });
  it('rejects a BOM and invalid UTF-8 with the byte offset', () => {
    expect(() => decodeUtf8Strict(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow(/byte order mark/);
    expect(() => decodeUtf8Strict(new Uint8Array([0x22, 0x61, 0xc0, 0xaf, 0x22]))).toThrow(/byte 2/);
    expect(() => decodeUtf8Strict(new Uint8Array([0x22, 0xed, 0xa0, 0x80, 0x22]))).toThrow(/byte 1/);
  });
});
