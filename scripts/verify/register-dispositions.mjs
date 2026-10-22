#!/usr/bin/env bun
// Source-defect dispositions for the parity register (GRS-67, F4 of the CC-11 readiness gate):
//
//   bun scripts/verify/register-dispositions.mjs [--check]
//
// Writes one disposition per row of DISPOSITIONS below into the register file of the view's owner
// (docs/reference/parity/register/CC-NN.json; the pilot's views into intentional-differences.json). A disposition is
// an entry with field [] (docs/reference/parity/README.md, "Source-defect dispositions"): it records how a v5 source
// defect stands in ClearCase and covers no parity difference. Each row rests on evidence: a test or the app line that
// shows the behaviour, found by a literal pattern; the script fails when a pattern is gone, and writes the file:line it
// found into the reason, with the covering entry when parity sees the change. Entries keep approvedBy null: the user
// approves them. The script owns only entries whose author is AUTHOR; it keeps their ids and any approvedBy and
// approvedOn the user set while type, productVisible and the reason (apart from its evidence file:line) are unchanged, so
// a rerun changes nothing unless the table, the evidence lines or the register changed; an entry that changed in any
// other way loses its approval, and the script names it. --check also compares the generated CC-11 defects table with its
// committed copy; --table FILE overrides that copy for a synthetic test. --check exits 1 when the register or table differs, and (also without --check) when a
// defect of defects.md or view-checklist.md has no entry naming it, a disposition names a defect that is no longer
// listed, a defects.md row does not parse, or an evidence pattern is empty. --reference DIR reads docs/reference from DIR instead (the tests'
// synthetic copy); evidence files are always read from the repository.
// scripts/verify/dispositions.mjs then reports every defect as registered.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { RANGES, RETIRED, registerFiles } from '../parity/lib/register.mjs';
import { citing, isListed, readDefects } from './lib/defects.mjs';
import { VIEWS } from '../../src/lib/components/view-registry.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const referenceAt = process.argv.indexOf('--reference');
const REF = referenceAt > 0 ? resolve(process.argv[referenceAt + 1]) : join(ROOT, 'docs', 'reference');
const AUTHOR = 'GRS-67 dispositions (scripts/verify/register-dispositions.mjs)';
/** Ids the main file may give a disposition of a pilot view: above its legacy entries, below every owner's range. */
const MAIN_RANGE = [74, 99];
const FIX = 'defect-fix', GAP = 'known-gap', DATA = 'data-correction-deferred-to-pipeline';

// [defect, view, type, productVisible, evidence file, evidence pattern (a literal substring), covering entry or null, reason]
// A row may name several defects of one view with one pattern each, all in its evidence file, when one change closes
// them all: CC-06's id range has fewer never-used ids than it has defects.
// defect-fix: ClearCase does not have the defect; known-gap: ClearCase reproduces it (an app fix would close it);
// data-correction-deferred-to-pipeline: the defect is in the imported data.
const DISPOSITIONS = [
	["S-index-keys", "info_required_tab", FIX, false, "tests/analysis/info-required.test.ts", "keeps it there when a later version reorders the list", null,
		"v5 keys the Info Required done flags and the enforcement step statuses by array position in the imported lists, so a reordered list moves them to other items. ClearCase keys each by a digest of the item's own content and reports a flag or status whose item left the version instead of moving it (S-info_required_tab-1, S-enforcement_tab-1)."],
	["S-prescription-frozen", "prescription_tab", DATA, true, "src/lib/views/quantum/prescription.ts", "export const asOfStatus = (r: PrescRow, asOf: string)", "IDR-225",
		"The imported Risk labels are precomputed against a fixed headline date and leap-day invoices are moved to the 28th in the imported prescription dates. ClearCase still shows them as imported, but adds an As-of status computed from the shown date and an explicit as-of date, plus an arithmetic card; correcting the imported labels and dates is deferred to the document pipeline."],
	["S-meta-counts", "overview", DATA, true, "src/routes/v/[vid]/overview/+page.svelte", "Register rows with text status none", "IDR-049",
		"The imported build metadata counts for documents without text and for e-mails disagree with the rows. ClearCase recounts both from the register rows and shows the metadata figure beside the count only where it differs, as the source claim; correcting the imported metadata is deferred to the document pipeline. IDR-049 is a defect-fix because it types the shown count it covers, which the app corrects; this entry types the defect, whose imported source stays wrong."],
	["S-routing", "overview", FIX, true, "src/lib/components/PageHeader.svelte", "<title>{pageTitle({ section, caseName, document, status })}</title>", null,
		"v5 has no URL routing: reload and Back always return to the Overview and the page title never changes. In ClearCase every view and document is a real route with its own history entry, filters live in the URL, and the title names the document, section and case."],
	["S-csv", "chronology", FIX, true, "src/lib/components/csv.ts", "const s = PLAIN_NUMBER.test(t) ? t : neutral(t);", null,
		"v5 CSV export leaves formula prefixes unneutralised and a bare carriage return unquoted. ClearCase quotes cells containing a carriage return, and neutralises every exported text cell, imported or typed, at its start (also behind leading spaces, which a \"Trim spaces\" import removes) and after separators. A plain decimal number such as -5 and a validated signed-money amount keep their sign, so a spreadsheet reads a number; -1+2 and +27 phone numbers are neutralised."],
	["S-catalogue-refs", "court_bundle_tab", DATA, false, "src/lib/views/bundles/links.ts", "item keys such as OD-10 are never refs", null,
		"The imported catalogue lists refs that resolve to no chronology row, and court-bundle item keys use unpadded numbers, a different namespace from chronology refs. ClearCase keeps the data as imported, reports the unresolved citations, and never resolves an item key as a ref by similarity; correcting the imported data is deferred to the document pipeline. No register entry covers it."],
	["S-_shell-2", "overview", FIX, true, "src/lib/views/evidence/search.ts", "submitted: FIELDS.some((k) => p.has(k))", null,
		"v5 global search sets only the query and keeps stale Advanced Search filters, so it can return filtered or empty results. ClearCase has no separate global search box: search runs only through the Advanced Search form, whose filters are exactly those in its address, so no stale filter applies (as S-search-2)."],
	["S-_shell-3", "overview", FIX, true, "src/lib/components/ViewNav.svelte", "<a href=\"{viewHref(resultsVersion, v)}", null,
		"v5 has no URL routing, so reload, Back and a deep link always land on the Overview. In ClearCase each navigation entry is a real link to its own route, so reload, Back and deep links return to the same view, and the current view is marked for navigation."],
	["S-_shell-4", "overview", FIX, true, "src/lib/components/OriginalOpen.svelte", "id=\"open-original\">Open{page ? ` at page ${page}` : ''}</a>", null,
		"v5 opens originals in a modal with no focus trap, no focus return and no backdrop close. ClearCase has no modal: the document page offers Open and Download links that open the original in a separate browsing context, so there is no overlay to trap or restore focus in."],
	["S-_shell-5", "overview", FIX, false, "src/lib/components/format.ts", "if (!Number.isFinite(n)) return '';", null,
		"v5 money formatting has an unreachable guard clause (dead code with no visible effect). ClearCase has no counterpart of this v5 code; its currency formatter has one finite-number guard and formats zero as a normal amount."],
	["S-_shell-6", "chronology", FIX, true, "src/lib/components/csv.ts", "export const toCSV = (rows", null,
		"v5 toCSV does not quote a cell with a bare carriage return and does not neutralise formula prefixes, so imported or user-typed text can become a spreadsheet formula. ClearCase quotes cells with a carriage return, line feed, tab or semicolon, and every CSV export neutralises imported and user-typed text at its start (also behind leading spaces) and after any separator; only a plain decimal number and a validated signed-money amount keep a leading minus."],
	["S-_shell-7", "chronology", FIX, true, "src/lib/components/OriginalOpen.svelte", "Download only: this file is not displayed in the browser", null,
		"v5 opens its fallback panel only for previewable extensions, so mail files go straight to a new tab. ClearCase decides from the verified original on the document page and shows an explicit state for each case: viewer, inline, plain text, download only, parent route or missing."],
	["S-_shell-8", "chronology", FIX, true, "src/lib/components/OriginalOpen.svelte", "links.presentation === 'viewer' && links.viewer", null,
		"v5 derives the file extension from the link text, so a suffix such as a page anchor defeats the viewer check. ClearCase never inspects a link: the server decides the presentation from the verified original, and the page anchor is appended to the viewer link only afterwards."],
	["S-overview-2", "overview", DATA, true, "src/routes/v/[vid]/overview/+page.svelte", "Register rows with text status none", "IDR-049",
		"The imported build metadata count of documents without text disagrees with the rows whose text status is none. ClearCase counts the register rows for the tile and shows the metadata figure beside it as the source claim; correcting the imported metadata is deferred to the document pipeline."],
	["S-overview-4", "overview", FIX, false, "src/routes/v/[vid]/overview/+page.svelte", "content.subtitle ?? (o.matter?.title || data.version.caseName)", null,
		"v5 hard-codes the case title in its renderer. ClearCase takes the page subtitle from the imported view-content, else the matter title, else the case name, so no case title is in code."],
	["S-overview-5", "overview", FIX, false, "src/routes/v/[vid]/overview/+page.svelte", "let { data, form } = $props();", null,
		"v5 has a local constant that shadows the global download helper and an unused result. This is code shape with no user-visible effect; ClearCase has no counterpart of this v5 code (the overview renders from server-loaded data)."],
	["S-chronology-2", "chronology", FIX, false, "src/lib/local-case/documents.server.ts", "!LIST_TEXT.every((k) => isText(l[k]))", null,
		"v5 joins filename and ref without null guards, so a row lacking a filename would match the text undefined. ClearCase rejects any row whose text fields are not strings, so the filter never sees a missing filename; that row goes to the degraded-rows notice instead."],
	["S-chronology-4", "chronology", FIX, true, "src/routes/v/[vid]/chronology/+page.svelte", "query.sort === 'docType' ? 'type' : query.sort", null,
		"v5 says sorted by date after another sort. ClearCase names the active sort in the subtitle."],
	["S-chronology-6", "chronology", GAP, false, "src/lib/local-case/chronology.ts", "(a[sort] < b[sort] ? -1 : a[sort] > b[sort] ? 1 : 0)", null,
		"v5 compares refs as plain strings, so refs of different digit widths sort lexically. ClearCase compares refs the same way; rescan refs are zero-padded to the case width so they do not misorder, but a natural numeric ref sort would need an app change."],
	["S-documents-2", "documents", FIX, true, "src/lib/views/evidence/documents.ts", "for (const r of rows) m.set(r.bundle, (m.get(r.bundle) ?? 0) + 1);", null,
		"v5 takes bundle button counts from build metadata while the table lists all rows including rescan additions, so they disagree after a rescan. ClearCase counts each bundle button from the same rows the table lists, so the counts always agree."],
	["S-contracts_tab-1", "contracts_tab", FIX, true, "src/lib/views/evidence/contracts.ts", "if (/\\bunsigned\\b/i.test(t)) return 'unsigned';", null,
		"v5 tests unsigned in the note only and matches a loose sign pattern anywhere, so words such as assignment or designated read as signed. ClearCase reads whole words in title and note, treats negated wording as uncertain, and labels the marker as an unverified heuristic."],
	["S-contracts_tab-2", "contracts_tab", FIX, false, "src/routes/v/[vid]/evidence/contracts_tab/+page.server.ts", "(S-contracts_tab-2), imported as view-content", null,
		"v5 hard-codes case narrative and a document total in the renderer. ClearCase shows the two cards and the closing paragraph only from the imported package view-content and renders nothing when it is absent, so no case wording or total is in code."],
	["S-filings_tab-1", "filings_tab", FIX, true, "tests/evidence/filings.test.ts", "shows it again with a note when the seed changed since", "IDR-101",
		"v5 copies the seed register into user storage on first read, so a later results version seed is never shown to existing users. ClearCase keeps imported seeds and user rows apart: edits and deletes are overlays on the seed, and a changed seed shows again with a note."],
	["S-filings_tab-2", "filings_tab", FIX, true, "src/lib/views/evidence/filings.server.ts", "if (step !== 'confirm') return fail(400, { op: 'delete' as const, target,", null,
		"v5 deletes a register row by array index without asking. ClearCase deletes by stable row key and asks first: Delete shows Confirm delete and Cancel inline, with focus on Confirm delete, and Cancel or Escape keeps the row. The server deletes nothing unless the request names the row it was confirmed for, so a page without JavaScript asks the same question."],
	["S-filings_tab-3", "filings_tab", FIX, false, "src/lib/views/evidence/filings.server.ts", "orientation: viewText(vc, 'filings_tab', 'orientation')", null,
		"v5 hard-codes the orientation paragraph, with a bundle ref, a file size and a date, in the renderer. ClearCase shows that paragraph from the imported package view-content, so no case content is in code."],
	["S-search-1", "search", GAP, true, "src/routes/v/[vid]/evidence/search/+page.svelte", "const s = data.submitted ? paramsOf(q).toString() : '';", null,
		"v5 exports and extracts action items from the last submitted search, not the current form values. ClearCase copies this: the submitted search is the page address and the export and action items use exactly it, so unsubmitted edits are not exported; making them follow the form would need an app change."],
	["S-search-2", "search", FIX, true, "src/lib/views/evidence/search.ts", "submitted: FIELDS.some((k) => p.has(k))", null,
		"v5 global search sets only the query and leaves older filters in place, and auto-runs only for a query or bundle. ClearCase has no global box; the Advanced Search form shows exactly the filters in its address and runs whenever any field is present, so no remembered filter silently yields nothing."],
	["S-search-3", "search", GAP, false, "src/lib/views/evidence/search.ts", "`${r.sender}${r.to}${r.cc}`.toLowerCase()", null,
		"v5 joins sender, to and cc with no separator for the Sender filter, so a match can span a field boundary. ClearCase copies this joined comparison; adding a separator would need an app change."],
	["S-search-6", "search", FIX, true, "src/lib/views/evidence/search.ts", "visibleExcerpt(r.excerpt, 120)", null,
		"v5 appends an ellipsis even to a short search excerpt. ClearCase marks only an excerpt longer than the displayed text."],
	["S-hoa_diff_tab-2", "hoa_diff_tab", GAP, true, "src/lib/views/evidence/diff.ts", "Only the indexed excerpts are compared (S-hoa_diff_tab-2)", "IDR-131",
		"v5 diffs only the short indexed excerpt, so lines mode degenerates to replacing the whole single-line excerpt. ClearCase still compares only the excerpts, but states each side excerpt length and text status; full-text comparison needs a full-text rebuild."],
	["S-timeline-1", "timeline", FIX, true, "src/lib/views/analysis/timeline.test.ts", "keeping entities as plain characters", "IDR-167",
		"v5 escapes an event's link label twice, so a title with an ampersand or angle bracket shows literal entity text. ClearCase cleans the title and shows it once, as a text node, so the characters appear as typed."],
	["S-timeline-2", "timeline", FIX, false, "src/routes/v/[vid]/analysis/timeline/+page.server.ts", "synopsis: viewText(vc, 'timeline', 'synopsis'", null,
		"v5 hard-codes case narrative, counts and a firm name in the renderer. ClearCase fills the synopsis, narrative, trajectory and notes from the imported view-content dataset, with counts derived from the register and package, so no case wording lives in code."],
	["S-timeline-3", "timeline", FIX, true, "src/lib/views/analysis/timeline.test.ts", "all-zero counts draw flat bars, not NaN", null,
		"v5 scales year bars by the maximum, so a map of only zero counts divides by zero and gives NaN heights. ClearCase takes the maximum with a zero floor and draws flat bars for all-zero counts and none for an empty map."],
	["S-timeline-4", "timeline", GAP, true, "src/lib/views/analysis/headings.ts", "timeline: 'Chronology & Timeline'", null,
		"v5 heads the page Chronology & Timeline while its navigation and crumb say Timeline. ClearCase reproduces this by default: a heading equal to the navigation label is an analysis addition behind CLEARCASE_ANALYSIS_ADDITIONS, off until the client approves it (ADR 0003, GRS-48); with the flag set to 1 the heading is Timeline. Info Required and Defence & Rebuttal keep v5's headings the same way."],
	[["S-quantum_tab-1", "S-quantum_tab-2"], "quantum_tab", FIX, true, "src/routes/v/[vid]/quantum/quantum_tab/+page.svelte", ["label=\"Open source PDF\"", "type: 'charging calculation' })}"], null,
		"S-quantum_tab-1: v5's headline source link bypasses the viewer, unlike every other document link; ClearCase renders it through the shared citation link, which opens the document page. S-quantum_tab-2: v5's charging shortcut sets only the type filter and keeps earlier filters; ClearCase links to the chronology with the default query and only the type set."],
	["S-quantum_tab-3", "quantum_tab", GAP, true, "tests/quantum/ledger.test.ts", "draws no negative bar and nothing for an empty series", null,
		"v5's amount chart assumes non-negative amounts and writes negative heights. ClearCase draws no bar for a negative amount. The bar-width formula with its minimum is unchanged, so bars can still overlap with a very large series, the other half of the defect; closing it would need an app change."],
	["S-disbursements_tab-2", "disbursements_tab", FIX, true, "tests/registers/logic.test.ts", "neutralising formulas and quoting CR and LF", null,
		"v5's CSV export writes free-text fields unprotected, so a cell starting with a formula character can run as a formula in a spreadsheet. ClearCase passes every exported user cell through a neutraliser that prefixes such cells, and formula segments after a separator, with an apostrophe. The exception is a validated amount in a signed-money field (Disbursements Amount): it is written as a plain two-decimal number, credits included, with R and grouping removed, where v5 writes what the user typed."],
	["S-timesheet_tab-2", "timesheet_tab", GAP, true, "src/lib/views/registers/logic.ts", "def.fields.map((x) => x.k)", null,
		"v5 exports only the stored fields, so the derived Value is missing from the CSV. ClearCase writes the same stored field keys and rows and does not add the Value column; an app change is needed to export it."],
	["S-deadlines_tab-3", "deadlines_tab", GAP, true, "src/lib/views/registers/page.server.ts", "const step = deleteStep(f, rowId);", null,
		"v5 has no edit, keeps the category after Add and deletes without asking. ClearCase adds a per-row Edit and deletes by stable row id only once confirmed: Delete shows Confirm delete and Cancel inline, and the server deletes nothing unless the request names the confirmed row. The same question also appears on Cross-examination and the other six generic registers. One of the three parts remains: the category still stays after Add. Closing it would need an app change."],
	["S-deadlines_tab-4", "deadlines_tab", FIX, true, "tests/registers/deadline-calendar.test.ts", "counts on the South African calendar date whatever the host time zone", null,
		"v5 counts days from local midnight, so counts can differ from the court calendar date near a clock change or in another timezone. ClearCase counts calendar days from today's date in South Africa (Africa/Johannesburg, the court's calendar, UTC+2 all year) to the deadline's date, so the countdown and the Overview's open deadlines no longer depend on the host's time zone. On a host in South Africa they equal v5's."],
	["S-contradictions_tab-1", "contradictions_tab", GAP, false, "src/routes/v/[vid]/analysis/contradictions_tab/+page.svelte", "<div class=\"v an-danger\">{c.highCount}</div>", null,
		"v5 trusts the high-severity count and per-category counts from the dataset instead of deriving them. ClearCase copies this and shows the package's own figures, so a package whose counts disagree with its categories shows inconsistent KPIs; deriving them would be an app change."],
	["S-contradictions_tab-2", "contradictions_tab", FIX, false, "src/lib/views/analysis/contradictions.test.ts", "exports an item without refs with an empty refs cell instead of failing", null,
		"v5 throws on export, and when rendering chips, if an item has no refs. ClearCase guards the export and writes an empty refs cell, and its import schema requires a refs array on every item, so the view never meets a missing one."],
	["S-contradictions_tab-3", "contradictions_tab", FIX, false, "src/routes/v/[vid]/analysis/contradictions_tab/+page.server.ts", "viewText(vc, 'contradictions_tab', 'methodNote'", null,
		"v5 hard-codes a paragraph of case reasoning in the renderer. ClearCase shows the method note from the imported view-content dataset, with the document count derived from the register, so no case wording lives in code."],
	["S-risk_matrix_tab-1", "risk_matrix_tab", GAP, true, "src/routes/v/[vid]/analysis/risk_matrix_tab/+page.svelte", "<TableScroll label=\"Risk matrix\" class=\"an-scroll\">", null,
		"v5 has no export or edit for this register-like view and maps colour by exact, case-sensitive High or Medium. ClearCase reproduces both: the page is a read-only table with no export button and the tone mapping is case-sensitive. Adding export or edit needs an app change."],
	["S-vdm_matrix_tab-1", "vdm_matrix_tab", GAP, true, "tests/analysis/flag-states.test.ts", "hides the defence Refs column and exports v5", null,
		"v5 never shows or exports the defence matrix free-text refs. ClearCase reproduces this by default: the Refs column and the CSV's last refs column are analysis additions behind CLEARCASE_ANALYSIS_ADDITIONS, off until the client approves them (ADR 0003, GRS-48); with the flag set to 1 both show, after v5's columns."],
	["S-vdm_matrix_tab-2", "vdm_matrix_tab", FIX, false, "src/routes/v/[vid]/analysis/vdm_matrix_tab/+page.server.ts", "subtitle: viewText(vc, 'vdm_matrix_tab', 'subtitle')", null,
		"v5 hard-codes party abbreviations in the column headings and subtitle. ClearCase reads the subtitle and column headings from the imported view-content dataset, falling back to neutral headings, so the parties are named by the package and not by code."],
	["S-info_required_tab-1", "info_required_tab", FIX, true, "tests/analysis/info-required.test.ts", "saves a flag on its item and keeps it there when a later version", null,
		"v5 keys done flags by array index, so reordering or inserting items in a later version moves flags onto other items. ClearCase keys each flag by a digest of the item's own content and reports flags whose item has left the version instead of moving them."],
	["S-info_required_tab-2", "info_required_tab", GAP, true, "src/routes/v/[vid]/analysis/info_required_tab/InfoChecklist.svelte", "<span class=\"badge {infoTone(r.status)}\">{r.status}</span>", null,
		"v5 has no export and the Status column ignores the done flag. ClearCase has no export on this view either, and its Status badge still shows only the imported status (a done item is struck through in the Item cell). An app change is needed to export or reflect done in Status."],
	["S-conflict_tab-1", "conflict_tab", FIX, true, "tests/litigation/conflict.test.ts", "the input hint is generic: no e-mail address, no digits, nothing imported", null,
		"v5's input placeholder names a real company and a real person's e-mail address from the case. ClearCase uses a generic hint with no imported text and no personal data, and a test pins that."],
	["S-conflict_tab-2", "conflict_tab", GAP, true, "src/lib/views/litigation/conflict.ts", "fold(`${cat(p.name)} ${cat(p.email)} ${cat(p.org)}`).includes(q)", null,
		"v5 matches a substring over space-joined fields, so a query can match across field boundaries and a very short query matches almost everything. ClearCase copies this deliberately (adding case, width and diacritic folding). Per-field matching or a minimum length would need an app change."],
	["S-conflict_tab-3", "conflict_tab", GAP, true, "src/routes/v/[vid]/litigation/conflict_tab/+page.svelte", "there is no Enter handler", null,
		"v5's free-text box has no Enter-key handler; only Check or the select runs the search. ClearCase copies this: the box is a plain input outside a form, with no key handler. Handling Enter would be an app change."],
	["S-conflict_tab-4", "conflict_tab", GAP, true, "src/lib/views/litigation/conflict.ts", "const cat = (v: unknown) => String(v);", null,
		"v5 concatenates e-mail and organisation unguarded, so an empty e-mail shows as empty brackets and a missing field prints and is searched as undefined. ClearCase copies this on purpose (tested); a guard would be an app change."],
	["S-enforcement_tab-1", "enforcement_tab", FIX, true, "tests/litigation/enforcement.test.ts", "attaches an override to its step even when the steps are reordered", null,
		"v5 keys saved step statuses by array index, so changing the order or count remaps them to other steps. ClearCase keys each status by a digest of the step's phase and step text and discloses duplicate steps instead of guessing."],
	["S-enforcement_tab-2", "enforcement_tab", FIX, true, "tests/litigation/enforcement.test.ts", "keeps an imported status outside ENF_OPTS as its own option instead of showing", null,
		"v5 leaves no option selected when a seed status is outside the list, so the browser shows To do while the stored value differs. ClearCase adds the imported status, and a saved one no longer offered, as its own option so the select shows what is stored."],
	["S-enforcement_tab-3", "enforcement_tab", FIX, false, "src/routes/v/[vid]/litigation/enforcement_tab/+page.server.ts", "viewText(vc, 'enforcement_tab', 'whyNarrative')", null,
		"v5 hard-codes a case-specific recovery narrative in the renderer. ClearCase reads it from the imported view-content dataset, so the case wording comes from the package and not from code."],
	["S-legality_tab-1", "legality_tab", FIX, false, "src/routes/v/[vid]/litigation/legality_tab/+page.server.ts", "subtitle: viewText(vc, 'legality_tab', 'subtitle')", null,
		"v5 hard-codes case-specific text in the subtitle. ClearCase reads the subtitle from the imported view-content dataset, so the case wording comes from the package and not from code."],
	["S-prescription_tab-4", "prescription_tab", GAP, true, "tests/quantum/prescription.test.ts", "counts the dates that equal invoice date + 3 years", "IDR-224",
		"v5 leaves the leap-day rule unspecified and precomputed. ClearCase still shows the imported date but adds an arithmetic-checks card counting leap-day invoices and rows equal to the invoice date plus three years, labelled arithmetic only with the legal rule not approved. The rule itself is still unspecified, which is the defect; specifying it needs a decision and an app change."],
	["S-interest_calc_tab-2", "interest_calc_tab", FIX, false, "src/routes/v/[vid]/quantum/interest_calc_tab/+page.server.ts", "number('interest_calc_tab', 'defaultRate')", null,
		"v5 hard-codes the default rate in the renderer. ClearCase takes it from the imported view-content dataset and leaves the field empty when the package has none, so no rate literal stands in."],
	["S-interest_calc_tab-4", "interest_calc_tab", FIX, true, "tests/calculations/interest.test.ts", "counts days on the calendar, independent of time zone", null,
		"v5 subtracts local-time dates, so a clock change gives a fractional day count. ClearCase counts whole days on the calendar from year, month and day, independent of the time zone."],
	["S-interest_calc_tab-5", "interest_calc_tab", FIX, true, "tests/quantum/interest-basis.test.ts", "it('a total as at another date'", "IDR-450",
		"v5 compares a computed total on one typed capital with the headline due on unlike bases. ClearCase compares only with capital, matching dates and no payment on or before To or undated. Even then the difference is arithmetic, not a reconciliation: the statement's capital, rates and dates are unknown. With no capital, the dated due asks for one and any basis conflict appears without a verdict (IDR-451). With capital on unlike bases, due stands alone with the reason. This disclosure closes the defect."],
	["S-payments_tab-3", "payments_tab", FIX, true, "tests/quantum/interest-basis.test.ts", "it('a recorded payment on or before the date, on it, or undated'", null,
		"v5's Settlement and Interest views use gross figures and ignore recorded payments. ClearCase's Settlement claim prefill is net of payments. Interest does not net them, which would need a rule on whether a payment pays interest or capital first. A payment on or before To, or undated, prevents comparison with capital and is explained in a conditional note without capital. That disclosure, not netting, is how this closes the defect; the user approves or rejects it."],
	["S-payments_tab-5", "payments_tab", FIX, false, "src/routes/v/[vid]/quantum/payments_tab/+page.server.ts", "subtitle: viewText(content(version.id), 'payments_tab', 'subtitle')", null,
		"v5 hard-codes the respondent abbreviation in the subtitle. ClearCase reads the subtitle from the imported view-content dataset, so the party naming comes from the package and not from code."],
	["S-elements_tab-1", "elements_tab", FIX, true, "tests/litigation/readonly.test.ts", "is null for an unknown, empty or non-text id", null,
		"v5 takes navigation target ids from the data unvalidated, so an unknown id opens a Not found page. ClearCase maps the id to a registry view only when it names one; otherwise the cell shows plain text saying there is no such view, with no link."],
	["S-authorities_tab-1", "authorities_tab", GAP, true, "src/routes/v/[vid]/litigation/authorities_tab/+page.svelte", "no edit or delete for authorities", null,
		"v5 lets users add authorities but not edit or delete them. ClearCase copies this: user-added rows have no edit or delete control. Adding them would be an app change."],
	["S-heads_tab-1", "heads_tab", FIX, false, "tests/litigation/heads-authorities.test.ts", "starts with the literal heading and the view-content caption", null,
		"v5 hard-codes the case caption in the export header. ClearCase writes the literal heading and adds the caption only when the imported view-content dataset has one, so no case caption lives in code."],
	["S-heads_tab-2", "heads_tab", GAP, true, "src/lib/views/litigation/heads.ts", "split(/[ ,]+/).filter(Boolean)", null,
		"v5 splits evidence refs only on spaces and commas, so semicolons or newlines leave refs unresolved. ClearCase copies this deliberately and the test pins it. Splitting on more separators would be an app change."],
	["S-heads_tab-3", "heads_tab", GAP, true, "src/routes/v/[vid]/litigation/heads_tab/+page.server.ts", "const refused = unconfirmed(f, raw, values);", null,
		"v5 has no reorder or edit of submissions and deletes by position without a prompt. ClearCase deletes by stable row id only once confirmed: Delete shows Confirm delete and Cancel inline, and the server deletes nothing unless the request names the confirmed row. The same question also appears on Cross-examination and on all seven generic registers. It still has no reorder and no edit. Those would need an app change."],
	["S-crossexam_tab-1", "crossexam_tab", FIX, true, "tests/litigation/crossexam.test.ts", "shows seeds in data order, then user rows, with nothing copied", null,
		"v5 copies the seed topics into user storage on first render, so later seeds are never shown. ClearCase reads seeds from the package on every render and stores only the user's edits and deletions as overlays, so a newer seed shows, with a disclosure when an edit conflicts."],
	["S-crossexam_tab-2", "crossexam_tab", GAP, true, "src/routes/v/[vid]/litigation/crossexam_tab/+page.svelte", "<td>{r.docs}</td>", null,
		"v5 has no export for this register and shows document references as plain text. ClearCase has no export button and also shows the Documents cell as plain text. Export and linked references would need an app change."],
	["S-crossexam_tab-3", "crossexam_tab", GAP, true, "src/routes/v/[vid]/litigation/crossexam_tab/+page.svelte", "S-crossexam_tab-3 (copied): v5 has a second Add", null,
		"v5 shows two Add buttons, one in the header and one in the form, with the same handler. ClearCase copies this: the header button submits the same form. Removing one would be an app change."],
	[["S-settlement_tab-1", "S-settlement_tab-2", "S-settlement_tab-5"], "settlement_tab", FIX, true, "src/routes/v/[vid]/quantum/settlement_tab/+page.server.ts", ["cost: vc.number('settlement_tab', 'defaultEnforcementCost')", "claim: claimPrefill(t.net)", "narrative: viewText(vc, 'settlement_tab', 'narrative')"], null,
		"S-settlement_tab-1 and S-settlement_tab-5: v5 hard-codes the cost, probability, years and discount defaults and a case narrative in the renderer; ClearCase reads them from the imported view-content dataset, so none is in code. S-settlement_tab-2: v5 uses the gross claim and ignores recorded payments; ClearCase prefills the net claim, the amount due less the recorded payments, and says so when payments exceed it."],
	["S-settlement_tab-4", "settlement_tab", GAP, true, "src/lib/views/quantum/settlement.ts", "{ label: 'Pessimistic (p-25)'", null,
		"v5's scenario labels do not reflect clamping of the probability, and costs are not discounted while recovery is. ClearCase copies both: fixed labels and undiscounted costs. Changing either would be an app change."],
	["S-transcriptions_tab-1", "transcriptions_tab", GAP, true, "tests/registers/store.test.ts", "refuse an entry larger than 64 KiB and store nothing", null,
		"v5 keeps large transcript bodies in browser storage with a quota near 5 MB and only alerts on failure. ClearCase stores them in the local case store with a 64 KiB entry limit and shows a failed save with the input kept. Bodies are still rendered whole, the other half of the defect; paging them would need an app change."],
	["S-rescan_tab-1", "rescan_tab", FIX, true, "tests/system/rescan.test.ts", "a v5-style './'-encoded path and the walked path are one file (S-rescan_tab-1)", null,
		"v5 compares walked paths with a different prefix style than the embedded URLs, so a first rescan treats every indexed file as new. ClearCase matches by decoded path relative to the case folder, the key the import used, so an indexed original is never re-added."],
	["S-rescan_tab-2", "rescan_tab", FIX, true, "tests/system/rescan.test.ts", "a same-name, same-size content change: a quick scan cannot see it", "IDR-404",
		"v5 collects size and date but never reports a change. ClearCase reports changed originals: a quick scan finds a size change, a full scan compares SHA-256 and finds a same-size change, and the result is listed."],
	["S-rescan_tab-3", "rescan_tab", FIX, true, "src/lib/local-case/rescan/rescan.server.ts", "with the app's './' URL base", null,
		"v5 rescan links use one relative base while the embedded document links use another, so one of them is wrong for any app location. ClearCase builds addition links with the same base and encoding as imported documents, and opens them through the document route."],
	["S-rescan_tab-4", "rescan_tab", FIX, true, "tests/system/rescan.test.ts", "several same-prefix additions get distinct refs that continue the case numbering", null,
		"v5 numbers a new ref from the bundle row count without padding, so it can collide or misorder. ClearCase continues the highest number used per prefix (imported, rescan and cleared refs), zero-padded to the case width, and never issues a ref twice."],
	["S-rescan_tab-5", "rescan_tab", GAP, true, "tests/system/rescan.test.ts", "the walk skips hidden entries and a processing package folder", null,
		"v5 turns everything under the folder, including its own app page and generated output, into document rows. ClearCase skips hidden entries, processing package folders and its own data directory, and never writes output into the case folder; the v5 app HTML and other loose files in the case folder are still listed as additions, and the defect names the app HTML first. Excluding them would need an app change."],
	["S-rescan_tab-6", "rescan_tab", GAP, true, "src/lib/views/system/rescan.server.ts", "additions(a, v.case_id, v.id).map((p) => p.row)", null,
		"v5's Write updated index to file writes only the rescan additions, not a merged index. ClearCase keeps this: its download holds only the additions in v5's row shape. Writing a full updated index would need an app change."],
	["S-rescan_tab-7", "rescan_tab", FIX, true, "src/lib/local-case/rescan/rules.ts", "S-rescan_tab-7: every new file is pending processing", "IDR-403",
		"v5 marks non-PDF files as extracted although nothing was extracted, and detects invoices with a case-specific pattern. ClearCase marks every addition as pending processing and detects invoices by the generic word in the file name."],
	["S-rescan_tab-8", "rescan_tab", FIX, true, "src/lib/views/system/rescan.server.ts", "The scan did not run: ", "IDR-401",
		"v5 swallows folder-picker cancel and permission errors silently. ClearCase needs no picker; a case folder that cannot be read, or a scan that fails, is reported on the page with the message and the statement that nothing was changed."],
	["S-backup_tab-1", "backup_tab", FIX, true, "tests/system/stores-21.test.ts", "restored into a fresh profile, every store reads back identically", "IDR-413",
		"v5's backup key list omits five live user-work stores, so their work is silently lost. ClearCase backs up every registered table and a test round-trips all 21 v5 stores, including those five, through backup and restore."],
	["S-backup_tab-2", "backup_tab", FIX, false, "tests/system/backup.test.ts", "documents the 21 live v5 stores and the four legacy keys", null,
		"v5's key list names four keys no code reads or writes. ClearCase has no key list: it backs up registered tables, and keeps the four unused v5 keys only as documented legacy keys that a v5 backup import reports as unused."],
	["S-backup_tab-3", "backup_tab", FIX, true, "tests/system/backup.test.ts", "a corrupt, incompatible, altered, wrong-case or oversized file is refused", "IDR-419",
		"v5 import has no validation or confirmation, so a parseable but wrong file overwrites stores. ClearCase checks format, checksum, case and size before any write, requires a confirmation tick, keeps a copy of the current work, and changes nothing on refusal."],
	["S-backup_tab-4", "backup_tab", FIX, true, "src/routes/v/[vid]/system/backup_tab/+page.svelte", "<button id=\"restore-submit\">Import state</button>", "IDR-419",
		"v5 starts the import from the file input's change event, so after a failed import choosing the same file again does not fire it. ClearCase starts a restore from an explicit Import state button, so the same file can be submitted again without re-choosing it."],
	["S-manual-1", "manual", FIX, true, "src/lib/views/system/manual.server.ts", "a real check of the package's link sample", null,
		"v5's Verify link sample verifies nothing and its footnote hard-codes a count. ClearCase checks each sample link against the case folder now and reports found, missing or outside, with counts taken from the data."],
	["S-manual-2", "manual", FIX, true, "src/routes/v/[vid]/system/manual/+page.svelte", "saves all of a case's work to one file and restores it", "IDR-423",
		"v5's manual claims every store uses one key pattern and moves with Backup/Restore, which was false for several stores. The ClearCase manual says only that notes and registers are saved per case and that Backup / Restore carries all of a case's work, which the backup tests verify."],
	["S-manual-3", "manual", FIX, true, "src/routes/v/[vid]/system/manual/+page.svelte", "a case may use others", "IDR-423",
		"v5's manual lists only four ref prefixes as if complete. ClearCase gives the same four as examples and says a case may use others, so the extra bundle prefixes in the data are not contradicted; it does not list them."],
	["S-discovery_tab-3", "discovery_tab", FIX, false, "src/routes/v/[vid]/bundles/discovery_tab/+page.server.ts", "const t = (field: string) => viewText(vc, 'discovery_tab', field);", null,
		"v5 hard-codes the case caption, deed titles, schedule ranges and file names in its renderer. ClearCase reads them from the imported package's view content, so none remain in code."],
	["S-discovery_tab-4", "discovery_tab", FIX, false, "src/lib/views/bundles/discovery.ts", "v5's markup, every value escaped", null,
		"v5 inserts caption strings and file metadata into generated HTML unescaped. ClearCase escapes every value in the cover page, the bundle index and the printed index."],
	["S-discovery_tab-5", "discovery_tab", GAP, true, "src/lib/views/bundles/state.svelte.ts", "survive navigating away and back within", null,
		"v5 keeps the schedule/bundle sub-view across navigation, so returning shows the bundle view. ClearCase keeps this deliberately: the sub-view, filter and only-unmatched flag persist for the session. Resetting them on entry would need an app change."],
	["S-discovery_tab-6", "discovery_tab", FIX, false, "src/routes/v/[vid]/bundles/discovery_tab/+page.svelte", "const shown = $derived(filterItems(items, ds.q, ds.onlyMissing));", null,
		"v5 assigns an undeclared global for its filter debounce. ClearCase has no counterpart of this v5 code: filtering is a derived value of the filter state and needs no debounce timer."],
	["S-discovery_tab-7", "discovery_tab", FIX, false, "src/routes/v/[vid]/bundles/discovery_tab/+page.svelte", "href={data.files[ref]} target=\"_blank\" rel=\"noopener\"", null,
		"v5 open links have no target, so a non-PDF would replace the app page. ClearCase opens served files in a new tab with noopener, so app state is never lost."],
	["S-discovery_tab-8", "discovery_tab", GAP, true, "src/routes/v/[vid]/bundles/discovery_tab/+page.svelte", "id=\"ds-empty\" disabled={off} onclick={clearSel}", null,
		"v5 shares one selection across both schedules keyed by file, and Empty bundle clears it without asking. ClearCase keeps that: one selection across both schedules, and Empty bundle unticks every selected file with no confirmation. Changing it would need an app change."],
	["S-discovery_tab-9", "discovery_tab", FIX, false, "src/lib/views/bundles/discovery.ts", "export interface ModeMeta { deed: string | null; schedule: string | null", null,
		"v5 defines a range that is never used. ClearCase has no counterpart of this v5 code: its per-schedule metadata holds only the values the page and exports use, all from the package."],
	["S-court_bundle_tab-4", "court_bundle_tab", FIX, true, "tests/system/stores-21.test.ts", "key: 'ess_dcs_bundle_header_v2',", "IDR-413",
		"v5 moved the header key but left the old one in its backup list, so the index header was neither backed up nor restored. ClearCase stores the header as a registered table, and a test shows the header reads back identically after restore."],
	["S-court_bundle_tab-9", "court_bundle_tab", FIX, true, "src/lib/views/bundles/links.ts", "documentRoute(vid, r.ref, page)", null,
		"v5 opens source-part links with a page fragment in a new tab while page-1 parts open in the viewer. ClearCase resolves every part link to the in-app document route with the page, so all behave the same."],
	["S-court_bundle_tab-10", "court_bundle_tab", FIX, false, "src/lib/views/bundles/court.ts", "export const indexFileName = (b: Pick<Bundle, 'no' | 'name'>)", null,
		"v5 carries dead code and unused constants. ClearCase has no counterpart of this v5 code: the court bundle rules in this module hold only what the page, the Word export and the tests use."],
	["S-court_bundle_tab-11", "court_bundle_tab", FIX, false, "src/routes/v/[vid]/bundles/court_bundle_tab/+page.server.ts", "docxCreator: t('docxCreator')", null,
		"v5 hard-codes case content in the bundle renderer: the extracts figure and notes, the narrative, header examples, the document creator and the all-indexes file name. ClearCase reads each of them from the package's view content, with generic fallbacks."],
	["S-court_bundle_tab-13", "court_bundle_tab", FIX, true, "src/routes/v/[vid]/bundles/court_bundle_tab/+page.server.ts", "if (deleteStep(f, 'clear') !== 'confirm')", null,
		"v5 Restore matter defaults and Clear all overwrite the header without confirmation. ClearCase asks first: the button shows Confirm restore or Confirm clear and Cancel inline, says when unsaved typed fields are discarded too, and only the confirmation replaces the stored header, which the page then reloads. The server refuses Restore or Clear without it. A Retry after a failed Restore or Clear posts with the confirmation already given, and asks again only when typed fields would be lost."],
	["S-caselines_tab-1", "caselines_tab", FIX, true, "src/routes/v/[vid]/bundles/caselines_tab/+page.svelte", "href={u.url} download={u.name}>Download</a>", null,
		"v5 session-upload Open links navigate the app tab to the blob and lose state. ClearCase offers a Download link for a download-only copy of the upload, so the app page is never replaced."],
	["S-caselines_tab-2", "caselines_tab", FIX, false, "src/routes/v/[vid]/bundles/caselines_tab/+page.server.ts", "vc.number('caselines_tab', 'pageCountFallback')", null,
		"v5 hard-codes the bundle name, path, fallback page count and reference and ignores the index file field. ClearCase takes the name, address and fallback page count from the package's view content, and the page count from the index first."],
	["S-caselines_tab-3", "caselines_tab", FIX, true, "tests/system/stores-21.test.ts", "key: 'ess_dcs_caselines_docs_v1',", "IDR-413",
		"v5 does not back up the linked documents. ClearCase stores them as a registered table, and a test round-trips them through backup and restore."],
	["S-caselines_tab-4", "caselines_tab", GAP, true, "src/routes/v/[vid]/bundles/caselines_tab/+page.svelte", "{NOT_SERVED}</span>{/if}<button type=\"button\" class=\"rm\"", null,
		"v5 re-encodes typed link paths into broken links with no check. ClearCase stores the typed path, links it only when it names an indexed document, and otherwise marks it not served; it does not remove duplicate links, which the defect also names; that would need an app change."],
	["S-caselines_tab-5", "caselines_tab", GAP, true, "src/lib/views/bundles/caselines.ts", "if (count) res.push({ p, count, ...snippet(t, first, q.length) });", null,
		"v5 applies match offsets from lower-cased text to the original, shifting the highlight for characters whose case change alters length. ClearCase keeps this: the same offsets are applied to the original text. Fixing it would need an app change."],
	["S-caselines_tab-6", "caselines_tab", FIX, false, "src/routes/v/[vid]/bundles/caselines_tab/+page.svelte", "URL.revokeObjectURL(u.url)", null,
		"v5 never revokes the blob URL of a removed upload, holding its memory until reload. ClearCase revokes the object URL when the upload is removed."],
	["S-caselines_tab-7", "caselines_tab", GAP, true, "src/routes/v/[vid]/bundles/caselines_tab/+page.svelte", "const h = n >= 1 ? bundleHref(n) : null", null,
		"v5 Go to page has no upper bound check beyond the max attribute. ClearCase keeps this: it opens any page number of at least one. Clamping or refusing a page above the page count would need an app change."],
];

const owners = Object.fromEntries(VIEWS.map((v) => [v.id, v.owner]));
const linear = Object.fromEntries(VIEWS.map((v) => [v.id, v.linear]));
const files = registerFiles(join(REF, 'parity', 'intentional-differences.json'));
const docs = new Map(files.map((f) => [f, JSON.parse(readFileSync(f, 'utf8'))]));
const fileOf = (view) => {
	const owner = owners[view];
	if (!owner) throw new Error(`unknown view ${view}`);
	return RANGES[owner] ? files.find((f) => f.endsWith(`${owner}.json`)) : files[0];
};
const rangesOf = (file) => (file === files[0] ? [MAIN_RANGE] : RANGES[file.match(/(CC-\d+)\.json$/)[1]]);

const all = [...docs.values()].flatMap((d) => d.entries);
const own = new Map(all.filter((e) => e.author === AUTHOR).map((e) => [e.source, e]));
const previous = new Map([...own].map(([source, e]) => [source, e.id]));
const taken = new Set(all.filter((e) => e.author !== AUTHOR).map((e) => e.id));
const reviewed = new Map(all.filter((e) => e.author !== AUTHOR).map((e) => [e.id, e]));
const { defects: listed, unparsedRows } = readDefects(REF);
// a defects.md row that does not parse is a defect nobody can see: fail, as dispositions.mjs does
const problems = unparsedRows.map((r) => `defects.md row ${r} does not parse (fewer than 8 cells); fix the row`);
const lostApproval = [];
// an approval covers a type, a visibility and a reason; the evidence file:line moves without reopening it
const noEvidence = (reason) => String(reason ?? '').replace(/\s*Evidence: .*$/, '');
const seen = new Set();
const out = new Map(files.map((f) => [f, []]));
const idOf = (file, defect) => {
	const keep = previous.get(defect);
	const ranges = rangesOf(file);
	const n = keep ? Number(keep.slice(4)) : null;
	if (n !== null && ranges.some(([lo, hi]) => n >= lo && n <= hi) && !taken.has(keep) && !RETIRED.has(keep)) return keep;
	for (const [lo, hi] of ranges) {
		for (let i = lo; i <= hi; i++) {
			const id = `IDR-${String(i).padStart(3, '0')}`;
			if (!taken.has(id) && !RETIRED.has(id) && ![...previous.values()].includes(id)) return id;
		}
	}
	throw new Error(`${defect}: no free id in ${ranges.map(([lo, hi]) => `IDR-${lo}–IDR-${hi}`).join(', ')}`);
};
for (const [named, view, type, productVisible, file, patterns, cover, why] of DISPOSITIONS) {
	const defects = [named].flat();
	const defect = defects[0];
	for (const d of defects) if (!isListed(listed, d)) problems.push(`${d}: no such defect in defects.md or view-checklist.md; delete or retarget its disposition`);
	for (const d of defects) { if (seen.has(d)) problems.push(`${d}: listed twice`); seen.add(d); }
	if ([patterns].flat().length !== defects.length) { problems.push(`${defect}: one evidence pattern per defect`); continue; }
	const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
	const at = [patterns].flat().map((pattern) => {
		if (typeof pattern !== 'string' || !pattern.trim()) { problems.push(`${defect}: empty evidence pattern for ${file}`); return 0; }
		const i = lines.findIndex((l) => l.includes(pattern));
		if (i < 0) problems.push(`${defect}: evidence pattern not found in ${file}: ${JSON.stringify(pattern)}`);
		return i + 1;
	});
	if (at.includes(0)) continue;
	if (cover && !reviewed.get(cover)?.field?.length) problems.push(`${defect}: covering entry ${cover} is not a reviewed entry with a field`);
	const reason = `${why}${cover ? ` Parity sees the change: ${cover}.` : ''} Evidence: ${file}:${at.join(', ')}.`;
	if (reason.length > 600) problems.push(`${defect}: reason is ${reason.length} characters, over 600`);
	const target = fileOf(view);
	const id = idOf(target, defect);
	taken.add(id);
	// a known gap names the owner whose app change would close it
	const before = own.get(defect);
	// an approval the user gave in review survives a rerun while what it approved is unchanged; otherwise it is reset
	const unchanged = before && before.view === view && before.type === type && before.productVisible === productVisible && noEvidence(before.reason) === noEvidence(reason);
	if (before?.approvedBy && !unchanged) lostApproval.push(`${before.id} (${defect})`);
	out.get(target).push({ id, view, field: [], type, source: defect, ...(type === GAP ? { owner: linear[view] } : {}), reason, productVisible, author: AUTHOR, approvedBy: unchanged ? before.approvedBy ?? null : null, approvedOn: unchanged ? before.approvedOn ?? null : null });
}
// a hand-written disposition (an empty field in any form: [], '', null or absent) of a defect no longer listed is as stale as a row of the table
const isDisposition = (e) => !e.field || (Array.isArray(e.field) ? !e.field.length : !String(e.field).trim());
for (const e of all) if (e.author !== AUTHOR && isDisposition(e) && /^S-/.test(e.source ?? '') && !isListed(listed, e.source)) problems.push(`${e.id}: disposition of ${e.source}, which defects.md and view-checklist.md no longer list`);
// every listed defect needs an entry naming it, from the table or from another entry (the rule dispositions.mjs reports)
const written = [...all.filter((e) => e.author !== AUTHOR), ...[...out.values()].flat()];
for (const id of listed.keys()) if (!citing(written, id).length) problems.push(`${id}: no disposition; add a row to DISPOSITIONS`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
if (lostApproval.length) console.error(`register-dispositions: approval reset (view, type, productVisible or reason changed): ${lostApproval.join(', ')}`);

let drift = 0;
for (const [file, doc] of docs) {
	const next = { ...doc, entries: [...doc.entries.filter((e) => e.author !== AUTHOR), ...out.get(file)] };
	const body = JSON.stringify(next, null, 2) + '\n';
	if (body === readFileSync(file, 'utf8')) continue;
	drift++;
	if (process.argv.includes('--check')) console.error(`register-dispositions: ${file} differs; rerun without --check`);
	else writeFileSync(file, body);
}
let tableDrift = 0;
if (process.argv.includes('--check')) {
	const tableAt = process.argv.indexOf('--table');
	const table = tableAt > 0 ? resolve(process.argv[tableAt + 1]) : join(ROOT, 'docs', 'acceptance', 'CC-11', 'defects-table.md');
	const generated = spawnSync(process.execPath, [join(ROOT, 'scripts', 'verify', 'dispositions.mjs')], { encoding: 'utf8' });
	if (generated.status !== 0) { console.error(generated.stderr); tableDrift = 1; }
	else if (generated.stdout !== readFileSync(table, 'utf8')) { console.error(`register-dispositions: ${table} differs from generated defects table`); tableDrift = 1; }
}
const count = (k) => Object.entries(DISPOSITIONS.reduce((a, r) => ((a[k(r)] = (a[k(r)] ?? 0) + 1), a), {})).map(([t, n]) => `${t} ${n}`).join(', ');
console.log(`register-dispositions: ${seen.size} defects in ${DISPOSITIONS.length} dispositions (${count((r) => r[2])}; by owner ${count((r) => owners[r[1]])}); ${drift} file(s) ${process.argv.includes('--check') ? 'differ' : 'written'}`);
process.exit(process.argv.includes('--check') && (drift || tableDrift) ? 1 : 0);
