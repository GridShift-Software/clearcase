// CC-09-r2 regressions on existing pure rules (synthetic data; this file loads at 2e7dd60 and fails there on its
// assertions): the Word index's XML text with control characters (D11, parsed strictly by expat) and the cover's
// C/O after a partial mark (D15).
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { unzip } from '../../scripts/parity/lib/exports.mjs';
import { bundlesOf, header, headerRaw } from '../../src/lib/views/bundles/court';
import { coverCo, coverDoc, fileCo, type Caption, type CO, type ScheduleFile, type ScheduleItem } from '../../src/lib/views/bundles/discovery';
import { indexDocx } from '../../src/lib/views/bundles/docx';

/** Parse with expat (Python's strict XML parser); returns its error or null. */
const strict = (xml: string): string | null => {
	const r = spawnSync('python3', ['-I', '-c', 'import sys, xml.dom.minidom\ntry:\n xml.dom.minidom.parseString(sys.stdin.buffer.read())\nexcept Exception as e:\n print(e); sys.exit(1)'], { input: Buffer.from(xml, 'utf8') });
	return r.status === 0 ? null : r.stdout.toString().trim() || 'parse failed';
};
const parts = (bytes: Uint8Array) => { const z = unzip(bytes); const d = (n: string) => new TextDecoder().decode(z.get(n)!); return { doc: d('word/document.xml'), core: d('docProps/core.xml') }; };

describe('D11: the Word index is well-formed XML whatever the header or an imported row holds', () => {
	const BAD = { VT: '\u000b', FF: '\u000c', NUL: '\u0000', STX: '\u0002', FFFE: '\ufffe', lone: '\ud83e' };
	const bundle = (desc: string) => bundlesOf({ list: [{ no: '1', name: `Synthetic ${desc}`, title: `Synthetic bundle ${desc}`, rows: [{ n: 1, desc: `Synthetic row${desc}text`, date: '', pages: 1, from: 1, to: 1 }] }] })[0]!;
	it.each(Object.entries(BAD))('%s in a header field, a description and the title parses strictly; tab and line ends are kept', (_, c) => {
		const h = header(headerRaw({ claimant: `Synthetic party${c}second line`, court: `Court${c}`, intro: `In${c}between`, caseNo: `1${c}2` }, null)).h;
		const { doc, core } = parts(indexDocx([bundle(c)], h, `creator${c}`));
		expect(strict(doc)).toBeNull();
		expect(strict(core)).toBeNull();
		expect(doc).toContain('Synthetic party');
		expect(doc).toContain('SYNTHETIC ROW');
	});
	it('a vertical tab or form feed in a multi-line header field starts a new line; elsewhere it is a space', () => {
		const h = header(headerRaw({ claimant: 'Synthetic party\u000bsecond line', intro: 'In\u000cbetween' }, null)).h;
		const { doc } = parts(indexDocx([bundle('')], h, 'c'));
		expect(doc).toMatch(/>Synthetic party<\/w:t>.*>second line<\/w:t>/);
		expect(doc).toContain('>In between</w:t>');
	});
	it('the stored header stays as typed (the writer only cleans what it emits)', () => {
		expect(headerRaw({}, { claimant: 'A\u000bB' }).claimant).toBe('A\u000bB');
	});
});

describe('D15: a partial Copy/Original mark never turns an Original item into C&O', () => {
	const file = (fn: string, co = ''): ScheduleFile => ({ fn, url: `./F/${fn}`, co, x: null, key: `F/${fn}`, ref: null });
	const orig: ScheduleItem = { no: 1, date: '', co: 'O', desc: 'Synthetic original item', nfiles: 2, files: [file('one.pdf'), file('two.pdf')] };
	const cap = { court: null, division: null, caseNumber: null, plaintiff: null, plaintiffCitation: null, plaintiffRole: null, defendant: null, defendantCitation: null, defendantRole: null, bundleIndexName: null } satisfies Caption;
	it('marking one file O keeps the cover O; marking it C makes it C&O; the chips keep v5 default C', () => {
		const m = (k: string, v: CO) => new Map<string, CO>([[`F/${k}`, v]]);
		expect(coverCo(orig, new Map())).toBe('O');
		expect(coverCo(orig, m('one.pdf', 'O'))).toBe('O');
		expect(coverCo(orig, m('one.pdf', 'C'))).toBe('C&O');
		expect(fileCo(orig.files[1]!, m('one.pdf', 'O'))).toBe('C');
		expect(coverDoc(cap, { deed: null, schedule: null, file: null, label: null }, [orig], m('one.pdf', 'O'))).toContain('<td class="co">O</td>');
	});
	it('a file with its own co still counts as that co', () => {
		const it2: ScheduleItem = { ...orig, files: [file('one.pdf'), file('two.pdf', 'C')] };
		expect(coverCo(it2, new Map<string, CO>([['F/one.pdf', 'O']]))).toBe('C&O');
	});
});
