// Synthetic cases of the browser suite, all built through GRS-10's real converter (lib/fixtures.ts). Nothing here
// comes from a case. CANARY_PORT must be set before this module is imported (the hostile beacons embed it).
import { rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { buildCase, hostileOriginals, hostileRows, row } from '../lib/fixtures.ts';
import { multiPagePdf } from './bytes.mjs';

const enc = (s) => new TextEncoder().encode(s);
const fileOf = (r) => decodeURIComponent(String(r.url).replace(/^\.\//, ''));

/** Extra originals of the main case: a real two-page PDF for page citations, real one-page PDFs, a text annex. */
export const MAIN_ORIGINALS = () => ({
	'DISCOVERY A/OD-001 Supply agreement.pdf': multiPagePdf(['OD-001 page one', 'OD-001 page two']),
	'DISCOVERY A/OD-002 Invoice 1001.pdf': multiPagePdf(['OD-002 invoice 1001']),
	'EXPERT/EX-001 Expert report.pdf': multiPagePdf(['EX-001 expert report']),
	'EXPERT/EX-002 Annex.txt': enc('Synthetic annex, plain text.\n'),
	'EXPERT/EX-003 Valuation.pdf': multiPagePdf(['EX-003 valuation', 'EX-003 page two', 'EX-003 page three']),
});
/** A bundle name outside the v5 standard set (Original/Correspondence/Supplementary). */
export const ODD_BUNDLE = 'Expert Reports & Annexes';
export const NARRATIVE = 'The agreement [[OD-001]] began the relationship; its terms are on [[OD-001#p2]]. See also [[EM-0001]] and the missing [[ZZ-404]].';

function mainRows(originals) {
	const sz = (p) => originals[p].byteLength;
	return [
		// ties on the date 2001-02-03 with the base rows (stable source order), a tie on amount 1150.00 with OD-002,
		// one undated row, a non-numeric-free empty amount (= 0) and a negative amount (SD-001, base fixture)
		row('EX-001', 8, 'EXPERT/EX-001 Expert report.pdf', sz('EXPERT/EX-001 Expert report.pdf'), { date: '2001-02-03', bundle: ODD_BUNDLE, doc_type: 'report', amount: '1150.00', subject: 'Synthetic expert report zebra' }),
		row('EX-002', 9, 'EXPERT/EX-002 Annex.txt', sz('EXPERT/EX-002 Annex.txt'), { date: '', bundle: ODD_BUNDLE, doc_type: 'report', amount: '75', subject: 'Synthetic annex' }),
		row('EX-003', 10, 'EXPERT/EX-003 Valuation.pdf', sz('EXPERT/EX-003 Valuation.pdf'), { date: '2001-01-15', bundle: ODD_BUNDLE, doc_type: 'valuation', amount: '', subject: 'Synthetic valuation' }),
	];
}

/** Keep the source size claims equal to the replaced bytes; capture the final chronology. */
const editor = (originals, extra) => (roots) => {
	for (const r of roots.DATA.chronology) { const f = fileOf(r); if (originals[f]) r.size = originals[f].byteLength; }
	roots.DATA.matter.storyline[0].t = NARRATIVE;
	extra?.(roots);
};

/** The main case (v1), or v2 of it when `dated` (rows that carry date_type/date_source, BA-04). */
export async function mainCase(dir, { caseDir, dated = false } = {}) {
	const originals = MAIN_ORIGINALS();
	let chronology;
	const edit = (roots) => {
		editor(originals, dated ? (r) => {
			const em = r.DATA.chronology.find((x) => x.ref === 'EM-0001');
			em.date_type = 'sent'; em.date_source = 'message header';
			const od = r.DATA.chronology.find((x) => x.ref === 'OD-002');
			od.date_type = 'issue';
		} : null)(roots);
		chronology = roots.DATA.chronology.map((r) => ({ ...r }));
	};
	const sc = await buildCase(dir, { caseId: 'e2e-main', originals, rows: mainRows(originals), edit, caseDir });
	return { ...sc, chronology };
}

/** Negative control (BA-09): the main case with OD-003's original deleted from the disposable folder before import. */
export async function missingCase(dir) {
	const originals = MAIN_ORIGINALS();
	let chronology;
	const sc = await buildCase(dir, { caseId: 'e2e-missing', originals, rows: mainRows(originals), edit: (r) => { editor(originals)(r); chronology = r.DATA.chronology.map((x) => ({ ...x })); } });
	const gone = 'DISCOVERY A/OD-003 Scan.pdf';
	unlinkSync(join(sc.caseDir, ...gone.split('/')));
	return { ...sc, chronology, gone, goneRef: 'OD-003' };
}

/** A small case for the no-JavaScript form post. */
export const nojsCase = (dir) => buildCase(dir, { caseId: 'e2e-nojs' });

export const HOSTILE_NARRATIVE = `<script>document.title='PWNED narrative'</script><img src=x onerror="document.title='PWNED img'"> <a href="http://evil.example/">link</a> <iframe src="http://evil.example/frame"></iframe> cites [[HX-001]] and [[HX-005#p1]]`;
/** A markdown javascript: link in authored narrative: the validator must reject the whole package. */
export const UNSAFE_LINK_NARRATIVE = 'See [the file](javascript:alert(1)) and [[OD-001]].';
export const LYING_NAME = 'HX-001 Signed invoice.pdf';
/** Hostile originals and rows (fixtures.ts), a hostile narrative, and one row whose declared filename lies. */
export async function hostileCase(dir, { narrative = HOSTILE_NARRATIVE } = {}) {
	const originals = hostileOriginals();
	let chronology;
	const sc = await buildCase(dir, {
		caseId: 'e2e-hostile', originals, rows: hostileRows(),
		edit: (r) => {
			r.DATA.matter.storyline[0].t = narrative;
			// the row declares a harmless PDF name; the verified mapping says the bytes are HOSTILE/HX-001 page.html
			r.DATA.chronology.find((x) => x.ref === 'HX-001').filename = LYING_NAME;
			r.DATA.matter.title = `<img src=x onerror="document.title='PWNED title'">Hostile matter`;
			chronology = r.DATA.chronology.map((x) => ({ ...x }));
		},
	});
	return { ...sc, chronology, originals };
}

export const cleanup = (p) => rmSync(p, { recursive: true, force: true });
