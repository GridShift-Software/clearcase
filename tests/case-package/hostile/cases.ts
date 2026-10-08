// Deterministic generator of synthetic hostile inputs for the results-package contract.
// Ported from the threat categories of the external hostile corpus (spikes/hostile-corpus):
// the corpus uses its own stand-in package format, so each threat is re-expressed here in
// this package format. Most cases take the valid synthetic package from buildSynth() and change
// only the hostile property (editPackage/resealFiles keep every hash and identity consistent),
// so the expected diagnostic is the one the threat triggers and not a side effect.
// Inputs are generated in code; nothing here is a real case value and nothing is fetched.
//
// Policies recorded by these cases (see the report in GRS-10):
// - Hardlinks: a hardlink inside the case folder is a regular file with its own name; it is
//   accepted when its bytes match the indexed fingerprint, wherever its inode is shared.
//   Bytes that differ (e.g. an outside secret) fail ORIG_FINGERPRINT_MISMATCH.
// - Symlinks in the case folder are resolved with realpath: a link that stays inside the case
//   folder is followed (the indexed name is recorded); one that leaves it is ORIG_ESCAPE; a
//   dangling or looping link is ORIG_MISSING (a warning, like any missing original).
// - Windows-reserved names (CON, nul.txt, COM1, LPT9.txt) and trailing dots or spaces are
//   ordinary byte-exact names on the host filesystem: accepted when that exact file exists,
//   never trimmed and never aliased to a trimmed twin.
// - Names with C0/C1 control characters cannot be indexed (ASSET_PATH_INVALID, an error);
//   bidi, zero-width and BOM characters are allowed in names, matched byte-exact, flagged as
//   TEXT_CONTROL_CHARS where they appear in dataset text and revealed as ⟨U+XXXX⟩ on display.
// - Asset paths are literal: "%2e%2e" is a directory name, never percent-decoded; legacy
//   "./" locators are decoded once and then checked again.
import { execFileSync } from 'node:child_process';
import { cp, link, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Verdict } from '../../../src/lib/case-package/candidate.ts';
import { canonicalBytes } from '../../../src/lib/case-package/canonical.ts';
import type { Code } from '../../../src/lib/case-package/codes.ts';
import { sha256Hex } from '../../../src/lib/case-package/hash.ts';
import type { Limits } from '../../../src/lib/case-package/limits.ts';
import { mediaTypeForName } from '../../../src/lib/case-package/media.ts';
import { isSafeAppHref } from '../../../src/lib/case-package/render.ts';
import { buildPackage, type DatasetSpec } from '../../../src/lib/case-package/writer.ts';
import { editPackage, resealFiles } from '../fixtures/build.ts';
import { synthOriginals } from '../fixtures/synth.ts';
import { packageEntries, writeZip, type ZipEntrySpec, type ZipOptions } from './zip-writer.ts';

type Files = Map<string, Uint8Array>;
const enc = new TextEncoder();
const dec = new TextDecoder();
const utf8 = (s: string) => enc.encode(s);
const text = (files: Files, p: string) => dec.decode(files.get(p)!);
const ZERO_SHA = '0'.repeat(64);

// ---- small builders ---------------------------------------------------------------------------

/** Synthetic PDF-looking bytes, distinct per tag. */
export const pdf = (tag: string): Uint8Array => utf8(`%PDF-1.4\n% synthetic ${tag}\n%%EOF\n`);

/** Replace one dataset's text and reseal hashes, sizes and identity. */
export function rawEdit(files: Files, file: string, edit: (t: string) => string | Uint8Array): Files {
  const out = new Map(files);
  const r = edit(text(files, file));
  out.set(file, typeof r === 'string' ? utf8(r) : r);
  // keep the listed count when the edited file no longer has one (malformed or not an envelope)
  const counts = new Map((JSON.parse(text(files, 'manifest.json')).files as { path: string; count?: number }[]).map((f) => [f.path, f.count]));
  return resealFiles(out, (m) => { for (const f of m.files) if (f.count === undefined && counts.get(f.path) !== undefined) f.count = counts.get(f.path); });
}

/** Replace the first occurrence of `marker` (UTF-8) in a file with raw bytes, then reseal. */
export function spliceBytes(files: Files, file: string, marker: string, bytes: number[]): Files {
  return rawEdit(files, file, (t) => {
    const i = t.indexOf(marker);
    if (i < 0) throw new Error(`marker ${marker} not in ${file}`);
    const pre = utf8(t.slice(0, i));
    const post = utf8(t.slice(i + marker.length));
    const out = new Uint8Array(pre.length + bytes.length + post.length);
    out.set(pre, 0); out.set(bytes, pre.length); out.set(post, pre.length + bytes.length);
    return out;
  });
}

/** Rewrite the manifest without resealing (the hostile property is the manifest itself). */
export function rawManifest(files: Files, edit: (t: string) => string | Uint8Array): Files {
  const out = new Map(files);
  const r = edit(text(files, 'manifest.json'));
  out.set('manifest.json', typeof r === 'string' ? utf8(r) : r);
  return out;
}

const setAsset = (files: Files, ref: string, patch: Record<string, unknown>) => editPackage(files, 'assets.json', (v) => { Object.assign(v.assets[ref], patch); });
const chron = (files: Files, edit: (rows: any[]) => void) => editPackage(files, 'datasets/chronology.json', (v) => { edit(v.data); v.count = v.data.length; });
const prose = (files: Files, t: string) => editPackage(files, 'datasets/matter.json', (v) => { v.data.storyline[0].t = t; });
const manifest = (files: Files, edit: (m: any) => void) => resealFiles(files, edit);

/** A minimal valid package (chronology + assets, optional prose, recon citations and dated events). */
export interface MiniDoc { ref: unknown; path: unknown; bytes?: Uint8Array | null; filename?: unknown; mediaType?: string }
export interface MiniSpec { docs: MiniDoc[]; prose?: string[]; recon?: unknown[][]; events?: Record<string, unknown>[] }

/** Drop undefined members (an absent source field stays absent). */
const defined = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

const PROV = (sourcePath: string) => ({ source: 'synthetic-hostile', sourcePath, adapter: 'hostile-generator@0' });

export function miniPackage(spec: MiniSpec): Files {
  const rows = spec.docs.map((d, i) => defined({
    n: String(i + 1), ref: d.ref, date: '', filename: d.filename ?? (typeof d.path === 'string' ? d.path.split('/').pop()! : ''), subject: '', sender: '', to: '', cc: '',
    excerpt: '', doc_type: 'other', bundle: '', amount: '', also_in: [], text_status: 'pending', url: '', refs: [], invoice_no: '',
    size: d.bytes ? d.bytes.byteLength : 0, seq: String(i + 1), attachments: [],
  }));
  const datasets: DatasetSpec[] = [{ key: 'chronology', kind: 'generated', schema: 'v5.chronology@1', required: true, provenance: PROV('DATA.chronology'), data: rows }];
  if (spec.prose) datasets.push({ key: 'matter', kind: 'authored', schema: 'v5.matter@1', required: true, provenance: PROV('DATA.matter'), data: { title: 'Synthetic', short: 'SYN', forum: '', storyline: spec.prose.map((t, i) => ({ h: `Point ${i + 1}`, t })), strategy: [] } });
  if (spec.recon) datasets.push({ key: 'lit-recon', kind: 'authored', schema: 'v5.lit-recon@1', required: true, provenance: PROV('DATA.lit.recon'), data: spec.recon.map((c) => ({ month: '2001-01', invoice: c, statement: [], supporting: [], charging: [], amountdue: [], pod: [] })) });
  if (spec.events) datasets.push({ key: 'timeline-events', kind: 'authored', schema: 'v5.timeline-events@1', required: true, provenance: PROV('DATA.timeline.events'), data: spec.events.map((e) => defined({ kind: 'event', url: '', ...e })) });
  const assets: Record<string, unknown> = Object.create(null);
  for (const d of spec.docs) {
    const p = typeof d.path === 'string' ? d.path : '';
    assets[String(d.ref)] = { kind: 'file', path: d.path, sha256: d.bytes ? sha256Hex(d.bytes) : ZERO_SHA, size: d.bytes ? d.bytes.byteLength : 1, mediaType: d.mediaType ?? mediaTypeForName(p), textStatus: 'pending' };
  }
  const { files } = buildPackage({
    caseId: 'synthetic-hostile', inputKind: 'synthetic-hostile',
    sources: [{ role: 'synthetic', name: 'hostile generator', sha256: sha256Hex(utf8('hostile')), size: 7 }],
    producer: { name: 'hostile-generator', version: '1' }, created: '2001-01-01T00:00', datasets, assets: assets as never,
  });
  return files;
}

// ---- 1. package cases: in-memory edits of the valid synthetic package ------------------------

export interface PackageCase {
  id: string;
  threat: string;
  make: (base: Files) => Files | Record<string, unknown>;
  verdict: Verdict;
  /** every code must be present */
  codes: Code[];
  /** the result must list exactly these codes and nothing else */
  only?: boolean;
  limits?: Partial<Limits>;
  /** extra subject that must appear on a listed diagnostic */
  subject?: string;
}

const pc = (id: string, threat: string, make: PackageCase['make'], verdict: Verdict, codes: Code[], extra: Partial<PackageCase> = {}): PackageCase => ({ id, threat, make, verdict, codes, ...extra });
const W = 'datasets/witnesses.json';
const P = 'datasets/people.json';
const WILL = '"Invented statement"';
const SENT = '"sent": 2';

export const PACKAGE_CASES: Record<string, PackageCase[]> = {
  'json-syntax': [
    pc('trailing-garbage', 'valid document followed by a second object', (b) => rawEdit(b, W, (t) => t + '{}'), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('concatenated', 'two JSON documents concatenated', (b) => rawEdit(b, W, (t) => t + t), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('line-comment', 'leading // comment', (b) => rawEdit(b, W, (t) => '// note\n' + t), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('trailing-comma', 'trailing comma in an object', (b) => rawEdit(b, W, (t) => t.replace('"schema": "v5.witnesses@1"\n}', '"schema": "v5.witnesses@1",\n}')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('single-quotes', 'JSON5 single-quoted key', (b) => rawEdit(b, W, (t) => t.replace('"willsay"', "'willsay'")), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('empty-file', 'zero-byte dataset', (b) => rawEdit(b, W, () => ''), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('whitespace-only', '64 KiB of whitespace', (b) => rawEdit(b, W, () => ' '.repeat(65536)), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('top-level-array', 'dataset is an array, not an envelope', (b) => rawEdit(b, W, () => '[]\n'), 'reject', ['DS_ENVELOPE_INVALID']),
    pc('top-level-null', 'dataset is null', (b) => rawEdit(b, W, () => 'null\n'), 'reject', ['DS_ENVELOPE_INVALID']),
    pc('crlf', 'CRLF line ends (not canonical)', (b) => rawEdit(b, W, (t) => t.replace(/\n/g, '\r\n')), 'reject', ['PKG_NONCANONICAL'], { only: true }),
    pc('unsorted-keys', 'keys out of canonical order', (b) => rawEdit(b, W, (t) => t.replace('"name": "Ann Lee",\n      "role": "Supply"', '"role": "Supply",\n      "name": "Ann Lee"')), 'reject', ['PKG_NONCANONICAL'], { only: true }),
    pc('escaped-ascii', 'needless \\u escape (not canonical)', (b) => rawEdit(b, W, (t) => t.replace('Ann Lee', 'Ann L\\u0065e')), 'reject', ['PKG_NONCANONICAL'], { only: true }),
  ],
  'json-encoding': [
    pc('cesu-surrogate', 'CESU-8 encoded surrogate ED A0 80', (b) => spliceBytes(b, W, 'Invented', [0xed, 0xa0, 0x80]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('latin1', 'Latin-1 e-acute E9', (b) => spliceBytes(b, W, 'Invented', [0x63, 0x61, 0x66, 0xe9]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('cp1252-quotes', 'CP1252 smart quotes 93 94', (b) => spliceBytes(b, W, 'Invented', [0x93, 0x78, 0x94]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('ff-fe-inside', 'invalid lead bytes FF FE inside text', (b) => spliceBytes(b, W, 'Invented', [0xff, 0xfe]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('overlong-slash', 'overlong C0 AF (slash)', (b) => spliceBytes(b, W, 'Invented', [0x2e, 0x2e, 0xc0, 0xaf]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('overlong-3', 'overlong E0 80 AF', (b) => spliceBytes(b, W, 'Invented', [0xe0, 0x80, 0xaf]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('above-10ffff', 'F4 90 80 80 (above U+10FFFF)', (b) => spliceBytes(b, W, 'Invented', [0xf4, 0x90, 0x80, 0x80]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('f5-lead', 'F5 lead byte', (b) => spliceBytes(b, W, 'Invented', [0xf5, 0x80, 0x80, 0x80]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('truncated-seq', 'truncated multi-byte sequence at a quote', (b) => spliceBytes(b, W, 'Invented', [0xe2, 0x82]), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('raw-control-01', 'raw 0x01 inside a string', (b) => spliceBytes(b, W, 'Invented', [0x01]), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('raw-tab', 'raw TAB inside a string', (b) => spliceBytes(b, W, 'Invented', [0x09]), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('utf16le-bom', 'UTF-16LE with BOM', (b) => rawEdit(b, W, (t) => { const u = Buffer.from('\ufeff' + t, 'utf16le'); return new Uint8Array(u); }), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('utf16be-bom', 'UTF-16BE with BOM', (b) => rawEdit(b, W, (t) => { const u = Buffer.from('\ufeff' + t, 'utf16le'); u.swap16(); return new Uint8Array(u); }), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('utf16le-no-bom', 'UTF-16LE without BOM (NUL-interleaved)', (b) => rawEdit(b, W, (t) => new Uint8Array(Buffer.from(t, 'utf16le'))), 'reject', ['JSON_MALFORMED'], { only: true }),
  ],
  'json-bom': [
    pc('dataset-bom', 'UTF-8 BOM before a dataset', (b) => rawEdit(b, W, (t) => '\ufeff' + t), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('double-bom', 'two UTF-8 BOMs', (b) => rawEdit(b, W, (t) => '\ufeff\ufeff' + t), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('manifest-bom', 'UTF-8 BOM before manifest.json', (b) => rawManifest(b, (t) => '\ufeff' + t), 'reject', ['JSON_BAD_UTF8'], { only: true }),
    pc('space-then-bom', 'BOM not at byte 0', (b) => rawEdit(b, W, (t) => ' \ufeff' + t), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('bom-in-value', 'U+FEFF inside a string value is text, flagged', (b) => editPackage(b, W, (v) => { v.data[0].willsay = '\ufeffInvented'; }), 'report', ['TEXT_CONTROL_CHARS']),
  ],
  'json-depth': [
    pc('deep-arrays-document', '10,000 nested arrays as the whole file', (b) => rawEdit(b, W, () => '['.repeat(10000) + ']'.repeat(10000)), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('deep-objects-document', '10,000 nested objects as the whole file', (b) => rawEdit(b, W, () => '{"a":'.repeat(10000) + '1' + '}'.repeat(10000)), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('deep-in-field', '30 nested arrays inside one record field (depth 33)', (b) => rawEdit(b, W, (t) => t.replace(`"willsay": ${WILL}`, `"willsay": ${WILL},\n      "x": ${'['.repeat(30)}${']'.repeat(30)}`)), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('depth-boundary', '29 nested arrays inside a field (depth 32, within the bound)', (b) => editPackage(b, W, (v) => { let x: unknown = []; for (let i = 1; i < 29; i++) x = [x]; v.data[0].x = x; }), 'report', ['DS_UNSUPPORTED_FIELD']),
  ],
  'json-dup-key': [
    pc('dup-field', 'record field declared twice', (b) => rawEdit(b, W, (t) => t.replace('"name": "Ann Lee",', '"name": "Ann Lee",\n      "name": "Bob Lee",')), 'reject', ['JSON_DUPLICATE_KEY'], { only: true }),
    pc('dup-escaped', 'duplicate key spelled with an escape', (b) => rawEdit(b, W, (t) => t.replace('"name": "Ann Lee",', '"name": "Ann Lee",\n      "n\\u0061me": "Bob Lee",')), 'reject', ['JSON_DUPLICATE_KEY'], { only: true }),
    pc('dup-envelope-data', 'envelope data declared twice (second empty)', (b) => rawEdit(b, W, (t) => t.replace('"envelope":', '"data": [],\n  "envelope":')), 'reject', ['JSON_DUPLICATE_KEY'], { only: true }),
    pc('dup-manifest-version', 'manifest formatVersion declared twice', (b) => rawManifest(b, (t) => t.replace('"formatVersion": 1,', '"formatVersion": 1,\n  "formatVersion": 2,')), 'reject', ['JSON_DUPLICATE_KEY'], { only: true }),
    pc('case-differing-keys', 'name and Name are distinct keys (Name preserved, not rendered)', (b) => editPackage(b, W, (v) => { v.data[0].Name = 'Other'; }), 'report', ['DS_UNSUPPORTED_FIELD']),
  ],
  'json-nonfinite': [
    pc('nan', 'NaN literal', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": NaN')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('infinity', 'Infinity literal', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": Infinity')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('neg-infinity', '-Infinity literal', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": -Infinity')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('nan-string', '"NaN" as a string stays a string', (b) => editPackage(b, P, (v) => { v.data[0].weight = 'NaN'; }), 'report', ['DS_UNSUPPORTED_FIELD']),
  ],
  'json-number': [
    pc('2^53+1', 'integer beyond 2^53-1', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": 9007199254740993')), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('2^64', '18446744073709551616', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": 18446744073709551616')), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('1e400', 'overflows to Infinity', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": 1e400')), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('1e999999999', 'huge exponent', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": 1e999999999')), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('10000-digits', '10,000-digit integer', (b) => rawEdit(b, P, (t) => t.replace(SENT, `"sent": 1${'0'.repeat(9999)}`)), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('1e-400', 'underflows to 0: not the canonical spelling', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": 1e-400')), 'reject', ['PKG_NONCANONICAL']),
    pc('neg-zero', '-0 is written 0 canonically', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": -0')), 'reject', ['PKG_NONCANONICAL'], { only: true }),
    pc('2.0', '2.0 is written 2 canonically', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": 2.0')), 'reject', ['PKG_NONCANONICAL'], { only: true }),
    pc('leading-zero', '02 is not JSON', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": 02')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('plus-sign', '+2 is not JSON', (b) => rawEdit(b, P, (t) => t.replace(SENT, '"sent": +2')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('number-as-string', 'count given as a string', (b) => editPackage(b, P, (v) => { v.data[0].sent = '2'; }), 'reject', ['DS_SHAPE_INVALID']),
  ],
  'json-surrogate': [
    pc('lone-high-escape', 'lone \\ud800 in text', (b) => rawEdit(b, W, (t) => t.replace(WILL, '"x\\ud800y"')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('lone-low-key', 'lone \\udc00 as a key', (b) => rawEdit(b, W, (t) => t.replace('"willsay"', '"\\udc00"')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('reversed-pair', 'low then high surrogate escapes', (b) => rawEdit(b, W, (t) => t.replace(WILL, '"\\ude00\\ud83d"')), 'reject', ['JSON_MALFORMED'], { only: true }),
    pc('escaped-pair', 'valid pair written as escapes (not canonical)', (b) => rawEdit(b, W, (t) => t.replace(WILL, '"\\ud83d\\ude00"')), 'reject', ['PKG_NONCANONICAL'], { only: true }),
    pc('raw-pair', 'valid astral character written raw', (b) => editPackage(b, W, (v) => { v.data[0].willsay = 'smile \u{1F600}'; }), 'report', []),
  ],
  'json-proto': [
    pc('proto-key', '__proto__ key inside a record', (b) => editPackage(b, W, (v) => { Object.defineProperty(v.data[0], '__proto__', { value: { polluted: 'yes' }, enumerable: true, writable: true, configurable: true }); }), 'report', ['DS_UNSUPPORTED_FIELD'], { subject: '__proto__' }),
    pc('constructor-prototype', 'constructor.prototype chain inside a record', (b) => editPackage(b, W, (v) => { v.data[0].constructor = { prototype: { polluted: 'yes' } }; }), 'report', ['DS_UNSUPPORTED_FIELD'], { subject: 'constructor' }),
    pc('proto-raw-manifest', '__proto__ at manifest top level (closed manifest)', (b) => rawManifest(b, (t) => t.replace('{\n  "case"', '{\n  "__proto__": {"formatVersion": 2},\n  "case"')), 'reject', ['PKG_MANIFEST_INVALID']),
  ],
  'json-nul': [
    pc('nul-in-text', 'escaped NUL inside narrative text (kept, flagged, shown visibly)', (b) => editPackage(b, W, (v) => { v.data[0].willsay = 'before\u0000after'; }), 'report', ['TEXT_CONTROL_CHARS']),
    pc('nul-in-asset-path', 'escaped NUL inside an original path', (b) => setAsset(b, 'OD-001', { path: `${OD1}\u0000/../../x` }), 'reject', ['ASSET_PATH_INVALID']),
    pc('nul-in-url', 'NUL inside a legacy locator', (b) => chron(b, (r) => { r[0].url = './docs/x%00.pdf'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
  ],
  'size': [
    pc('array-items', 'array with 1,000,001 items', (b) => rawEdit(b, W, (t) => t.replace(`"willsay": ${WILL}`, `"willsay": ${WILL},\n      "x": [${'0,'.repeat(1_000_000)}0]`)), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('object-keys', 'object with 100,001 keys', (b) => rawEdit(b, W, (t) => t.replace(`"willsay": ${WILL}`, `"willsay": ${WILL},\n      "x": {${Array.from({ length: 100_001 }, (_, i) => `"k${i}":0`).join(',')}}`)), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('string-chars', 'string of 1 MiB + 1 characters', (b) => rawEdit(b, W, (t) => t.replace(WILL, `"${'A'.repeat(1024 * 1024 + 1)}"`)), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('key-chars', 'key of 1 MiB + 1 characters', (b) => rawEdit(b, W, (t) => t.replace('"willsay"', `"${'k'.repeat(1024 * 1024 + 1)}"`)), 'reject', ['JSON_LIMIT'], { only: true }),
    pc('count-lie', 'envelope count disagrees with the records', (b) => editPackage(b, W, (v) => { v.count = 5; }), 'reject', ['DS_COUNT_MISMATCH']),
    pc('package-files-bound', 'more listed files than the bound', (b) => b, 'reject', ['PKG_TOO_MANY_FILES'], { limits: { packageFiles: 10 } }),
    pc('package-bytes-bound', 'more bytes than the bound', (b) => b, 'reject', ['PKG_TOO_LARGE'], { limits: { packageBytes: 4096 } }),
    pc('manifest-too-large', 'manifest above 1 MiB', (b) => { const o = new Map(b); o.set('manifest.json', utf8(' '.repeat(1024 * 1024 + 1))); return o; }, 'reject', ['PKG_TOO_LARGE'], { only: true }),
  ],
  'schema-version': [
    pc('future-major', 'formatVersion 2', (b) => manifest(b, (m) => { m.formatVersion = 2; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('string-1', 'formatVersion "1" (string)', (b) => manifest(b, (m) => { m.formatVersion = '1'; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('string-1.0', 'formatVersion "1.0"', (b) => manifest(b, (m) => { m.formatVersion = '1.0'; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('string-1.0-nul', 'formatVersion "1.0\\u0000"', (b) => manifest(b, (m) => { m.formatVersion = '1.0\u0000'; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('fullwidth', 'formatVersion with fullwidth digit', (b) => manifest(b, (m) => { m.formatVersion = '\uff11'; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('zero', 'formatVersion 0 (older, no migration)', (b) => manifest(b, (m) => { m.formatVersion = 0; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('negative', 'formatVersion -1', (b) => manifest(b, (m) => { m.formatVersion = -1; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('huge', 'formatVersion 99999999999999', (b) => manifest(b, (m) => { m.formatVersion = 99999999999999; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('null', 'formatVersion null', (b) => manifest(b, (m) => { m.formatVersion = null; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('array', 'formatVersion [1]', (b) => manifest(b, (m) => { m.formatVersion = [1]; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('object', 'formatVersion {major:1}', (b) => manifest(b, (m) => { m.formatVersion = { major: 1, minor: 0 }; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('absent', 'formatVersion missing', (b) => manifest(b, (m) => { delete m.formatVersion; }), 'reject', ['VER_UNSUPPORTED'], { only: true }),
    pc('schemaVersion-instead', 'schemaVersion "1.0" instead of formatVersion', (b) => manifest(b, (m) => { delete m.formatVersion; m.schemaVersion = '1.0'; }), 'reject', ['VER_UNSUPPORTED'], { only: true, subject: 'schemaVersion "1.0"' }),
    pc('literal-1.0', 'formatVersion written 1.0 (number, not canonical)', (b) => rawManifest(b, (t) => t.replace('"formatVersion": 1,', '"formatVersion": 1.0,')), 'reject', ['PKG_NONCANONICAL'], { only: true }),
    pc('literal-1e0', 'formatVersion written 1e0', (b) => rawManifest(b, (t) => t.replace('"formatVersion": 1,', '"formatVersion": 1e0,')), 'reject', ['PKG_NONCANONICAL'], { only: true }),
    pc('format-other', 'format is not clearcase.results-package', (b) => manifest(b, (m) => { m.format = 'synthetic-results-package'; }), 'reject', ['PKG_NOT_A_PACKAGE'], { only: true }),
    pc('manifest-array', 'manifest is a JSON array', (b) => rawManifest(b, () => '[]\n'), 'reject', ['PKG_NOT_A_PACKAGE'], { only: true }),
    pc('unknown-top-level', 'unknown top-level key x-unknown (closed manifest)', (b) => manifest(b, (m) => { m['x-unknown'] = { note: '<script>' }; }), 'reject', ['PKG_MANIFEST_INVALID']),
    pc('required-capability', 'requiredReaderVersion capability key', (b) => manifest(b, (m) => { m.requiredReaderVersion = '2'; }), 'reject', ['PKG_MANIFEST_INVALID']),
    pc('extension-ok', 'extensions["x-tool"] is the extension point', (b) => manifest(b, (m) => { m.extensions = { 'x-tool': { note: 'kept, never rendered' } }; }), 'report', []),
    pc('extension-unprefixed', 'extensions key without x- prefix', (b) => manifest(b, (m) => { m.extensions = { tool: 1 }; }), 'reject', ['PKG_MANIFEST_INVALID']),
    pc('dataset-schema-future', 'required dataset with an unknown schema version', (b) => resealFiles(editPackage(b, 'datasets/chronology.json', (v) => { v.schema = 'v5.chronology@2'; }, false), (m) => { m.files.find((f: any) => f.key === 'chronology').schema = 'v5.chronology@2'; }), 'reject', ['DS_SCHEMA_UNSUPPORTED']),
    pc('optional-schema-unknown', 'optional dataset with an unknown schema (kept, not rendered)', (b) => resealFiles(editPackage(b, 'datasets/conversion-report.json', (v) => { v.schema = 'future.report@3'; }, false), (m) => { m.files.find((f: any) => f.key === 'conversion-report').schema = 'future.report@3'; }), 'report', ['DS_UNKNOWN_SCHEMA']),
    pc('envelope-version', 'dataset envelope clearcase.dataset/2', (b) => editPackage(b, W, (v) => { v.envelope = 'clearcase.dataset/2'; }), 'reject', ['DS_ENVELOPE_INVALID']),
  ],
  'manifest-integrity': [
    pc('sha-zeros', 'listed sha256 is all zeros', (b) => rawManifest(b, (t) => t.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${ZERO_SHA}"`)), 'reject', ['PKG_FILE_HASH_MISMATCH']),
    pc('size-small', 'declared size 10, file larger', (b) => rawManifest(b, (t) => t.replace(/"size": \d+/, '"size": 10')), 'reject', ['PKG_FILE_HASH_MISMATCH']),
    pc('size-huge', 'declared size 1e12, file small', (b) => rawManifest(b, (t) => t.replace(/"size": \d+/, '"size": 1000000000000')), 'reject', ['PKG_FILE_HASH_MISMATCH']),
    pc('bytes-changed', 'dataset bytes changed after sealing', (b) => { const o = new Map(b); o.set(W, utf8(text(b, W).replace('Invented', 'Inventad'))); return o; }, 'reject', ['PKG_FILE_HASH_MISMATCH']),
    pc('listed-missing', 'listed dataset absent', (b) => { const o = new Map(b); o.delete(W); return o; }, 'reject', ['PKG_FILE_MISSING']),
    pc('manifest-missing', 'manifest.json absent', (b) => { const o = new Map(b); o.delete('manifest.json'); return o; }, 'reject', ['PKG_MANIFEST_MISSING'], { only: true }),
    pc('unlisted-extra', 'extra file not listed (ignored, never imported)', (b) => { const o = new Map(b); o.set('datasets/extra.json', utf8('{"x": "<script>"}\n')); return o; }, 'report', ['PKG_UNLISTED_FILE'], { subject: 'datasets/extra.json' }),
    pc('results-version', 'resultsVersion tampered', (b) => rawManifest(b, (t) => t.replace(/"resultsVersion": "sha256:[0-9a-f]{64}"/, `"resultsVersion": "sha256:${ZERO_SHA}"`)), 'reject', ['PKG_VERSION_MISMATCH']),
    pc('input-revision', 'inputRevision.id tampered', (b) => manifest(b, (m) => { m.inputRevision.id = `sha256:${'1'.repeat(64)}`; }), 'reject', ['PKG_INPUT_REVISION_MISMATCH']),
    pc('no-asset-index', 'assets.json not listed', (b) => manifest(b, (m) => { m.files = m.files.filter((f: any) => f.role !== 'assets'); }), 'reject', ['PKG_ROLE_INVALID']),
  ],
  'manifest-path': [
    pc('dotdot', 'listed path ../datasets/x.json', (b) => manifest(b, (m) => { m.files.find((f: any) => f.key === 'witnesses').path = '../datasets/witnesses.json'; }), 'reject', ['PKG_PATH_TRAVERSAL']),
    pc('absolute', 'listed path /datasets/x.json', (b) => manifest(b, (m) => { m.files.find((f: any) => f.key === 'witnesses').path = '/datasets/witnesses.json'; }), 'reject', ['PKG_PATH_TRAVERSAL']),
    pc('drive', 'listed path C:/x.json', (b) => manifest(b, (m) => { m.files.find((f: any) => f.key === 'witnesses').path = 'C:/witnesses.json'; }), 'reject', ['PKG_PATH_TRAVERSAL']),
    pc('backslash', 'listed path with backslash', (b) => manifest(b, (m) => { m.files.find((f: any) => f.key === 'witnesses').path = 'datasets\\witnesses.json'; }), 'reject', ['PKG_PATH_INVALID']),
    pc('wrong-place', 'dataset not at datasets/<key>.json', (b) => manifest(b, (m) => { m.files.find((f: any) => f.key === 'witnesses').path = 'datasets/people.json'; }), 'reject', ['PKG_PATH_INVALID']),
    pc('memory-dotdot', 'byte-collection key ../evil.json', (b) => { const o = new Map(b); o.set('../evil.json', utf8('{}')); return o; }, 'reject', ['PKG_PATH_TRAVERSAL']),
    pc('memory-drive', 'byte-collection key C:/evil.json', (b) => { const o = new Map(b); o.set('C:/evil.json', utf8('{}')); return o; }, 'reject', ['PKG_PATH_TRAVERSAL']),
    pc('memory-not-bytes', 'byte-collection value is a string', (b) => ({ ...Object.fromEntries(b), 'datasets/x.json': 'not bytes' }), 'reject', ['PKG_SOURCE_INVALID'], { only: true }),
  ],
  'manifest-dup': [
    pc('entry-twice', 'same dataset entry listed twice', (b) => manifest(b, (m) => { m.files.push({ ...m.files.find((f: any) => f.key === 'witnesses') }); }), 'reject', ['PKG_DUPLICATE_PATH']),
    pc('assets-twice', 'assets.json listed twice', (b) => manifest(b, (m) => { m.files.push({ ...m.files.find((f: any) => f.role === 'assets') }); }), 'reject', ['PKG_DUPLICATE_PATH']),
    pc('two-keys-one-path', 'two keys, one path', (b) => manifest(b, (m) => { m.files.push({ ...m.files.find((f: any) => f.key === 'witnesses'), key: 'witnesses-two' }); }), 'reject', ['PKG_PATH_INVALID']),
  ],
  'ref-dup': [
    pc('same-ref-different-doc', 'two documents share ref OD-001', (b) => chron(b, (r) => { r[1].ref = 'OD-001'; }), 'reject', ['ID_DUPLICATE']),
    pc('identical-row-twice', 'identical row appended', (b) => chron(b, (r) => { r.push({ ...r[0] }); }), 'reject', ['ID_DUPLICATE']),
    pc('asset-key-twice', 'asset key declared twice in assets.json', (b) => rawEdit(b, 'assets.json', (t) => t.replace('"assets": {', `"assets": {\n    "OD-001": {"kind": "missing", "mediaType": "application/pdf", "path": "x.pdf", "textStatus": "none"},`)), 'reject', ['JSON_DUPLICATE_KEY']),
    pc('two-refs-one-original', 'two refs name one original (alias, allowed)', (b) => { const a = JSON.parse(text(b, 'assets.json')).assets['OD-001']; return setAsset(b, 'OD-002', { path: a.path, sha256: a.sha256, size: a.size }); }, 'report', ['ASSET_SHARED_PATH', 'ASSET_DUPLICATE_CONTENT', 'LINK_ASSET_MISMATCH']),
  ],
  'ref-variant': [
    pc('lower-case', 'ref od-001', (b) => chron(b, (r) => { r[0].ref = 'od-001'; }), 'reject', ['ID_REF_INVALID']),
    pc('trailing-space', 'ref "OD-001 "', (b) => chron(b, (r) => { r[0].ref = 'OD-001 '; }), 'reject', ['ID_REF_INVALID']),
    pc('nbsp', 'ref with no-break space', (b) => chron(b, (r) => { r[0].ref = 'OD\u00a0001'; }), 'reject', ['ID_REF_INVALID']),
    pc('zero-width', 'ref with zero-width space', (b) => chron(b, (r) => { r[0].ref = 'OD-\u200b001'; }), 'reject', ['ID_REF_INVALID']),
    pc('bom-prefix', 'ref prefixed with U+FEFF', (b) => chron(b, (r) => { r[0].ref = '\ufeffOD-001'; }), 'reject', ['ID_REF_INVALID']),
    pc('fullwidth-digits', 'ref with fullwidth digits', (b) => chron(b, (r) => { r[0].ref = 'OD-\uff10\uff10\uff11'; }), 'reject', ['ID_REF_INVALID']),
    pc('one-megabyte', 'ref of about one megabyte', (b) => chron(b, (r) => { r[0].ref = 'OD-' + '1'.repeat(1_000_000); }), 'reject', ['ID_REF_INVALID']),
    pc('missing-ref', 'row without a ref', (b) => chron(b, (r) => { delete r[0].ref; }), 'reject', ['ID_REF_INVALID', 'DS_SHAPE_INVALID']),
    pc('numeric-ref', 'ref given as a number', (b) => chron(b, (r) => { r[0].ref = 12345; }), 'reject', ['ID_REF_INVALID', 'DS_SHAPE_INVALID']),
    pc('asset-key-lower', 'asset key od-001', (b) => editPackage(b, 'assets.json', (v) => { v.assets['od-001'] = v.assets['OD-001']; delete v.assets['OD-001']; }), 'reject', ['ID_REF_INVALID']),
    pc('embedded-key-mismatch', 'embedded asset key does not name its parent', (b) => editPackage(b, 'assets.json', (v) => { v.assets['OD-002.a1'] = v.assets['EM-0001.a1']; delete v.assets['EM-0001.a1']; }), 'reject', ['ID_REF_INVALID']),
  ],
  'citation': [
    pc('unresolved-token', '[[XX-999]] not in the register', (b) => prose(b, 'See [[XX-999]].'), 'report', ['CITE_UNRESOLVED'], { subject: 'XX-999' }),
    pc('lower-case-token', '[[od-001]] (no case-insensitive fallback)', (b) => prose(b, 'See [[od-001]].'), 'report', ['CITE_TOKEN_INVALID']),
    pc('empty-token', '[[]]', (b) => prose(b, 'See [[]].'), 'report', ['CITE_TOKEN_INVALID']),
    pc('path-token', '[[originals/syn-001.txt]] (citations resolve by ref only)', (b) => prose(b, 'See [[originals/syn-001.txt]].'), 'report', ['CITE_TOKEN_INVALID']),
    pc('page-zero', '[[OD-001#p0]]', (b) => prose(b, 'See [[OD-001#p0]].'), 'report', ['CITE_TOKEN_INVALID']),
    pc('structured-unresolved', 'also_in names XX-404', (b) => chron(b, (r) => { r[0].also_in = ['XX-404']; }), 'report', ['CITE_UNRESOLVED'], { subject: 'XX-404' }),
    pc('structured-empty', 'also_in names the empty string', (b) => chron(b, (r) => { r[0].also_in = ['']; }), 'report', ['CITE_UNRESOLVED']),
    pc('structured-lower', 'also_in names od-002', (b) => chron(b, (r) => { r[0].also_in = ['od-002']; }), 'report', ['CITE_UNRESOLVED'], { subject: 'od-002' }),
    pc('structured-space', 'also_in names " OD-002" (no trim)', (b) => chron(b, (r) => { r[0].also_in = [' OD-002']; }), 'report', ['CITE_UNRESOLVED']),
    pc('structured-null', 'also_in holds null', (b) => chron(b, (r) => { r[0].also_in = [null]; }), 'reject', ['DS_SHAPE_INVALID']),
    pc('headline-ref', 'quantum.headline_ref names XX-1', (b) => editPackage(b, 'datasets/quantum.json', (v) => { v.data.headline_ref = 'XX-1'; }), 'report', ['CITE_UNRESOLVED'], { subject: 'XX-1' }),
    pc('recon-array', 'lit-recon invoice names ZZ-9', (b) => editPackage(b, 'datasets/lit-recon.json', (v) => { v.data[0].invoice = ['ZZ-9']; }), 'report', ['CITE_UNRESOLVED'], { subject: 'ZZ-9' }),
    pc('duplicate-token', 'the same ref cited twice', (b) => prose(b, '[[OD-001]] and again [[OD-001]].'), 'report', []),
  ],
  'citation-graph': [
    pc('self-citation', 'OD-001 lists itself in also_in', (b) => chron(b, (r) => { r[0].also_in = ['OD-001']; }), 'report', []),
    pc('two-cycle', 'OD-001 and OD-002 cite each other', (b) => chron(b, (r) => { r[0].also_in = ['OD-002']; r[1].also_in = ['OD-001']; }), 'report', []),
    pc('ring-3000', 'ring of 3,000 rows each citing the next', (b) => chron(b, (r) => {
      const t = r[2];
      for (let i = 0; i < 3000; i++) r.push({ ...t, ref: `RG-${i}`, also_in: [`RG-${(i + 1) % 3000}`] });
    }), 'report', ['ASSET_NOT_INDEXED']),
    pc('asset-parent-cycle', 'asset parent chain cycles', (b) => editPackage(b, 'assets.json', (v) => { v.assets['OD-001'].parentRef = 'EM-0001'; v.assets['EM-0001'].parentRef = 'OD-001'; }), 'reject', ['ASSET_PARENT_CYCLE']),
    pc('asset-parent-self', 'asset is its own parent', (b) => editPackage(b, 'assets.json', (v) => { v.assets['EM-0001'].parentRef = 'EM-0001'; }), 'reject', ['ASSET_PARENT_CYCLE']),
    pc('asset-parent-unknown', 'asset parent not indexed', (b) => editPackage(b, 'assets.json', (v) => { v.assets['OD-001'].parentRef = 'ZZ-404'; }), 'reject', ['ASSET_PARENT_UNKNOWN']),
  ],
  'link-field': [
    pc('javascript', 'url javascript:alert(1)', (b) => chron(b, (r) => { r[0].url = 'javascript:alert(1)'; }), 'reject', ['LINK_UNSAFE_SCHEME'], { subject: 'javascript' }),
    pc('mixed-case-padded', 'url "  JaVaScRiPt:alert(1)"', (b) => chron(b, (r) => { r[0].url = '  JaVaScRiPt:alert(1)'; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('tab-in-scheme', 'url java<TAB>script:', (b) => chron(b, (r) => { r[0].url = 'java\tscript:alert(1)'; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('leading-c0', 'url \\u0001javascript:', (b) => chron(b, (r) => { r[0].url = '\u0001javascript:alert(1)'; }), 'reject', ['LINK_UNSAFE_SCHEME', 'TEXT_CONTROL_CHARS']),
    pc('data', 'url data:text/html', (b) => chron(b, (r) => { r[0].url = 'data:text/html;base64,PGgxPmhpPC9oMT4='; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('vbscript-file-field', 'bundles file vbscript:', (b) => editPackage(b, 'datasets/bundles.json', (v) => { v.data.list[0].file = 'vbscript:msgbox(1)'; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('blob-headline', 'quantum headline_url blob:', (b) => editPackage(b, 'datasets/quantum.json', (v) => { v.data.headline_url = 'blob:https://evil.example/x'; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('file-uri', 'url file:///etc/passwd', (b) => chron(b, (r) => { r[0].url = 'file:///etc/passwd'; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('ftp', 'url ftp://', (b) => chron(b, (r) => { r[0].url = 'ftp://evil.example/x'; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('protocol-relative', 'url //evil.example/x', (b) => chron(b, (r) => { r[0].url = '//evil.example/x'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('unc', 'url \\\\evil.example\\share', (b) => chron(b, (r) => { r[0].url = '\\\\evil.example\\share\\x.pdf'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('absolute', 'url /etc/passwd', (b) => chron(b, (r) => { r[0].url = '/etc/passwd'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('drive-colon', 'url C:\\x.pdf', (b) => chron(b, (r) => { r[0].url = 'C:\\Windows\\win.ini'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('drive-pipe', 'url C|/x.pdf', (b) => chron(b, (r) => { r[0].url = 'C|/x.pdf'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('dotdot', 'url ../x.pdf', (b) => chron(b, (r) => { r[0].url = '../outside/secret.txt'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('encoded-separator', 'url ./..%2F..%2Fetc%2Fpasswd', (b) => chron(b, (r) => { r[0].url = './..%2F..%2Fetc%2Fpasswd'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('encoded-dots', 'url ./%2e%2e/x (decoded once, then checked)', (b) => chron(b, (r) => { r[0].url = './%2e%2e/outside/secret.txt'; }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('credentials', 'url https://user:pass@host', (b) => chron(b, (r) => { r[0].url = 'https://user:pass@evil.example/'; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('userinfo-confusion', 'url https://example.com@evil.example/', (b) => chron(b, (r) => { r[0].url = 'https://example.com@evil.example/'; }), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('too-long', 'url of 3,000 characters', (b) => chron(b, (r) => { r[0].url = 'https://example.com/' + 'a'.repeat(3000); }), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('http-text-only', 'url http:// (text only)', (b) => chron(b, (r) => { r[0].url = 'http://example.com/a'; }), 'report', ['LINK_TEXT_ONLY']),
    pc('tel-text-only', 'url tel: (text only)', (b) => chron(b, (r) => { r[0].url = 'tel:+15550100'; }), 'report', ['LINK_TEXT_ONLY']),
    pc('https-external', 'url https:// (inert external)', (b) => chron(b, (r) => { r[0].url = 'https://example.com/a'; }), 'report', ['LINK_EXTERNAL']),
    pc('mailto-external', 'url mailto: (inert external)', (b) => chron(b, (r) => { r[0].url = 'mailto:counsel@example.invalid'; }), 'report', ['LINK_EXTERNAL']),
  ],
  'link-prose': [
    pc('md-javascript', '[x](javascript:alert(1)) in authored prose', (b) => prose(b, 'See [x](javascript:alert(1)).'), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('md-image-data', '![t](data:image/svg+xml,...) in prose', (b) => prose(b, '![t](data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E)'), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('autolink-javascript', '<javascript:alert(1)> autolink', (b) => prose(b, 'Go <javascript:alert(1)> now'), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('nested-link', 'nested link with javascript: outer target', (b) => prose(b, '[[inner](https://example.com)](javascript:alert(1))'), 'reject', ['LINK_UNSAFE_SCHEME']),
    pc('md-protocol-relative', '[x](//evil.example)', (b) => prose(b, '[x](//evil.example/x)'), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('md-traversal', '[x](../../etc/passwd)', (b) => prose(b, '[x](../../etc/passwd)'), 'reject', ['LINK_RELATIVE_UNSAFE']),
    pc('md-https', '[x](https://example.com) is inert', (b) => prose(b, '[x](https://example.com/a)'), 'report', ['LINK_EXTERNAL']),
    pc('md-entity-scheme', '[x](java&#10;script:...) is not a scheme; literal text', (b) => prose(b, '[x](java&#10;script:alert(1))'), 'report', []),
    pc('md-newline-in-target', 'java<LF>script: target is not a link; literal text', (b) => prose(b, '[x](java\nscript:alert(1))'), 'report', []),
    pc('md-reference-definition', 'reference-style definition stays text', (b) => prose(b, '[x][1]\n\n[1]: javascript:alert(1)'), 'report', []),
    pc('raw-anchor', 'raw <a href="javascript:"> stays text', (b) => prose(b, '<a href="javascript:alert(1)">x</a>'), 'report', []),
  ],
  'text-markup': [
    pc('script', '<script> in prose', (b) => prose(b, '<script>alert(1)</script>'), 'report', []),
    pc('img-onerror', '<img onerror> in prose', (b) => prose(b, '<img src=x onerror=alert(1)>'), 'report', []),
    pc('svg-onload', '<svg onload> in a heading', (b) => editPackage(b, 'datasets/matter.json', (v) => { v.data.storyline[0].h = '<svg onload=alert(1)>'; }), 'report', []),
    pc('bidi-in-prose', 'RLO in prose (flagged, shown visibly)', (b) => prose(b, 'invoice\u202Efdp.exe'), 'report', ['TEXT_CONTROL_CHARS']),
    pc('template', '{{7*7}} and ${alert(1)} stay text', (b) => prose(b, '{{7*7}} ${alert(1)} {{constructor.constructor("alert(1)")()}}'), 'report', []),
  ],
};

// ---- 2. original cases: the case folder on disk -----------------------------------------------

export interface OrigCtx {
  root: string;
  /** fresh copy of the synthetic case folder */
  caseDir: string;
  /** sibling folder outside the case folder, with outside/secret.txt */
  outside: string;
  base: Files;
}

export interface OrigCase {
  id: string;
  threat: string;
  setup: (c: OrigCtx) => Promise<Files>;
  /** the case folder argument (default caseDir) */
  folder?: (c: OrigCtx) => string;
  verdict: Verdict;
  codes: Code[];
  absent?: Code[];
  /** ref -> recorded on-disk path, or null when the ref must not be mapped */
  mapping?: Record<string, string | null>;
  downloadOnly?: Record<string, boolean>;
  unavailable?: string[];
}

export const SECRET = utf8('synthetic outside secret\n');
/** Synthetic original paths by ref, taken from the fixture (never hard-coded folder names). */
const ORIG = (ref: string): string => {
  const k = Object.keys(synthOriginals()).find((p) => p.split('/').pop()!.startsWith(`${ref} `));
  if (!k) throw new Error(`no synthetic original for ${ref}`);
  return k;
};
const OD1 = ORIG('OD-001');
const OD4 = ORIG('OD-004');
const EM1 = ORIG('EM-0001');
const EM2 = ORIG('EM-0002');
const SD1 = ORIG('SD-001');
const OD_DIR = path.posix.dirname(OD1);

const abs = (c: OrigCtx, rel: string) => path.join(c.caseDir, ...rel.split('/'));
async function put(dir: string, rel: string | Uint8Array, bytes: Uint8Array): Promise<void> {
  if (typeof rel === 'string') {
    const p = path.join(dir, ...rel.split('/'));
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, bytes);
  } else {
    await writeFile(Buffer.concat([Buffer.from(dir + path.sep), Buffer.from(rel)]), bytes);
  }
}
const mkfifo = (p: string) => execFileSync('mkfifo', [p]);
/** Point an asset at new bytes (the hostile original) with a consistent fingerprint. */
const reindex = (files: Files, ref: string, bytes: Uint8Array, patch: Record<string, unknown> = {}) => setAsset(files, ref, { sha256: sha256Hex(bytes), size: bytes.byteLength, ...patch });

const oc = (id: string, threat: string, setup: OrigCase['setup'], verdict: Verdict, codes: Code[], extra: Partial<OrigCase> = {}): OrigCase => ({ id, threat, setup, verdict, codes, ...extra });

/** A mini package whose docs point at names written into the case folder. */
interface NameDoc { ref: string; path: string; /** disk name whose bytes the index fingerprints (default: path) */ from?: string | Uint8Array | null }
function nameCase(id: string, threat: string, disk: (string | Uint8Array)[], docs: NameDoc[], verdict: Verdict, codes: Code[], extra: Partial<OrigCase> = {}): OrigCase {
  return oc(id, threat, async (c) => {
    const dir = path.join(c.caseDir, 'names');
    await mkdir(dir, { recursive: true });
    const bytesOf = (n: string | Uint8Array) => pdf(typeof n === 'string' ? n : Buffer.from(n).toString('hex'));
    for (const n of disk) await put(dir, n, bytesOf(n));
    return miniPackage({
      docs: docs.map((d) => {
        const from = d.from === undefined ? d.path : d.from;
        return { ref: d.ref, path: `names/${d.path}`, bytes: from === null ? null : bytesOf(from), filename: d.path, mediaType: 'application/pdf' };
      }),
    });
  }, verdict, codes, extra);
}
const N = (p: string) => `names/${p}`;
const LONG255 = 'A'.repeat(251) + '.pdf';

export const ORIGINAL_CASES: Record<string, OrigCase[]> = {
  'symlink-escape': [
    oc('file-link-relative', 'original replaced by a relative link to an outside copy with matching bytes', async (c) => {
      await writeFile(path.join(c.outside, 'copy.pdf'), await readFile(abs(c, OD1)));
      await rm(abs(c, OD1));
      await symlink(path.relative(path.dirname(abs(c, OD1)), path.join(c.outside, 'copy.pdf')), abs(c, OD1));
      return c.base;
    }, 'reject', ['ORIG_ESCAPE'], { mapping: { 'OD-001': null } }),
    oc('file-link-absolute', 'original replaced by an absolute link to an outside copy', async (c) => {
      await writeFile(path.join(c.outside, 'copy.pdf'), await readFile(abs(c, OD1)));
      await rm(abs(c, OD1));
      await symlink(path.join(c.outside, 'copy.pdf'), abs(c, OD1));
      return c.base;
    }, 'reject', ['ORIG_ESCAPE']),
    oc('ancestor-dir-link', 'a folder of originals is a link to an outside folder', async (c) => {
      await cp(abs(c, OD_DIR), path.join(c.outside, 'od'), { recursive: true });
      await rm(abs(c, OD_DIR), { recursive: true });
      await symlink(path.join(c.outside, 'od'), abs(c, OD_DIR));
      return c.base;
    }, 'reject', ['ORIG_ESCAPE']),
    oc('link-to-dev-zero', 'original is a link to /dev/zero (never opened)', async (c) => {
      await rm(abs(c, OD4));
      await symlink('/dev/zero', abs(c, OD4));
      return c.base;
    }, 'reject', ['ORIG_ESCAPE']),
    oc('parent-dir-link', 'up -> .. used as a path segment', async (c) => {
      await symlink('..', abs(c, 'up'));
      await writeFile(path.join(c.outside, 'up.pdf'), pdf('up'));
      return reindex(c.base, 'OD-001', pdf('up'), { path: `up/${path.basename(c.outside)}/up.pdf` });
    }, 'reject', ['ORIG_ESCAPE']),
    oc('dangling-link', 'dangling link (reported missing, never followed out)', async (c) => {
      await rm(abs(c, OD1));
      await symlink('/nonexistent-synthetic/secret.pdf', abs(c, OD1));
      return c.base;
    }, 'report', ['ORIG_MISSING', 'CITE_TARGET_NO_ORIGINAL'], { mapping: { 'OD-001': null }, unavailable: ['OD-001'] }),
    oc('link-loop', 'two links pointing at each other', async (c) => {
      await rm(abs(c, OD1));
      await symlink('loop-b', abs(c, OD1));
      await symlink(path.basename(OD1), abs(c, `${OD_DIR}/loop-b`));
      return c.base;
    }, 'report', ['ORIG_MISSING'], { mapping: { 'OD-001': null } }),
    oc('contained-link', 'a link that stays inside the case folder is followed (policy)', async (c) => {
      await rename(abs(c, OD1), abs(c, `${OD_DIR}/real.pdf`));
      await symlink('real.pdf', abs(c, OD1));
      return c.base;
    }, 'report', [], { absent: ['ORIG_ESCAPE', 'ORIG_MISSING', 'ORIG_NOT_FILE'], mapping: { 'OD-001': OD1 } }),
    oc('self-dir-link', 'self -> . used as a path segment stays inside', async (c) => {
      await symlink('.', abs(c, 'self'));
      return setAsset(c.base, 'OD-001', { path: `self/${OD1}` });
    }, 'report', ['LINK_ASSET_MISMATCH'], { absent: ['ORIG_ESCAPE'], mapping: { 'OD-001': `self/${OD1}` } }),
  ],
  'hardlink-escape': [
    oc('hardlink-outside-inode-match', 'hardlink shares an outside inode; bytes match the index (accepted by policy)', async (c) => {
      await writeFile(path.join(c.outside, 'shared.pdf'), await readFile(abs(c, OD1)));
      await rm(abs(c, OD1));
      await link(path.join(c.outside, 'shared.pdf'), abs(c, OD1));
      return c.base;
    }, 'report', [], { absent: ['ORIG_ESCAPE', 'ORIG_FINGERPRINT_MISMATCH'], mapping: { 'OD-001': OD1 } }),
    oc('hardlink-outside-secret', 'hardlink to an outside secret: its bytes never match the index', async (c) => {
      await writeFile(path.join(c.outside, 'secret2.txt'), SECRET);
      await rm(abs(c, OD1));
      await link(path.join(c.outside, 'secret2.txt'), abs(c, OD1));
      return c.base;
    }, 'reject', ['ORIG_FINGERPRINT_MISMATCH'], { mapping: { 'OD-001': null } }),
    oc('hardlink-shared-inside', 'two indexed names share one inode inside the folder', async (c) => {
      await rm(abs(c, SD1));
      await link(abs(c, OD1), abs(c, SD1));
      const a = JSON.parse(text(c.base, 'assets.json')).assets['OD-001'];
      return setAsset(c.base, 'SD-001', { sha256: a.sha256, size: a.size });
    }, 'report', ['ASSET_DUPLICATE_CONTENT'], { mapping: { 'SD-001': SD1, 'OD-001': OD1 } }),
  ],
  'special-file': [
    oc('fifo', 'original is a FIFO (never opened; would block)', async (c) => {
      await rm(abs(c, OD1));
      mkfifo(abs(c, OD1));
      return c.base;
    }, 'reject', ['ORIG_NOT_FILE'], { mapping: { 'OD-001': null } }),
    oc('fifo-behind-contained-link', 'contained link to a FIFO', async (c) => {
      await rm(abs(c, OD1));
      mkfifo(abs(c, `${OD_DIR}/pipe`));
      await symlink('pipe', abs(c, OD1));
      return c.base;
    }, 'reject', ['ORIG_NOT_FILE']),
    oc('directory', 'original is a directory', async (c) => {
      await rm(abs(c, OD1));
      await mkdir(abs(c, OD1));
      return c.base;
    }, 'reject', ['ORIG_NOT_FILE']),
    oc('case-folder-missing', 'case folder does not exist', async (c) => c.base, 'reject', ['ORIG_CASE_FOLDER_INVALID'], { folder: (c) => path.join(c.root, 'no-such-folder') }),
    oc('case-folder-is-file', 'case folder is a regular file', async (c) => { await writeFile(path.join(c.root, 'plain'), 'x'); return c.base; }, 'reject', ['ORIG_CASE_FOLDER_INVALID'], { folder: (c) => path.join(c.root, 'plain') }),
  ],
  'fingerprint': [
    oc('same-size-other-bytes', 'same size, different bytes', async (c) => {
      const b = await readFile(abs(c, OD1));
      b[b.length - 2] ^= 1;
      await writeFile(abs(c, OD1), b);
      return c.base;
    }, 'reject', ['ORIG_FINGERPRINT_MISMATCH']),
    oc('appended-byte', 'one byte appended', async (c) => { await writeFile(abs(c, OD1), Buffer.concat([await readFile(abs(c, OD1)), Buffer.from('x')])); return c.base; }, 'reject', ['ORIG_FINGERPRINT_MISMATCH']),
    oc('missing', 'original deleted (warning; cited document stays flagged)', async (c) => { await rm(abs(c, OD1)); return c.base; }, 'report', ['ORIG_MISSING', 'CITE_TARGET_NO_ORIGINAL'], { mapping: { 'OD-001': null }, unavailable: ['OD-001'] }),
  ],
  'unicode-normalization': [
    oc('nfd-on-disk', 'indexed NFC name, NFD on disk (fold match, real name recorded)', async (c) => {
      await rename(abs(c, EM2), abs(c, EM2.normalize('NFD')));
      return c.base;
    }, 'report', ['ORIG_CASE_MISMATCH'], { mapping: { 'EM-0002': EM2.normalize('NFD') } }),
    oc('nfc-and-nfd-on-disk', 'both spellings on disk: exact match wins, no warning', async (c) => {
      await writeFile(abs(c, EM2.normalize('NFD')), utf8('other bytes'));
      return c.base;
    }, 'report', [], { absent: ['ORIG_CASE_MISMATCH', 'ORIG_FINGERPRINT_MISMATCH'], mapping: { 'EM-0002': EM2 } }),
    nameCase('nfd-indexed-nfc-disk', 'indexed NFD, only NFC on disk', ['café.pdf'], [{ ref: 'NM-1', path: 'cafe\u0301.pdf', from: 'café.pdf' }], 'report', ['ORIG_CASE_MISMATCH'], { mapping: { 'NM-1': N('café.pdf') } }),
    nameCase('nfc-nfd-pair-indexed', 'NFC and NFD names indexed as two refs', ['café.pdf', 'cafe\u0301.pdf'], [{ ref: 'NM-1', path: 'café.pdf' }, { ref: 'NM-2', path: 'cafe\u0301.pdf' }], 'reject', ['ASSET_AMBIGUOUS_MAPPING']),
    nameCase('kelvin-sign', 'Kelvin sign is NFC-equivalent to K (fold match, flagged)', ['\u212aey.pdf'], [{ ref: 'NM-1', path: 'Key.pdf', from: '\u212aey.pdf' }], 'report', ['ORIG_CASE_MISMATCH'], { mapping: { 'NM-1': N('\u212aey.pdf') } }),
    nameCase('ligature', 'compatibility ligature is not folded (no NFKC)', ['\ufb01le.pdf'], [{ ref: 'NM-1', path: 'file.pdf', from: null }], 'report', ['ORIG_MISSING']),
    nameCase('homoglyph', 'Cyrillic o is not Latin o (no confusable fallback)', ['contract.pdf'], [{ ref: 'NM-1', path: 'c\u043entract.pdf', from: null }], 'report', ['ORIG_MISSING']),
    nameCase('non-utf8-on-disk', 'Latin-1 bytes on disk never match a UTF-8 name', [Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x2e, 0x70, 0x64, 0x66])], [{ ref: 'NM-1', path: 'café.pdf', from: null }], 'report', ['ORIG_MISSING']),
  ],
  'case-collision': [
    oc('case-renamed', 'indexed name differs only by case on disk', async (c) => {
      await rename(abs(c, OD1), abs(c, `${OD_DIR}/od-001 supply agreement.PDF`));
      return c.base;
    }, 'report', ['ORIG_CASE_MISMATCH'], { mapping: { 'OD-001': `${OD_DIR}/od-001 supply agreement.PDF` } }),
    nameCase('triplet-indexed', 'Report.pdf, report.pdf and REPORT.PDF indexed as three refs', ['Report.pdf', 'report.pdf', 'REPORT.PDF'], [{ ref: 'NM-1', path: 'Report.pdf' }, { ref: 'NM-2', path: 'report.pdf' }, { ref: 'NM-3', path: 'REPORT.PDF' }], 'reject', ['ASSET_AMBIGUOUS_MAPPING']),
    nameCase('two-variants-on-disk', 'indexed name absent, two case variants on disk (ambiguous)', ['report.pdf', 'REPORT.pdf'], [{ ref: 'NM-1', path: 'Report.pdf', from: 'report.pdf' }], 'report', ['ORIG_MISSING']),
    nameCase('exact-among-variants', 'exact name present among case variants', ['Report.pdf', 'report.pdf'], [{ ref: 'NM-1', path: 'report.pdf' }], 'accept', [], { mapping: { 'NM-1': N('report.pdf') } }),
    nameCase('sharp-s', 'Straße and STRASSE stay distinct', ['Straße.pdf', 'STRASSE.pdf'], [{ ref: 'NM-1', path: 'Straße.pdf' }, { ref: 'NM-2', path: 'STRASSE.pdf' }], 'accept', [], { mapping: { 'NM-1': N('Straße.pdf'), 'NM-2': N('STRASSE.pdf') } }),
  ],
  'control-char-in-name': [
    ...['line\nbreak.pdf', 'crlf\r\nSet-Cookie: x=1.pdf', '\u001b[2J\u001b[31mred.pdf', 'del\u007f.pdf', 'tab\tname.pdf', 'nel\u0085x.pdf', '\t=1+1.txt'].map((n, i) =>
      nameCase(`control-${i + 1}`, `name ${JSON.stringify(n)} (control characters cannot be indexed)`, [n], [{ ref: 'NM-1', path: n }], 'reject', ['ASSET_PATH_INVALID'])),
    nameCase('line-separator', 'U+2028 is not a control character; exact match', ['para\u2028sep.pdf'], [{ ref: 'NM-1', path: 'para\u2028sep.pdf' }], 'accept', [], { mapping: { 'NM-1': N('para\u2028sep.pdf') } }),
  ],
  'bidi-control': [
    nameCase('rlo-extension-spoof', 'RLO reverses the extension', ['contract\u202efdp.exe'], [{ ref: 'NM-1', path: 'contract\u202efdp.exe' }], 'report', ['TEXT_CONTROL_CHARS'], { mapping: { 'NM-1': N('contract\u202efdp.exe') } }),
    nameCase('isolates-rlm', 'isolates and RLM in a name', ['invoice\u2066\u200f2024\u2069.pdf'], [{ ref: 'NM-1', path: 'invoice\u2066\u200f2024\u2069.pdf' }], 'report', ['TEXT_CONTROL_CHARS'], { mapping: { 'NM-1': N('invoice\u2066\u200f2024\u2069.pdf') } }),
  ],
  'zero-width-char': [
    nameCase('zwsp-exact', 'zero-width space in an exact name', ['rep\u200bort.pdf'], [{ ref: 'NM-1', path: 'rep\u200bort.pdf' }], 'report', ['TEXT_CONTROL_CHARS'], { mapping: { 'NM-1': N('rep\u200bort.pdf') } }),
    nameCase('zwsp-not-stripped', 'report.pdf is not rep<ZWSP>ort.pdf', ['rep\u200bort.pdf'], [{ ref: 'NM-1', path: 'report.pdf', from: 'rep\u200bort.pdf' }], 'report', ['ORIG_MISSING']),
    nameCase('bom-zwj-soft-hyphen', 'BOM, ZWJ and soft hyphen kept byte-exact', ['\ufeffbom.pdf', 'zw\u200dj.pdf', 'soft\u00adhyphen.pdf'], [{ ref: 'NM-1', path: '\ufeffbom.pdf' }, { ref: 'NM-2', path: 'zw\u200dj.pdf' }, { ref: 'NM-3', path: 'soft\u00adhyphen.pdf' }], 'report', ['TEXT_CONTROL_CHARS'], { mapping: { 'NM-1': N('\ufeffbom.pdf'), 'NM-2': N('zw\u200dj.pdf'), 'NM-3': N('soft\u00adhyphen.pdf') } }),
  ],
  'long-name': [
    nameCase('255-bytes', '255-byte name (the bound) exists', [LONG255], [{ ref: 'NM-1', path: LONG255 }], 'accept', [], { mapping: { 'NM-1': N(LONG255) } }),
    nameCase('256-bytes', '256-byte name', [], [{ ref: 'NM-1', path: 'B'.repeat(252) + '.pdf', from: null }], 'reject', ['ASSET_PATH_INVALID']),
    nameCase('404-bytes-multibyte', '202 characters, 404 UTF-8 bytes (bytes count)', [], [{ ref: 'NM-1', path: 'é'.repeat(200) + '.pdf', from: null }], 'reject', ['ASSET_PATH_INVALID']),
    nameCase('path-1100-bytes', 'path longer than 1,024 bytes', [], [{ ref: 'NM-1', path: Array.from({ length: 11 }, () => 'd'.repeat(100)).join('/') + '/x.pdf', from: null }], 'reject', ['ASSET_PATH_INVALID']),
    nameCase('33-segments', 'more than 32 segments', [], [{ ref: 'NM-1', path: 'a/'.repeat(32) + 'x.pdf', from: null }], 'reject', ['ASSET_PATH_INVALID']),
  ],
  'windows-reserved-name': [
    nameCase('device-names', 'CON.pdf, nul.txt, COM1, LPT9.txt are ordinary exact names', ['CON.pdf', 'nul.txt', 'COM1', 'LPT9.txt'], [{ ref: 'NM-1', path: 'CON.pdf' }, { ref: 'NM-2', path: 'nul.txt' }, { ref: 'NM-3', path: 'COM1' }, { ref: 'NM-4', path: 'LPT9.txt' }], 'accept', [], { mapping: { 'NM-1': N('CON.pdf'), 'NM-3': N('COM1') } }),
  ],
  'trailing-dot-space': [
    nameCase('reserved-with-dot-space', 'AUX., "PRN " and "con .txt" match exactly', ['AUX.', 'PRN ', 'con .txt'], [{ ref: 'NM-1', path: 'AUX.' }, { ref: 'NM-2', path: 'PRN ' }, { ref: 'NM-3', path: 'con .txt' }], 'accept', [], { mapping: { 'NM-1': N('AUX.'), 'NM-2': N('PRN ') } }),
    nameCase('dot-twins', 'report.pdf and report.pdf. are two files', ['report.pdf', 'report.pdf.'], [{ ref: 'NM-1', path: 'report.pdf' }, { ref: 'NM-2', path: 'report.pdf.' }], 'accept', [], { mapping: { 'NM-1': N('report.pdf'), 'NM-2': N('report.pdf.') } }),
    nameCase('space-not-trimmed', 'memo.pdf is not "memo.pdf "', ['memo.pdf '], [{ ref: 'NM-1', path: 'memo.pdf', from: 'memo.pdf ' }], 'report', ['ORIG_MISSING']),
  ],
  'payload-in-name': [
    nameCase('markup-names', 'markup, formula and shell metacharacters in names are text', ['<img src=x onerror=alert(1)>.pdf', "=cmd|' /C calc'!A0.csv", 'x$(touch SHELL-MARKER).pdf', "x' OR '1'='1.pdf"],
      [{ ref: 'NM-1', path: '<img src=x onerror=alert(1)>.pdf' }, { ref: 'NM-2', path: "=cmd|' /C calc'!A0.csv" }, { ref: 'NM-3', path: 'x$(touch SHELL-MARKER).pdf' }, { ref: 'NM-4', path: "x' OR '1'='1.pdf" }], 'accept', [], { mapping: { 'NM-1': N('<img src=x onerror=alert(1)>.pdf'), 'NM-3': N('x$(touch SHELL-MARKER).pdf') } }),
    nameCase('scheme-like-name', 'javascript:alert(1).pdf is a plain relative name', ['javascript:alert(1).pdf'], [{ ref: 'NM-1', path: 'javascript:alert(1).pdf' }], 'accept', [], { mapping: { 'NM-1': N('javascript:alert(1).pdf') } }),
  ],
  'ref-path': [
    ...([
      ['dotdot', '../../outside/secret.txt', 'ASSET_PATH_TRAVERSAL'],
      ['inner-dotdot', 'docs/../../outside/secret.txt', 'ASSET_PATH_TRAVERSAL'],
      ['backslash-dotdot', '..\\outside\\secret.txt', 'ASSET_PATH_TRAVERSAL'],
      ['absolute', '/etc/hostname', 'ASSET_PATH_TRAVERSAL'],
      ['drive-backslash', 'C:\\Windows\\win.ini', 'ASSET_PATH_TRAVERSAL'],
      ['drive-slash', 'C:/corpus/secret.txt', 'ASSET_PATH_TRAVERSAL'],
      ['drive-relative', 'c:secret.txt', 'ASSET_PATH_TRAVERSAL'],
      ['drive-pipe', 'C|/secret.txt', 'ASSET_PATH_TRAVERSAL'],
      ['unc', '\\\\evil.example\\share\\x.pdf', 'ASSET_PATH_TRAVERSAL'],
      ['double-slash', '//evil.example/share/x.pdf', 'ASSET_PATH_TRAVERSAL'],
      ['device', '\\\\.\\COM1', 'ASSET_PATH_TRAVERSAL'],
      ['backslash', 'docs\\x.pdf', 'ASSET_PATH_INVALID'],
      ['nul-truncation', 'report.pdf\u0000/../outside/secret.txt', 'ASSET_PATH_INVALID'],
      ['dot-prefix', './report.pdf', 'ASSET_PATH_INVALID'],
      ['trailing-slash', 'docs/', 'ASSET_PATH_INVALID'],
      ['empty', '', 'ASSET_PATH_INVALID'],
      ['dot', '.', 'ASSET_PATH_INVALID'],
      ['dotdot-only', '..', 'ASSET_PATH_TRAVERSAL'],
      ['double-separator', 'a//b.pdf', 'ASSET_PATH_INVALID'],
      ['strip-bypass', '....//....//outside/secret.txt', 'ASSET_PATH_INVALID'],
      ['reserved-area', '.clearcase/x.pdf', 'ASSET_PATH_RESERVED'],
      ['reserved-area-case', '.ClearCase/x.pdf', 'ASSET_PATH_RESERVED'],
    ] as const).map(([id, p, code]) => oc(id, `asset path ${JSON.stringify(p)}`, async () => miniPackage({ docs: [{ ref: 'NM-1', path: p, bytes: SECRET }] }), 'reject', [code])),
    ...([
      ['percent-literal', '%2e%2e/outside/secret.txt'],
      ['double-percent', '%252e%252e/outside/secret.txt'],
      ['fullwidth', '\uff0e\uff0e\uff0foutside\uff0fsecret.txt'],
      ['division-slash', '..\u2215outside\u2215secret.txt'],
      ['tilde', '~/secret.txt'],
      ['env', '$HOME/secret.txt'],
      ['overlong-literal', '\u00c0\u00ae\u00c0\u00ae\u00c0\u00afoutside\u00c0\u00afsecret.txt'],
    ] as const).map(([id, p]) => oc(id, `asset path ${JSON.stringify(p)} is literal (never decoded or expanded)`, async () => miniPackage({ docs: [{ ref: 'NM-1', path: p, bytes: SECRET }] }), 'report', ['ORIG_MISSING'], { mapping: { 'NM-1': null } })),
    oc('directory-path', 'asset path names a folder', async () => miniPackage({ docs: [{ ref: 'NM-1', path: OD_DIR, bytes: SECRET }] }), 'reject', ['ORIG_NOT_FILE']),
  ],
  'active-content': [
    oc('html-in-pdf', 'HTML bytes behind a .pdf name', async (c) => {
      const b = utf8('<!DOCTYPE html><html><body><script>alert(1)</script></body></html>\n');
      await writeFile(abs(c, OD1), b);
      return reindex(c.base, 'OD-001', b);
    }, 'report', ['ORIG_MEDIA_MISMATCH'], { downloadOnly: { 'OD-001': true } }),
    oc('svg-in-jpg', 'SVG with onload behind a .jpg name', async (c) => {
      const b = utf8('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>\n');
      await writeFile(abs(c, OD4), b);
      return reindex(c.base, 'OD-004', b);
    }, 'report', ['ORIG_MEDIA_MISMATCH'], { downloadOnly: { 'OD-004': true } }),
    oc('png-in-pdf', 'PNG bytes behind a .pdf name', async (c) => {
      const b = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
      await writeFile(abs(c, OD1), b);
      return reindex(c.base, 'OD-001', b);
    }, 'report', ['ORIG_MEDIA_MISMATCH'], { downloadOnly: { 'OD-001': true } }),
    oc('pdf-html-polyglot', 'PDF header followed by HTML (a real PDF family; served as PDF, never HTML)', async (c) => {
      const b = utf8('%PDF-1.4\n<html><body><script>alert(1)</script></body></html>\n%%EOF\n');
      await writeFile(abs(c, OD1), b);
      return reindex(c.base, 'OD-001', b);
    }, 'report', [], { absent: ['ORIG_MEDIA_MISMATCH'], downloadOnly: { 'OD-001': false } }),
    oc('gif-js-polyglot', 'GIF89a/*...*/ JavaScript polyglot declared as GIF', async (c) => {
      const b = utf8('GIF89a/*\u0001\u0000\u0001\u0000*/=alert(1);//');
      await writeFile(abs(c, OD4), b);
      return reindex(c.base, 'OD-004', b, { mediaType: 'image/gif' });
    }, 'report', [], { absent: ['ORIG_MEDIA_MISMATCH'], downloadOnly: { 'OD-004': false } }),
    oc('script-in-eml', 'e-mail with an HTML script part (served as sandboxed text)', async (c) => {
      const p = EM1;
      const b = utf8('From: a@example.invalid\nContent-Type: text/html\n\n<script>alert(1)</script><img src="https://evil.example/x.png">\n');
      await writeFile(abs(c, p), b);
      return reindex(c.base, 'EM-0001', b);
    }, 'report', [], { absent: ['ORIG_MEDIA_MISMATCH'], downloadOnly: { 'EM-0001': false } }),
  ],
};

// ---- 3. package-directory and source cases ----------------------------------------------------

export interface DirCase {
  id: string;
  threat: string;
  /** receives the written package folder and a scratch root; returns the source path to import */
  setup: (pkgDir: string, root: string) => Promise<string>;
  verdict: Verdict;
  codes: Code[];
}

export const DIR_CASES: DirCase[] = [
  { id: 'symlink-unlisted', threat: 'unlisted symlink inside the package folder', setup: async (d) => { await symlink('/etc/hostname', path.join(d, 'datasets', 'evil.json')); return d; }, verdict: 'reject', codes: ['PKG_SYMLINK'] },
  { id: 'symlink-listed', threat: 'a listed dataset is a link to an outside copy', setup: async (d, root) => {
    const f = path.join(d, 'datasets', 'witnesses.json');
    await cp(f, path.join(root, 'witnesses-copy.json'));
    await rm(f);
    await symlink(path.join(root, 'witnesses-copy.json'), f);
    return d;
  }, verdict: 'reject', codes: ['PKG_SYMLINK', 'PKG_FILE_MISSING'] },
  { id: 'symlink-dir', threat: 'the datasets folder is a link to an outside copy', setup: async (d, root) => {
    await cp(path.join(d, 'datasets'), path.join(root, 'datasets-copy'), { recursive: true });
    await rm(path.join(d, 'datasets'), { recursive: true });
    await symlink(path.join(root, 'datasets-copy'), path.join(d, 'datasets'));
    return d;
  }, verdict: 'reject', codes: ['PKG_SYMLINK', 'PKG_FILE_MISSING'] },
  { id: 'fifo', threat: 'FIFO inside the package folder (never opened)', setup: async (d) => { mkfifo(path.join(d, 'datasets', 'pipe.json')); return d; }, verdict: 'reject', codes: ['PKG_SPECIAL_FILE'] },
  { id: 'source-is-link', threat: 'the selected package folder is a symlink', setup: async (d, root) => { await symlink(d, path.join(root, 'pkg-link')); return path.join(root, 'pkg-link'); }, verdict: 'reject', codes: ['PKG_SOURCE_INVALID'] },
  { id: 'source-missing', threat: 'the selected package does not exist', setup: async (_d, root) => path.join(root, 'nothing-here'), verdict: 'reject', codes: ['PKG_SOURCE_INVALID'] },
  { id: 'source-fifo', threat: 'the selected package is a FIFO', setup: async (_d, root) => { mkfifo(path.join(root, 'pkg.fifo')); return path.join(root, 'pkg.fifo'); }, verdict: 'reject', codes: ['PKG_SOURCE_INVALID'] },
];

// ---- 4. zip transport cases -------------------------------------------------------------------

export interface ZipCase {
  id: string;
  category: string;
  threat: string;
  /** archive bytes built from the valid package */
  bytes: (files: Files) => Uint8Array;
  verdict: Verdict;
  codes: Code[];
  limits?: Partial<Limits>;
  subject?: string;
}

const zipWith = (extra: ZipEntrySpec[] = [], o: ZipOptions = {}, map?: (e: ZipEntrySpec[]) => ZipEntrySpec[]) => (files: Files) => {
  const base = packageEntries(files);
  return writeZip([...(map ? map(base) : base), ...extra], o);
};
const evil = (name: string | Uint8Array, extra: Partial<ZipEntrySpec> = {}): ZipEntrySpec => ({ name, data: SECRET, ...extra });
const zc = (category: string, id: string, threat: string, bytes: ZipCase['bytes'], verdict: Verdict, codes: Code[], extra: Partial<ZipCase> = {}): ZipCase => ({ id, category, threat, bytes, verdict, codes, ...extra });
const MiB = 1024 * 1024;
const withManifest = (files: Files, patch: Partial<ZipEntrySpec>) => zipWith([], {}, (e) => e.map((x) => (x.name === 'manifest.json' ? { ...x, ...patch } : x)))(files);

export const ZIP_CASES: ZipCase[] = [
  zc('control', 'valid-package-zip', 'the valid package as a deflated zip', zipWith(), 'report', []),
  zc('control', 'stored-package-zip', 'the valid package as a stored zip', (f) => writeZip(packageEntries(f, 0)), 'report', []),
  zc('zip-slip', 'dotdot', 'entry ../../zip-slip.txt', zipWith([evil('../../zip-slip.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-slip', 'inner-dotdot', 'entry datasets/../../x', zipWith([evil('datasets/../../x.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-slip', 'absolute', 'entry /tmp/abs.txt', zipWith([evil('/tmp/zip-abs.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-slip', 'backslash-dotdot', 'entry ..\\..\\x', zipWith([evil('..\\..\\zip-slip.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-slip', 'drive', 'entry C:/x', zipWith([evil('C:/zip-slip.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-slip', 'drive-backslash', 'entry C:\\x', zipWith([evil('C:\\zip-slip.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-slip', 'unc', 'entry \\\\server\\share\\x', zipWith([evil('\\\\evil.example\\share\\x.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-slip', 'nul', 'entry with NUL before ../', zipWith([evil('ok.txt\u0000/../../x.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-slip', 'percent-literal', 'entry %2e%2e/x is a literal name (unlisted, never decoded)', zipWith([evil('%2e%2e/zip-slip.txt')]), 'report', ['PKG_UNLISTED_FILE'], { subject: '%2e%2e/zip-slip.txt' }),
  zc('zip-slip', 'overlong-cp437', 'flagless overlong ..<C0 AF>x decodes as CP437, no separator', zipWith([evil(Uint8Array.from([0x2e, 0x2e, 0xc0, 0xaf, 0x78]), { flags: 0 })]), 'report', ['PKG_UNLISTED_FILE'], { subject: '..└»x' }),
  zc('zip-symlink-entry', 'symlink-unlisted', 'unix symlink entry to /etc/hostname', zipWith([evil('link', { data: utf8('/etc/hostname'), mode: 0o120777 })]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-symlink-entry', 'symlink-as-listed', 'a listed dataset stored as a symlink entry', zipWith([], {}, (e) => e.map((x) => (x.name === 'datasets/witnesses.json' ? { ...x, mode: 0o120777 } : x))), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-symlink-entry', 'symlink-osx-host', 'symlink mode with the OS X host byte', zipWith([evil('link', { host: 19, mode: 0o120755 })]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-symlink-entry', 'fifo-entry', 'unix FIFO entry', zipWith([evil('pipe', { mode: 0o010644 })]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-symlink-entry', 'device-entry', 'unix character-device entry', zipWith([evil('dev', { mode: 0o020644 })]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-duplicate-entry', 'duplicate-manifest', 'manifest.json twice (second differs)', zipWith([{ name: 'manifest.json', data: utf8('{}') }]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-duplicate-entry', 'duplicate-dataset', 'a dataset twice', (f) => writeZip([...packageEntries(f), { name: 'datasets/witnesses.json', data: f.get('datasets/witnesses.json')!, method: 8 }]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-duplicate-entry', 'case-collision', 'Manifest.json next to manifest.json', zipWith([{ name: 'Manifest.json', data: utf8('{}') }]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-duplicate-entry', 'nfc-nfd-collision', 'NFC and NFD spellings of one name', zipWith([evil('notes/café.txt'), evil('notes/cafe\u0301.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-duplicate-entry', 'file-folder-clash', 'datasets/witnesses.json is also a folder', zipWith([evil('datasets/witnesses.json/x.txt')]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-duplicate-entry', 'file-and-dir-entry', 'notes as a file and as a folder entry', zipWith([evil('notes'), { name: 'notes/' }]), 'reject', ['ARC_ENTRY_INVALID']),
  zc('zip-malformed', 'truncated', 'archive cut before the end record', (f) => zipWith([], { truncate: 30 })(f), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'cd-beyond-eof', 'central directory offset beyond the end', zipWith([], { cdOffset: 0x7fffff00 }), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'too-small', '10 bytes', () => utf8('PK\u0003\u0004short'), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'not-a-zip', 'random bytes with a .zip name', () => utf8('not a zip archive at all, just synthetic text\n'.repeat(4)), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'no-eocd', 'no end-of-central-directory record', zipWith([], { noEocd: true }), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'count-overstated', 'end record claims more entries than exist', (f) => zipWith([], { count: f.size + 5 })(f), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'crc-mismatch', 'manifest CRC-32 wrong', (f) => withManifest(f, { crc: 0x12345678 }), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'size-overstated', 'manifest declares more bytes than it holds', (f) => withManifest(f, { uncompressedSize: f.get('manifest.json')!.byteLength + 10 }), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'corrupt-deflate', 'deflate stream is garbage', (f) => withManifest(f, { compressed: utf8('\u00ff\u00ff garbage deflate'), method: 8 }), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'bad-local-header', 'central directory points at a non-header offset', (f) => withManifest(f, { localOffset: 1 }), 'reject', ['ARC_MALFORMED']),
  zc('zip-malformed', 'multi-disk', 'end record names another disk', zipWith([], { disk: 1, cdDisk: 1 }), 'reject', ['ARC_UNSUPPORTED']),
  zc('zip-malformed', 'zip64-marker', 'entry count 0xFFFF (zip64)', zipWith([], { count: 0xffff }), 'reject', ['ARC_UNSUPPORTED']),
  zc('zip-malformed', 'encrypted', 'encrypted entry flag', (f) => withManifest(f, { flags: 0x1 }), 'reject', ['ARC_UNSUPPORTED']),
  zc('zip-malformed', 'method-bzip2', 'compression method 12', zipWith([evil('x.bin', { method: 12 })]), 'reject', ['ARC_UNSUPPORTED']),
  zc('zip-malformed', 'method-aes', 'compression method 99 (AES)', zipWith([evil('x.bin', { method: 99 })]), 'reject', ['ARC_UNSUPPORTED']),
  zc('zip-malformed', 'entry-disk', 'entry starts on another disk', zipWith([evil('x.txt', { diskStart: 2 })]), 'reject', ['ARC_UNSUPPORTED']),
  zc('zip-name-encoding', 'utf8-flag-invalid', 'UTF-8 flag set, name bytes invalid', zipWith([evil(Uint8Array.from([0x6e, 0xff, 0xfe]), { flags: 0x800 })]), 'reject', ['ARC_MALFORMED']),
  zc('zip-name-encoding', 'cp437-flagless', 'flagless CP437 name (decoded as CP437, unlisted)', zipWith([evil(Uint8Array.from([0x63, 0x61, 0x66, 0x82, 0x2e, 0x74, 0x78, 0x74]), { flags: 0 })]), 'report', ['PKG_UNLISTED_FILE'], { subject: 'café.txt' }),
  zc('zip-name-encoding', 'utf8-flagless', 'flagless but valid UTF-8 name (decoded as UTF-8)', zipWith([evil(utf8('naïve.txt'), { flags: 0 })]), 'report', ['PKG_UNLISTED_FILE'], { subject: 'naïve.txt' }),
  zc('zip-name-encoding', 'name-too-long', 'entry name above 1,024 bytes', zipWith([evil('n'.repeat(1100))]), 'reject', ['ARC_LIMIT']),
  zc('zip-bomb', 'ratio', '2 MiB of zeros deflated (about 1000:1)', zipWith([evil('bomb.bin', { data: new Uint8Array(2 * MiB), method: 8 })]), 'reject', ['ARC_LIMIT']),
  zc('zip-bomb', 'declared-entry-size', 'entry declares 65 MiB', zipWith([evil('big.bin', { uncompressedSize: 65 * MiB, compressedSize: 65 * MiB })]), 'reject', ['ARC_LIMIT']),
  zc('zip-bomb', 'understated-size', 'manifest declares 10 bytes but expands further (bounded by the declared size)', (f) => withManifest(f, { uncompressedSize: 10 }), 'reject', ['ARC_LIMIT']),
  zc('zip-bomb', 'total-bound', 'archive expands beyond the total bound', zipWith(), 'reject', ['ARC_LIMIT'], { limits: { archiveTotalBytes: 4096 } }),
  zc('zip-bomb', 'entry-count', 'more entries than the bound', zipWith(), 'reject', ['ARC_LIMIT'], { limits: { archiveEntries: 3 } }),
  zc('zip-bomb', 'nested-zip', 'a zip inside the zip is never opened (unlisted)', (f) => zipWith([evil('inner.zip', { data: writeZip([evil('../../x.txt')]) })])(f), 'report', ['PKG_UNLISTED_FILE'], { subject: 'inner.zip' }),
];

// ---- 5. pure-function tables ------------------------------------------------------------------

/** classifyLink: raw value -> kind (and scheme when it matters). */
export const LINK_TABLE: [string, 'package' | 'external' | 'text-only' | 'name' | 'rejected', string?][] = [
  ['javascript:alert(1)', 'rejected', 'javascript'],
  ['JaVaScRiPt:alert(1)', 'rejected', 'javascript'],
  ['   javascript:alert(1)', 'rejected', 'javascript'],
  ['\u0001javascript:alert(1)', 'rejected', 'javascript'],
  ['\u0000\u001f javascript:alert(1)', 'rejected', 'javascript'],
  ['java\tscript:alert(1)', 'rejected', 'javascript'],
  ['java\nscript:alert(1)', 'rejected', 'javascript'],
  ['java\rscript:alert(1)', 'rejected', 'javascript'],
  ['javascript:alert(1)\u0000', 'rejected', 'javascript'],
  ['java&#10;script:alert(1)', 'name'],
  ['javascript&colon;alert(1)', 'name'],
  ['javascript&#58alert(1)', 'name'],
  ['&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)', 'name'],
  ['javascript%3Aalert(1)', 'name'],
  ['javascript\uff1aalert(1)', 'name'],
  ['data:text/html;base64,PGgxPmhpPC9oMT4=', 'rejected', 'data'],
  ['  DATA:text/html,<script>alert(1)</script>', 'rejected', 'data'],
  ['data:image/svg+xml,%3Csvg%20onload%3Dalert(1)%3E', 'rejected', 'data'],
  ['vbscript:msgbox(1)', 'rejected', 'vbscript'],
  ['file:///etc/passwd', 'rejected', 'file'],
  ['FILE:///corpus/x.txt', 'rejected', 'file'],
  ['file://evil.example/share/x.pdf', 'rejected', 'file'],
  ['blob:https://evil.example/uuid', 'rejected', 'blob'],
  ['about:srcdoc', 'rejected', 'about'],
  ['intent://x#Intent;scheme=javascript;end', 'rejected', 'intent'],
  ['ftp://evil.example/x', 'rejected', 'ftp'],
  ['ws://evil.example/x', 'rejected', 'ws'],
  ['view-source:https://example.com', 'rejected', 'view-source'],
  ['//evil.example/x', 'rejected'],
  ['\\\\evil.example\\share\\x', 'rejected'],
  ['/\\evil.example', 'rejected'],
  ['\\/evil.example', 'rejected'],
  ['/etc/passwd', 'rejected'],
  ['\\etc\\passwd', 'rejected'],
  ['C:\\Windows\\win.ini', 'rejected', 'c'],
  ['c:secret.txt', 'rejected', 'c'],
  ['C|/x.pdf', 'rejected'],
  ['../x.pdf', 'rejected'],
  ['docs/../../x.pdf', 'rejected'],
  ['..\\x.pdf', 'rejected'],
  ['./..%2F..%2Fetc%2Fpasswd', 'rejected'],
  ['./%2e%2e/x.pdf', 'rejected'],
  ['./a%5Cb.pdf', 'rejected'],
  ['./bad%ZZ.pdf', 'rejected'],
  ['https://user:pass@evil.example/', 'rejected', 'https'],
  ['https://example.com@evil.example/', 'rejected', 'https'],
  ['https://', 'rejected', 'https'],
  ['https://example.com/' + 'a'.repeat(2100), 'rejected'],
  ['https://example.com/a', 'external', 'https'],
  ['HTTPS://EXAMPLE.COM/A', 'external', 'https'],
  ['https:evil.example/x', 'external', 'https'],
  ['https://xn--exmple-cua.example/', 'external', 'https'],
  ['mailto:counsel@example.invalid', 'external', 'mailto'],
  ['http://example.com/', 'text-only', 'http'],
  ['http://2130706433/', 'text-only', 'http'],
  ['http://[::1]:8080/', 'text-only', 'http'],
  ['tel:+15550100', 'text-only', 'tel'],
  ['ref:R-404', 'text-only', 'ref'],
  ['localhost:8080/admin', 'text-only', 'localhost'],
  ['./FOLDER%20A/OD-001%20Synthetic.pdf', 'package'],
  ['./FOLDER%20A/', 'package'],
  ['originals/syn-001.txt', 'name'],
  ['originals/%2e%2e/%2e%2e/etc/passwd', 'name'],
];

/** Rendering: every payload must render with only the allowed elements. */
export const RENDER_PAYLOADS: string[] = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '</style><script>alert(1)</script>',
  '</script><script>alert(1)</script>',
  '{{7*7}} ${alert(1)} {{constructor.constructor("alert(1)")()}}',
  '&lt;script&gt;alert(1)&lt;/script&gt;',
  '%3Cscript%3Ealert(1)%3C/script%3E',
  '<scr\u0000ipt>alert(1)</scr\u0000ipt>',
  '<scr<script>ipt>alert(1)</script>',
  '<img src=x onerror=alert(1)',
  '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
  '<!-- x --><img src=x onerror=alert(1)>',
  '<div style="width:expression(alert(1))">x</div>',
  '![t](x "onerror=alert(1)")',
  'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  '[x](javascript:alert(1))',
  '[x](JaVaScRiPt:alert(1))',
  '<javascript:alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '[x](https://example.com "onmouseover=alert(1)")',
  '[click](https://example.com)',
  'https://evil.example/plain',
  '" onmouseover="alert(1)',
  "' onfocus='alert(1)",
  'invoice\u202Efdp.exe',
  'a\u2066b\u200fc\u2069d',
  'zero\u200bwidth \ufeffbom',
  'line\nbreak\r\nCRLF\rCR',
  'para one\n\n\n\npara two',
  '[[OD-001]] [[OD-001#p3]] [[XX-999]] [[od-001]] [[]] [[OD-001#p0]] [[ OD-001 ]]',
  '[[OD-001]]<script>alert(1)</script>[[XX-9]]',
  '[[<img src=x onerror=alert(1)>]]',
  '[[OD-001"onmouseover="alert(1)]]',
  '\u0000\u0001\u0008\u000b\u000c\u001b[31m\u007f\u0085',
  'ok &amp; &#x3c; &#60;',
];

/** Exact safe output for a few representative inputs (resolver: known refs OD-001/OD-002). */
export const RENDER_EXACT: [string, string][] = [
  ['<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
  ['" onmouseover="x', '<p>&quot; onmouseover=&quot;x</p>'],
  ["it's", '<p>it&#39;s</p>'],
  ['&lt;b&gt;', '<p>&amp;lt;b&amp;gt;</p>'],
  ['See [[OD-001]].', '<p>See <a class="cite" href="/v/sha256%3Aabc/doc/OD-001">OD-001</a>.</p>'],
  ['[[OD-002#p3]]', '<p><a class="cite" href="/v/sha256%3Aabc/doc/OD-002?page=3">OD-002 p.3</a></p>'],
  ['[[XX-9]]', '<p><span class="cite-broken" title="Citation does not resolve">[[XX-9]]</span></p>'],
  ['[[od-001]]', '<p>[[od-001]]</p>'],
  ['[x](javascript:alert(1))', '<p>[x](javascript:alert(1))</p>'],
  ['a\u202eb', '<p>a⟨U+202E⟩b</p>'],
  ['a\u0000b', '<p>a⟨U+0000⟩b</p>'],
  ['x\ny', '<p>x<br>y</p>'],
  ['x\r\ny', '<p>x<br>y</p>'],
  ['x\n\ny', '<p>x</p><p>y</p>'],
  ['{{7*7}}', '<p>{{7*7}}</p>'],
  ['', ''],
];

/** Hostile resolver results: each must render as a broken citation, never as a link. */
export const HOSTILE_HREFS: unknown[] = [
  'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', '//evil.example/x', 'https://evil.example/', 'http://evil.example/',
  '/v/../etc/passwd', '/v/%2e%2e/x', '/v/%2E%2e/x', '/v/./x', '/a b', '/x"onmouseover="y', '/x<y', '/x\\y', ' /x', '/x\n', '/x%00',
  '/x%5c..', '/%2F%2Fevil.example', 'x', '', 42, null, undefined, {}, '/' + 'a'.repeat(2100),
];

/** checkRelPath: path -> ok, traversal. */
export const PATH_TABLE: [unknown, boolean, boolean?][] = [
  ['FOLDER A/OD-001 Synthetic.pdf', true],
  ['a/b/c.pdf', true],
  ['%2e%2e/x', true],
  ['..\u2215x', true],
  ['CON.pdf', true],
  ['AUX.', true],
  ['memo.pdf ', true],
  ['x\u202efdp.exe', true],
  ['../x', false, true],
  ['a/../../x', false, true],
  ['..', false, true],
  ['/etc/passwd', false, true],
  ['\\x', false, true],
  ['C:/x', false, true],
  ['c:x', false, true],
  ['C|x', false, true],
  ['a\\..\\x', false, true],
  ['a\\b', false, false],
  ['./x', false, false],
  ['a//b', false, false],
  ['a/', false, false],
  ['', false, false],
  ['x\u0000y', false, false],
  ['x\ny', false, false],
  ['x\u0085y', false, false],
  ['x\ud800y', false, false],
  [42, false, false],
  ['A'.repeat(255), true],
  ['A'.repeat(256), false, false],
  ['é'.repeat(128), false, false],
  ['a/'.repeat(31) + 'x', true],
  ['a/'.repeat(32) + 'x', false, false],
  [('d'.repeat(100) + '/').repeat(11) + 'x', false, false],
];

/** parseStrictJson over raw text: expected error code, or null with the parsed value. */
export const JSON_TABLE: [string, string, string | null, unknown?][] = [
  ['nan', '{"a": NaN}', 'JSON_MALFORMED'],
  ['infinity', '[Infinity]', 'JSON_MALFORMED'],
  ['trailing comma', '[1,]', 'JSON_MALFORMED'],
  ['comment', '/* x */ 1', 'JSON_MALFORMED'],
  ['single quotes', "{'a': 1}", 'JSON_MALFORMED'],
  ['empty', '', 'JSON_MALFORMED'],
  ['bad escape', '"\\x41"', 'JSON_MALFORMED'],
  ['lone high', '"\\ud800"', 'JSON_MALFORMED'],
  ['lone low key', '{"\\udc00": 1}', 'JSON_MALFORMED'],
  ['raw lone surrogate', '"\ud800"', 'JSON_MALFORMED'],
  ['raw control', '"a\u0001b"', 'JSON_MALFORMED'],
  ['dup key', '{"a": 1, "a": 2}', 'JSON_DUPLICATE_KEY'],
  ['dup key escaped', '{"a": 1, "\\u0061": 2}', 'JSON_DUPLICATE_KEY'],
  ['dup key nested', '{"x": {"b": 1, "b": 1}}', 'JSON_DUPLICATE_KEY'],
  ['2^53+1', '9007199254740993', 'JSON_LIMIT'],
  ['-2^53-1', '-9007199254740993', 'JSON_LIMIT'],
  ['1e400', '1e400', 'JSON_LIMIT'],
  ['depth 33', '['.repeat(33) + ']'.repeat(33), 'JSON_LIMIT'],
  ['depth 200000', '['.repeat(200000), 'JSON_LIMIT'],
  ['depth 32', '['.repeat(32) + ']'.repeat(32), null],
  ['2^53-1', '9007199254740991', null, 9007199254740991],
  ['1e-400', '1e-400', null, 0],
  ['-0', '-0', null, -0],
  ['pair', '"\\ud83d\\ude00"', null, '\u{1F600}'],
  ['nul escape', '"a\\u0000b"', null, 'a\u0000b'],
  ['NaN string', '"NaN"', null, 'NaN'],
  ['case keys', '{"id": 1, "ID": 2}', null, { id: 1, ID: 2 }],
];

/** Raw bytes for decodeUtf8Strict: expected to fail with JSON_BAD_UTF8. */
export const BAD_UTF8: [string, number[]][] = [
  ['bom', [0xef, 0xbb, 0xbf, 0x31]],
  ['cesu', [0x22, 0xed, 0xa0, 0x80, 0x22]],
  ['latin1', [0x22, 0xe9, 0x22]],
  ['overlong slash', [0x22, 0xc0, 0xaf, 0x22]],
  ['overlong 3-byte', [0x22, 0xe0, 0x80, 0xaf, 0x22]],
  ['above U+10FFFF', [0x22, 0xf4, 0x90, 0x80, 0x80, 0x22]],
  ['F5', [0x22, 0xf5, 0x80, 0x80, 0x80, 0x22]],
  ['FF FE', [0xff, 0xfe, 0x31, 0x00]],
  ['truncated', [0x22, 0xe2, 0x82]],
];

/** servePolicy: media type, filename, mismatch -> mode and Content-Type. */
export const SERVE_TABLE: [string, string, boolean, 'inline-isolated' | 'text-sandboxed' | 'download', string][] = [
  ['text/html', '01-script-tag.html', false, 'text-sandboxed', 'text/plain; charset=utf-8'],
  ['text/html', 'invoice.pdf.html', false, 'text-sandboxed', 'text/plain; charset=utf-8'],
  ['image/svg+xml', '01-onload.svg', false, 'download', 'application/octet-stream'],
  ['application/pdf', '01-openaction-javascript.pdf', false, 'inline-isolated', 'application/pdf'],
  ['application/pdf', '01-png-bytes-named-pdf.pdf', true, 'download', 'application/octet-stream'],
  ['image/gif', '01-gif-js.gif', false, 'inline-isolated', 'image/gif'],
  ['image/jpeg', 'photo.jpg', true, 'download', 'application/octet-stream'],
  ['application/octet-stream', '02-gif-js-as-js.js', false, 'download', 'application/octet-stream'],
  ['text/plain', '01-html-content-in-txt.txt', false, 'text-sandboxed', 'text/plain; charset=utf-8'],
  ['text/csv', '01-formula-injection.csv', false, 'text-sandboxed', 'text/plain; charset=utf-8'],
  ['message/rfc822', '01-html-script-remote-image.eml', false, 'text-sandboxed', 'text/plain; charset=utf-8'],
  ['application/xml', '01-xxe-file-entity.xml', false, 'download', 'application/octet-stream'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '01-docx-remote-template.docx', false, 'download', 'application/octet-stream'],
  ['application/zip', 'bomb.zip', false, 'download', 'application/octet-stream'],
  ['text/javascript', 'x.js', false, 'download', 'application/octet-stream'],
  ['application/x-unknown', 'x.bin', false, 'download', 'application/octet-stream'],
];

/** contentContradictsType: declared media type + leading bytes -> contradiction. */
export const SNIFF_TABLE: [string, string, string | number[], boolean][] = [
  ['html in pdf', 'application/pdf', '<!DOCTYPE html><script>alert(1)</script>', true],
  ['script in jpg', 'image/jpeg', '<script>alert(1)</script>', true],
  ['svg in png', 'image/png', '<svg onload=alert(1)>', true],
  ['svg via xml prolog in gif', 'image/gif', '<?xml version="1.0"?>\n<svg onload="alert(1)"/>', true],
  ['png in pdf', 'application/pdf', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a], true],
  ['unknown bytes in pdf', 'application/pdf', 'just text', true],
  ['pdf with junk prefix', 'application/pdf', 'junk%PDF-1.4\n', false],
  ['pdf-html polyglot', 'application/pdf', '%PDF-1.4\n<html><script>alert(1)</script>', false],
  ['gif-js polyglot', 'image/gif', 'GIF89a/*xx*/=alert(1)', false],
  ['html in txt (served as text)', 'text/plain', '<html><script>alert(1)</script>', false],
  ['html in html', 'text/html', '<html><script>alert(1)</script>', false],
  ['html in eml', 'message/rfc822', '<script>alert(1)</script>', false],
  ['bom then html in pdf', 'application/pdf', '\ufeff<html>', true],
  ['zip in docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', [0x50, 0x4b, 0x03, 0x04], false],
  ['pdf in docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '%PDF-1.4', true],
  ['empty pdf', 'application/pdf', '', false],
];

/** exportCell: user-entered cell -> exported cell. */
export const EXPORT_TABLE: [string, string][] = [
  ['=1+1', "'=1+1"],
  ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
  ['=HYPERLINK("https://evil.example","x")', '\'=HYPERLINK("https://evil.example","x")'],
  ['+SUM(1,1)', "'+SUM(1,1)"],
  ['-2+3', "'-2+3"],
  ['@SUM(1+1)', "'@SUM(1+1)"],
  ['\t=1+1', "'\t=1+1"],
  ['\r=1+1', "'\r=1+1"],
  ['plain text', 'plain text'],
  ['1150.00', '1150.00'],
  ['', ''],
];

// ---- 6. render safety check -------------------------------------------------------------------

const ALLOWED_TAG = /^<(?:p|\/p|br|\/a|\/span|span class="cite-broken" title="Citation does not resolve"|a class="cite" href="([^"<>]*)")>$/;
const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Problems in renderNarrative output: any element other than p, br, a.cite and span.cite-broken, any on* attribute, any unsafe href, any raw markup character in text. */
export function htmlProblems(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<[^>]*>?/g)) {
    const tag = m[0];
    const a = ALLOWED_TAG.exec(tag);
    if (!a) { out.push(`tag not allowed: ${tag.slice(0, 80)}`); continue; }
    if (/\son[a-z]+\s*=/i.test(tag)) out.push(`event handler: ${tag}`);
    if (a[1] !== undefined && !isSafeAppHref(unescape(a[1]))) out.push(`unsafe href: ${a[1]}`);
  }
  const textOnly = html.replace(/<[^>]*>/g, '');
  if (/[<>"']/.test(textOnly)) out.push('raw markup character in text');
  if (/&(?!(?:amp|lt|gt|quot|#39);)/.test(textOnly)) out.push('bare ampersand in text');
  return out;
}

export { canonicalBytes };
