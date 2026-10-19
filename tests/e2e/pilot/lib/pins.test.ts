// The v5 stack lane's exact-pin rule and its one narrow exception: SheetJS publishes xlsx only from its own CDN, so
// `xlsx` alone may be pinned by the official tarball URL for one version, and bun.lock must hold GRS-97's recorded sha512
// (docs/acceptance/viewers/handoff.md). Every other URL, host, name, version mismatch or range stays refused.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { XLSX_SHA512, unpinned, xlsxLockProblems } from './pins.mjs';

const OFFICIAL = 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz';
describe('exact dependency pins', () => {
	test('exact versions pass; ranges, tags and specifiers are listed', () => {
		expect(unpinned({ a: '1.2.3', b: '10.0.1' })).toEqual([]);
		expect(unpinned({ a: '^1.2.3', b: 'latest', c: '1.2', d: '~1.2.3', e: '1.2.3-beta', f: 'file:../x', g: '*' }).map(([n]) => n)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
	});
	test('xlsx pinned by the official SheetJS tarball for one version passes', () => {
		expect(unpinned({ xlsx: OFFICIAL, 'xlsx-other': '1.0.0' })).toEqual([]);
		expect(unpinned({ xlsx: 'https://cdn.sheetjs.com/xlsx-0.21.0/xlsx-0.21.0.tgz' })).toEqual([]);
	});
	test.each([
		['a non-SheetJS host', 'https://evil.example/xlsx-0.20.3/xlsx-0.20.3.tgz'],
		['a look-alike host', 'https://cdn.sheetjs.com.evil.example/xlsx-0.20.3/xlsx-0.20.3.tgz'],
		['a userinfo host', 'https://cdn.sheetjs.com@evil.example/xlsx-0.20.3/xlsx-0.20.3.tgz'],
		['plain http', 'http://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz'],
		['mismatched versions', 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.2.tgz'],
		['a query string', `${OFFICIAL}?token=1`],
		['a fragment', `${OFFICIAL}#x`],
		['an extra path segment', 'https://cdn.sheetjs.com/x/xlsx-0.20.3/xlsx-0.20.3.tgz'],
		['a file: path', 'file:../xlsx-0.20.3.tgz'],
		['a git source', 'github:SheetJS/sheetjs'],
		['a range', '^0.20.3'],
	])('xlsx named by %s is refused', (_, value) => {
		expect(unpinned({ xlsx: value }).map(([n]) => n)).toEqual(['xlsx']);
	});
	test('the SheetJS URL is accepted for xlsx only', () => {
		expect(unpinned({ 'not-xlsx': OFFICIAL, xlsxx: OFFICIAL }).map(([n]) => n)).toEqual(['not-xlsx', 'xlsxx']);
	});
});
describe('the xlsx integrity in bun.lock', () => {
	const pj = { dependencies: { xlsx: OFFICIAL } };
	const lock = (hash: string) => `{ "packages": { "xlsx": ["xlsx@${OFFICIAL}", {}, "${hash}"] } }`;
	test('holds when bun.lock records the tarball with the recorded sha512', () => {
		expect(xlsxLockProblems(pj, lock(XLSX_SHA512))).toEqual([]);
	});
	test('fails for a different hash, a missing entry, a different URL, or an absent lockfile', () => {
		expect(xlsxLockProblems(pj, lock('sha512-AAAA'))).toHaveLength(1);
		expect(xlsxLockProblems(pj, '{ "packages": {} }')).toHaveLength(1);
		expect(xlsxLockProblems(pj, lock(XLSX_SHA512).replace('xlsx-0.20.3.tgz"', 'xlsx-0.20.4.tgz"'))).toHaveLength(1);
		expect(xlsxLockProblems(pj, null)).toHaveLength(1);
	});
	test('the repository\'s own package.json and bun.lock satisfy it', () => {
		const pj = JSON.parse(readFileSync('package.json', 'utf8'));
		expect(unpinned({ ...pj.dependencies, ...pj.devDependencies })).toEqual([]);
		expect(xlsxLockProblems(pj, readFileSync('bun.lock', 'utf8'))).toEqual([]);
		expect(pj.devDependencies.xlsx).toBe(OFFICIAL);
	});
	test('says nothing when xlsx is not a dependency', () => {
		expect(xlsxLockProblems({ dependencies: {} }, '{}')).toEqual([]);
	});
});
