# Results package contract (formatVersion 1)

GRS-10 (CC-02). A results package is the versioned, inspectable output of processing one case: datasets, an index of the originals they cite, and identities that bind both. This page is the contract. GRS-12 (CC-03) builds the local app on the library exports named in [Library API](#library-api), and GRS-11 (CC-23) gates it. Words follow [GLOSSARY.md](../GLOSSARY.md).

The v5 sample (1,689 documents) converts to 37 files: 35 datasets, `assets.json` and `manifest.json`, 6.2 MB in total (largest file 1.8 MB). Originals are never copied into a package. They stay in the operator's case folder and are matched by relative path, sha256 and size.

## Layout

```
<package>/
  manifest.json            identity, provenance and the list of every other file with its sha256 and size
  assets.json              ref -> original: path, sha256, size, media type, text status, parent
  datasets/<key>.json      one dataset per file: envelope + data
```

- Only `manifest.json` and the files it lists are read. Any other file is reported (`PKG_UNLISTED_FILE`, warning), never read and never imported. A producer-supplied baseline or acknowledgement inside a package has no effect.
- `<key>` matches `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (at most 64 characters). Lower case only, so keys cannot collide on case-insensitive filesystems.
- Symlinks, devices and FIFOs anywhere in a package directory are errors (`PKG_SYMLINK`, `PKG_SPECIAL_FILE`).
- A `.zip` of the same layout is an accepted transport ([Zip transport](#zip-transport)); it is decoded in memory and validated exactly like a directory.
- A caller may also pass the files as bytes keyed by package-relative path. This is how GRS-12 re-imports the bytes it stored.

## Canonical JSON

Two encodings of one value space (null, booleans, finite numbers with integers in ±(2^53−1), well-formed strings, arrays, plain objects, at most 32 nested containers):

- **Identity encoding**: compact RFC 8785 (JCS). Object keys sorted by UTF-16 code units, no whitespace, numbers in ECMAScript `Number::toString` form, strings escaped only as JCS requires (`"`, `\`, and U+0000 to U+001F, using `\b \t \n \f \r` where defined, `\u00xx` otherwise). Every identity digest hashes this encoding.
- **File encoding**: the same order and escaping, two-space indentation, LF line ends and exactly one final newline, UTF-8 without a byte order mark. Every package file must be byte-identical to the file encoding of its parsed value (`PKG_NONCANONICAL`, error), so packages diff cleanly and rebuild byte for byte.

The serializer (`canonical.ts`) is written by hand; `JSON.stringify` is never applied to objects, because it emits integer-like keys (`"9"`, `"10"`) in numeric order. Integer-valued numbers above 2^53−1 (for example `1e21`) are refused by the parser and the serializer alike. A producer in another language must reproduce both encodings exactly: `scripts/case-package/canonical.py` is an independent Python reproduction (UTF-16 key order, ES number form) and reproduces every file of the v5 package byte for byte. Plain `json.dumps(sort_keys=True)` orders keys by code point and writes Python float forms; it happens to match the v5 data but is not a conforming producer.

Parsing is strict (`strict-json.ts`): duplicate keys (also escape-equivalent ones), a byte order mark, invalid UTF-8, lone surrogates (raw or escaped), comments, trailing commas or data, `NaN`/`Infinity`, out-of-range numbers and unsafe integers are errors. A `__proto__` key becomes an inert own property. Depth, string length, keys per object, items per array and values per file are bounded before recursion.

## Manifest

The manifest is closed: an unknown top-level or nested field is `PKG_MANIFEST_INVALID`. Extensions go only under `extensions["x-<name>"]` and are preserved, ignored and never rendered. Schema: `src/lib/case-package/schema/manifest.schema.json`.

| Field | Meaning |
| --- | --- |
| `format` | `clearcase.results-package`; anything else is `PKG_NOT_A_PACKAGE` |
| `formatVersion` | integer `1`, must-understand, the only package version |
| `case.id` | operator-assigned case slug `^[a-z0-9][a-z0-9._-]{0,63}$`, chosen when the case is set up; never derived from content |
| `case.label` | optional display label (untrusted text) |
| `inputRevision.id` | `sha256:` digest of the input files ([Identity](#identity)) |
| `inputRevision.kind` | how the input was produced: `v5-workspace-html`; later `pipeline-run`, `markdown-roundtrip` |
| `inputRevision.sources[]` | `{role, name, sha256, size}` of each exact input file; `name` is provenance only |
| `inputRevision.claims` | source-declared facts kept as provenance (`builtAt`, `docCount`); never trusted for counts |
| `resultsVersion` | `sha256:` content identity ([Identity](#identity)) |
| `parent` | the `resultsVersion` this one derives from (Markdown round trip, re-run), or `null` |
| `producer` | `{name, version}` of the converter |
| `created` | deterministic, from the input (v5: `META.builtAt`, local time without zone), never the clock |
| `files[]` | sorted by path: `{path, role: dataset\|assets, key, kind, schema, required, count, sha256, size}` (dataset entries carry all of them) |
| `extensions` | optional `{ "x-…": any }` |

**Version policy.** `format` and `formatVersion` are checked before any shape check. Any other `formatVersion` (2, `"1"`, a missing field, an old `schemaVersion: "1.0"`) gives exactly one actionable error, `VER_UNSUPPORTED`, and no candidate. A change that an older reader could misread is a new `formatVersion`. Datasets version independently: `schema` is `name@major`. A reader that does not know a dataset's schema rejects the package when the dataset is `required` (`DS_SCHEMA_UNSUPPORTED`) and otherwise keeps it bounded, preserved and unrendered (`DS_UNKNOWN_SCHEMA`, warning). Diagnostic codes are stable; a severity may only be raised in a new `formatVersion`.

## Identity

| Identity | Definition | Covers | Excludes |
| --- | --- | --- | --- |
| `inputRevision.id` | `'sha256:' + sha256(compactJcs(sorted [{role, sha256, size}]))`, sorted by role, sha256, size | the exact input bytes | file names |
| `resultsVersion` | `'sha256:' + sha256(compactJcs({format, formatVersion, caseId, inputRevisionId, files}))`, `files` sorted by path as `{path, role, key, kind, sha256, size}` with absent optional fields omitted | every byte of every dataset and of the asset index, hence every original's sha256 | case label, `created`, producer, parent |
| `manifestSha256` | sha256 of the exact `manifest.json` bytes | label, created, producer, parent, source names | n/a |

- A renamed HTML, another output directory, concurrency, `TZ`/`LANG`, an unrelated file in the case folder and a producer patch release do not change `resultsVersion`. One changed narrative character or one changed original byte does. Only the adapter's major mapping id (`clearcase-v5-adapter@0`) enters dataset bytes; the full producer version is in `manifest.producer`.
- `manifestSha256` is pinned next to `resultsVersion` in every candidate, acknowledgement, sign-off and publication record, so provenance fields cannot change after review without detection.
- The whole case folder is never hashed. Only referenced originals are, and their identity is sha256 + size.
- **Routes.** Importers identify a version by `resultsVersion` (`sha256:<64 hex>`), URL-encoded in routes: the pilot document route is `/v/<encodeURIComponent(resultsVersion)>/doc/<encodeURIComponent(ref)>` (`documentRoute()` in `render.ts`). The interim prototype's id rule (1 to 64 characters, no colon) does not apply.
- **Refs are package-local aliases.** A ref such as `OD-001` names a document within one package only. Refs are never equated across independently built packages; documents are matched by fingerprint ([User work](#user-work-seeds-and-anchors)). In the v5 package, 67 sha256 values are shared by more than one ref, so a ref and its content are not 1:1.

## Datasets

Each dataset file is an envelope (schema `dataset-envelope.schema.json`):

```json
{ "envelope": "clearcase.dataset/1", "key": "chronology", "kind": "generated", "schema": "v5.chronology@1",
  "required": true, "count": 1689,
  "provenance": { "source": "v5-workspace-html", "sourcePath": "DATA.chronology", "adapter": "clearcase-v5-adapter@0" },
  "data": "<the source value, unchanged>" }
```

- `data` holds the source value unchanged: no renamed fields and no normalised dates, amounts or text. Only key order changes (canonical form); `source-layout` records the original key order, and the four v5 roots reassemble losslessly (`v5/reassemble.ts`).
- `count` is the array length or number of object keys. Manifest count, envelope count and actual count must agree (`DS_MANIFEST_MISMATCH`, `DS_COUNT_MISMATCH`, errors).
- Every recognized dataset is shape-checked against its committed data schema (`schema/data.<schema>.schema.json`, generated from `records.ts`). A record that breaks it is `DS_SHAPE_INVALID` (error). A field the schema does not name is preserved and reported once per field and location (`DS_UNSUPPORTED_FIELD`, warning, not rendered).
- A registered dataset key must carry its registered schema and `required` flag; relabelling it (for example `chronology` as `opaque@1`) is `DS_SCHEMA_UNSUPPORTED`, so a recognized dataset can never skip its shape check. `readCandidate().dataset()` returns typed data only for recognized schemas.
- `chronology` is required (`DS_REQUIRED_MISSING`). Its `ref` values must match `^[A-Z]{1,8}(?:-[A-Z][A-Z0-9]{0,7})?-[0-9]{1,8}$` (`OD-001`, `DC-FLX-001`; `ID_REF_INVALID`) and be unique (`ID_DUPLICATE`); a row without a ref is invalid. `text_status` outside `extracted|ocr|none|pending` is `DS_ENUM_UNKNOWN`. A well-formed date that is not a calendar date is `DS_DATE_INVALID` (warning; the value is kept).
- Source metadata is preserved, never trusted for counts. Displayed counts are derived from validated records (`readCandidate().derivedCounts()`), and each disagreement between `META` and the records is `V5_META_COUNT_DISAGREEMENT` (warning). The v5 sample has exactly two: `META.textNone` 237 against 255 rows with text status `none`, and `META.emails` 469 against 629 e-mail rows.

### Generated data and authored analysis

**Generated** datasets are reproducible from the originals by the pipeline: the document register, people, entities, quantum series, contracts and filings registers, bundles, schedules, the CaseLines page index, the build report and source metadata. Code-embedded view content (`view-content`, [below](#view-content-code-embedded-case-content)) is generated too. They change only by re-running the pipeline, which makes a new results version. **Authored** datasets are analysis written by people: matter, risk matrix, defence matrix, info required, witnesses, contradictions, timeline events and phases, and every `lit.*` table. The split follows the raw-review field inventory (`machine_built` against the hand-authored overlay the v5 app merges at runtime).

Only authored datasets carry inline citation tokens (`[[REF]]`, `[[REF#p<page>]]`), bare-mention detection (`CITE_BARE_MENTION`, info) and, later, Markdown editing. The Markdown round trip is roadmap work (GRS-23). That ticket requires a risk-analysis example that generates Markdown from metadata/data and parses edited Markdown into structured results, validates citations against the chosen case version, and preserves generated document indexes and machine-derived facts. This library imports and converts packages; it does not implement that round trip. Both kinds are immutable results once imported, and neither may contain user work.

### v5 dataset registry

| key | v5 source | kind | key | v5 source | kind |
| --- | --- | --- | --- | --- | --- |
| `chronology` | `DATA.chronology` | generated | `lit-enforcement` | `DATA.lit.enforcement` | authored |
| `people` | `DATA.people` | generated | `lit-legality` | `DATA.lit.legality` | authored |
| `entities` | `DATA.entities` | generated | `lit-authorities` | `DATA.lit.authorities` | authored |
| `matter` | `DATA.matter` | authored | `lit-elements` | `DATA.lit.elements` | authored |
| `quantum` | `DATA.quantum` | generated | `lit-crossexam-seed` | `DATA.lit.crossexam_seed` | authored |
| `risk-matrix` | `DATA.riskMatrix` | authored | `lit-prescription` | `DATA.lit.prescription` | authored |
| `defence-matrix` | `DATA.defenceMatrix` | authored | `lit-presc-summary` | `DATA.lit.prescSummary` | authored |
| `info-required` | `DATA.infoRequired` | authored | `lit-interest-basis` | `DATA.lit.interestBasis` | authored |
| `witnesses` | `DATA.witnesses` | authored | `lit-recon` | `DATA.lit.recon` | authored |
| `build-report` | `DATA.buildReport` | generated | `lit-settlement` | `DATA.lit.settlement` | authored |
| `link-sample` | `DATA.linkSample` | generated | `bundles` | `DATA.bundles` | generated |
| `timeline-events` | `DATA.timeline.events` | authored | `meta` | `META` | generated |
| `timeline-phases` | `DATA.timeline.phases` | authored | `discovery-schedules` | `window.__SCHED__` | generated |
| `timeline-year-counts` | `DATA.timeline.yearCounts` | generated | `caselines-index` | `window.__CASELINES_IDX__` | generated |
| `timeline-type-by-year` | `DATA.timeline.typeByYear` | generated | `source-layout` | key order of the v5 roots | generated |
| `contracts` | `DATA.contracts` | generated | `conversion-report` | adapter diagnostics, payload line numbers, ignored code literals (optional) | generated |
| `filings` | `DATA.filings` | generated | `v5-residual-<path>` | any unmapped `DATA` key (`V5_UNMAPPED_KEY`), schema `opaque@1`, optional | generated |
| `contradictions` | `DATA.contradictions` | authored | `view-content` | literals in the viewer code, read statically ([below](#view-content-code-embedded-case-content)), optional | generated |

Every v5 dataset schema is `v5.<key>@1` and `required: true`, except `conversion-report`, `view-content` and residual datasets. Court-bundle item keys (`bundles.list[].items`, `rows[].key`, `catalogue` keys such as `OD-10`) are a separate namespace and are never resolved as document refs. App code literals (`NAV`, `IC`, `STORE_KEYS`, `ENF_OPTS`, `CBK`, `CBPH`, `CBHF`) are viewer code, not results; they are listed as ignored in `conversion-report`. The case content inside viewer code (for example `CBHF`'s example values or the discovery caption `CAP`) is carried by `view-content`.

### View content: code-embedded case content

GRS-38. In the v5 sample, 28 of the 42 views show case content that the renderers hard-code instead of reading `DATA`: subtitles, KPI captions, narrative paragraphs, the case caption, deed titles and schedule ranges, file names (export files carry a case prefix), CSV header keys that carry the parties' abbreviations, the CaseLines file's name, path and fallback page count, form examples and defaults. GRS-9 catalogued each item in `docs/reference/view-checklist.md`. The sample was generated by an AI pipeline, so in the real pipeline this content is pipeline output: ClearCase imports it as the dataset `view-content` (schema `v5.view-content@1`, kind `generated`, `required: false`, provenance `sourcePath` `(view-code)`) and the views render it from imported data.

- **Classification.** Generated: reproducible from the case material by the pipeline like the other generated datasets, never edited by people, without inline citation tokens. A later pipeline writes it directly; for v5 the adapter reads it from the viewer code.
- **Shape.** `data` maps a view id (the v5 navigation id, or `_shell` for the page title and brand) to named fields. A field value is plain text, a number, a list of texts, or a template `{"template": [text | {"param": name}]}` whose params the view fills from imported data (for example `docCount` from the derived document count). View ids match `^_?[a-z][a-z0-9_]{0,63}$`, field ids and param names `^[a-z][A-Za-z0-9]{0,63}$`. Every string is untrusted text: put it in a text node, or pass a narrative through `renderNarrative()`. Markup in the v5 literals is reduced to text at conversion (tags dropped, entities decoded, paragraphs separated by a blank line, the `renderNarrative` convention). Field ids that the validator treats specially keep their checks: `url` is link-checked like any other link field, in every form: a string, each list item, and a template's literal text with every param left empty. `readViewContent` applies the same link policy and never returns a value the policy rejects, also after filling a template. Hidden characters (C0 and C1 controls, every default-ignorable code point and the interlinear annotation controls) give `TEXT_CONTROL_CHARS` and are revealed by `revealInvisible`, as in every dataset.
- **Extraction (v5).** The adapter reads the HTML as text and never executes it. `v5/js-scan.ts` tokenizes the script blocks (strings, templates, regex literals, numbers, identifiers, punctuators; the four payload lines are cut out first) and `v5/view-content.ts` applies the declarative map in `v5/view-content-map.ts`. Each map entry names a view id, a field id, its checklist evidence (`S-<view>-N` ids and v5 line numbers), a scope found by code shape (`RENDER.<view>`, a named function, a constant, or the static page markup), a selector (call argument, array or object literal path, `return` value, `x \|\| <default>`, a structural pattern over literals, or an element, attribute or element list in the markup the scope builds), the value kind, the expected template params with the source expression each must read, and whether the field is required. Anchors never match case text, and the committed map holds ids, anchors and checklist references only.
- **Missing or ambiguous anchors** are never guessed. A required field whose anchor is absent, or whose value has another shape (code where text is expected, a different number of interpolations, an interpolation that is not exactly the expected source expression, token for token) is `V5_VIEW_CONTENT_MISSING` (warning); an anchor that matches more than once is `V5_VIEW_CONTENT_AMBIGUOUS` (warning). A function or constant scope defined more than once, or an object key given twice, is ambiguous; A `RENDER.<view>` renderer must be proven live, even when it is assigned once: every assignment must be a whole statement (after `;`, `}` or the start of its script or block, ending at `;`, `}` or the end of its script) that runs unconditionally, at top level or at the top level of an immediately invoked function whose wrapper is itself such a statement, with no `return` or `throw` before it in its block or in any block nested in it (a braced `if`, `else`, `try`, `catch`, `finally`, `switch`, loop, label or plain block). A `return` or `throw` inside a nested function, arrow or method stays in that function, and `break` or `continue` never leave a function. Unbraced control flow (`if (…) RENDER.x = …`, `else`, loop heads, labels), short circuits (`c && (RENDER.x = …)`), ternaries and commas count as conditional. `RENDER.<view>` then takes its last assignment, the live renderer (v5 assigns `discovery_tab` twice, the second in an IIFE). A single assignment that may never run is missing; a repeated `RENDER.<view>` with any such assignment, or with a later assignment that is not a function body (`RENDER.x = other`, `&&=`), is ambiguous. No value is guessed from either. A template needs literal text, and a value holding a reserved private-use character (U+E000 to U+E004, the extractor's markers) is refused, whichever selector read it. The scan is linear in the size of the HTML; viewer code over 8 Mi characters (an HTML over 16 Mi), or extraction past a 20 s deadline, stops it: `V5_VIEW_CONTENT_LIMIT` (warning) and an empty `view-content` (fails closed). Either leaves the field out, and the view shows it as unavailable. An HTML without viewer code yields a `view-content` holding only the page title.
- **Coverage.** The map extracts 101 fields from 28 views and the shell (BASE-R2 added the export file names of the chronology, search, contracts, filings, filing register, contradictions, Defence, invoice (for the quantum and ledger views), prescription, payments, deadlines calendar, authorities, heads, rescan index and backup exports, the Defence CSV keys and the filings register introduction); nine catalogued items are recorded as deliberate omissions with a reason (`VIEW_CONTENT_OMISSIONS`). Every renderer of the 42 views and every mapped scope is audited for prose literals (8 words or more) that no entry consumed. They are listed by scope and line, never by text, in the `viewContent` member of the `convert --report` file, not as diagnostics, so the other datasets of a known HTML stay byte-identical. On the v5 sample 39 remain, all reviewed as UI chrome or app documentation.
- **Identity.** Adding the dataset changed no other file of the v5 sample: the manifest without the `view-content` entry, and with the package files (GRS-45, `P-` keys) left out of `assets.json`, gives the accepted GRS-10 `resultsVersion` `sha256:acc6faf6dc67d3d5093a32e327ee303802d891c7541bd79f4feefb5afca8c63a`; with both, the v5 sample's `resultsVersion` is `sha256:a35fd326bacf0234c43454a90a8f82e63cf2adc10544f4d42b720e24f0c0f58e` (`inputRevision.id` and the diagnostics identity unchanged). `verify:package` lane 11 checks this. GRS-45 moved it from `sha256:935abfe9aff259c71494a52783fb5a54ee6e1b15b12a2fa8d86858d595b25ff1` once, for the 57 package files and the two `legality_tab` fields together. A map change that adds or changes fields changes only `datasets/view-content.json` and the manifest, and so this identity: the locators' `acceptedViewContent.resultsVersion` is updated with it (`docs/development.md`, Verification). BASE-R2's fields moved it from `sha256:5cc89c8b0d1440ec7c834747da0fd4e8df874be8c38706693f9f9732c398ba5e`, with every earlier field byte-equal.

#### Adding a view (M2 owners)

Read code-embedded content from the dataset, never from literals in the app:

```ts
import { readViewContent, renderNarrative } from '$lib/case-package/browser';
const vc = readViewContent(datasetOf(store, resultsVersion, 'view-content'));
const subtitle = vc.fill('timeline', 'subtitle', { docCount: derived.documents }); // {text, missing} or null
const narrative = vc.text('settlement_tab', 'narrative');                           // string or null
```

- `readViewContent(data)` gives `views()`, `fields(view)`, `value`, `text`, `number`, `list`, `params(view, field)` and `fill(view, field, params)`. Absent or malformed data reads as `null`; show the field as unavailable rather than falling back to a v5 literal.
- Fill template params from imported data (derived counts, `meta`, `quantum`, …), never from constants. The map documents each param's v5 source (`expect`). `fill()` reports the params you did not supply.
- Render values as text. A narrative paragraph goes through `renderNarrative()`.
- **Export file names and CSV keys.** v5 names most exports with a case prefix: a view's `exportFileName` (and, for a second export of the same view, a named field such as `filings_tab.registerExportFileName`) is the literal first argument of the export function's one `dl(...)` call, and `vdm_matrix_tab.exportColumns` is the Defence CSV header (`head`), whose keys carry the parties' abbreviations. Read them on the server with `exportFileName(vc, view, neutral, field?)` and `exportColumns(vc, view, neutralKeys, field?)` from `src/lib/local-case/results.server.ts` (`vc` from `viewContentOf(store, rv)`). The package's value is used only when it is safe: a bare file name (no path separator, control or format character, leading dot, `..` or outer white space, at most 128 characters) with the extension of `neutral`, or exactly `neutralKeys.length` distinct keys of 1 to 64 characters without control or format characters, commas or quotes. Otherwise the result is the caller's neutral literal plus a fixed `note`; render the note as text beside the export control (`data-export-note`). Never fall back to a case value. A name v5 builds at run time (`key + '.csv'`) has no literal to anchor and is not extracted.
- The field list per view is in `v5/view-content-map.ts`. A new code-embedded value is a map entry with a code-shape anchor and its checklist reference, plus a synthetic anchor in `tests/case-package/fixtures/view-code.synthetic.js.txt`. The synthetic anchors carry invented values (`syn-…` export names); e2e tests read the expected value from the built package's `datasets/view-content.json`, and `buildCase(root, { viewCode: false })` builds a package without view-content fields to show the neutral names and notes.

### The v5 adapter

`convertV5()` reads the workspace HTML as bytes and never executes it. It slices exactly four lines anchored at the line start, `const DATA = `, `const META = `, `window.__SCHED__ = ` and `window.__CASELINES_IDX__ = `, and hands each right-hand side, minus the final `;`, to the strict parser. Distinct errors: a missing `DATA` or `META` line (`V5_PAYLOAD_MISSING`), a second assignment (`V5_PAYLOAD_AMBIGUOUS`), a computed or encoded payload such as `JSON.parse(atob(…))` (`V5_PAYLOAD_ENCODED`), and anything that is not one pure JSON literal, including trailing code or an indented or non-anchored assignment (`V5_PAYLOAD_NOT_JSON`). A leading byte order mark and CRLF line ends are tolerated in the HTML; indented payload lines are not supported yet. The newer workspace generation, which embeds its data as `<script id="app-data" type="application/json">` and `<script id="app-seed" type="application/json">` tags, is read by the same strict parser: `src/lib/case-package/v5/json-workspace.ts` maps the two documents onto the v5 roots (the chronology rows, people, entities, the seed's matters as one storyline with a heading per matter, contradictions grouped by kind, risk, defence, info required, witnesses, elements, authorities, contracts from the agreements, the bundle list, the discovery schedule, a timeline from the hot documents, and `META` with the counts the validator derives), and the rest of the pipeline is unchanged. The viewer's own `var DATA = JSON.parse(...)` line is code, not a payload; an HTML that carries both generations is refused (`V5_PAYLOAD_AMBIGUOUS`). Source fields the v5 shape has no place for stay on their records (`DS_UNSUPPORTED_FIELD`); the only key left behind is the viewer's full-text token index (`V5_SOURCE_INDEX_DROPPED`, info). No view content is read from the newer viewer code. Unknown `DATA` keys become opaque residual datasets; keys that collide after kebab-casing or truncation get a digest suffix, so nothing is dropped. The adapter fingerprints each original read-only; an original that escapes the case folder, is not a regular file, cannot be read or exceeds the bound is a conversion error (`ORIG_ESCAPE`, `ORIG_NOT_FILE`, `ORIG_UNREADABLE`, `ORIG_TOO_LARGE`), never a missing asset, and conversion writes nothing.

The same builder has a newer generation: META carries `version` (`V1`) and `fileCount`, DATA carries a `profile`, several dataset shapes differ and new datasets appear (the 2,131-document ESS export of 22 September 2026, the one the hosted app shows). `extractV5` records it as the generation `v5-js-newer`, and `src/lib/case-package/v5/newer-workspace.ts` maps its shapes onto the v5 datasets as pure functions before the dataset loop. META gains the invoice count, date span and document-type tallies from the rows where the source has none. The matter is the profile's narrative under plain headings, the parties first. The quantum series, the link sample and the build report take each row's filename from its chronology row, else the row's own title. A contract item takes its chronology row's `doc_type` and the builder's own `signed` reading as its note. Filings gain a group note, an item role and the v5 seed field names. Bundles gain their slug, page and item counts and each row's `from` (written `frm`); the CaseLines sections are keyed by section number with the physical page range as `from`/`to`, and the extracts list moves to `extractFiles`. The page-to-text map becomes the caselines index. The list of discovery schedules becomes the discovery (Original) and supplementary lists, with the full list kept under `schedules`. The interest basis and the settlement take the quantum headline as figure and date, and the first invoice date is the earliest ledger invoice. Every other source field stays on its record (`DS_UNSUPPORTED_FIELD`), and the new datasets (`anchors`, `emails`, `organogram`, `profile`, `text`, `transcripts`, `whatsapp`) are residual until a view reads them.

The demotion rule guards every generation: before writing, the adapter checks each mapped dataset against its schema, and one that misses is kept as the opaque dataset `v5-residual-<key>` with the warning `V5_DATASET_SHAPE_UNMAPPED` naming the first failure (in the newer export, the empty `lit.prescSummary`). The package then validates with a REPORT verdict and the dataset's view shows its empty state instead of the case failing to import. The required dataset (`chronology`) is never demoted, so a broken register still refuses.

## Asset index and originals

`assets.json` (schema `assets.schema.json`) maps asset keys to originals:

```json
{ "index": "clearcase.assets/1", "root": "case-folder", "assets": {
  "OD-001":     { "kind": "file", "path": "DISCOVERY A/x.pdf", "sha256": "…", "size": 123, "mediaType": "application/pdf", "textStatus": "extracted" },
  "EM-0001.a2": { "kind": "embedded", "parentRef": "EM-0001", "ordinal": 2, "member": "image001.png", "mediaType": "image/png", "textStatus": "unsupported" },
  "AT-001":     { "kind": "file", "path": "_attachments/EM-0001/quote.pdf", "sha256": "…", "size": 9, "mediaType": "application/pdf", "textStatus": "pending", "parentRef": "EM-0001" },
  "OD-777":     { "kind": "missing", "path": "DISCOVERY A/gone.pdf", "mediaType": "application/pdf", "textStatus": "pending" },
  "P-0c1d2e3f4a5b6c7d": { "kind": "file", "path": "BUNDLES/Bundle A.pdf", "sha256": "…", "size": 456, "mediaType": "application/pdf", "textStatus": "pending" } } }
```

- Keys are register refs or `<parentRef>.a<ordinal>` (1-based) for attachments still inside their container; the ordinal keeps repeated member names distinct (v5 has 49 duplicates within one parent). A register ref can never take the `.aN` form, so it cannot overwrite an attachment key.
- **Package files** (GRS-45) are the files the bundle views link outside the register: each bundle's PDF and index PDF, each item's extract and source parts, the CaseLines source and every discovery and supplementary schedule file. Each is a `file` or `missing` asset under the key `P-<first 16 hex digits of sha256(path)>`, where `path` is the decoded locator path. A ref has at most eight digits, so a package-file key is never a ref. The converter skips register paths (also after case and NFC folding), folders and locators that do not decode, and fingerprints the rest under the same escape, reserved, bound and sha256 rules as a register original. A package-file key that is not the digest of its path, an `embedded` one and one with a `parentRef` are `ID_REF_INVALID`. Package files are not documents: they raise no `ASSET_ORPHAN` and no text-status diagnostics, and they are not candidates for fingerprint re-anchoring. The originals site serves them at `/o/<resultsVersion>/<key>` like any verified original.
- `file`: an original in the case folder, at a literal (not percent-encoded) `/`-separated path relative to the case folder, identified by sha256 + size. `file` with `parentRef`: an extracted attachment with its own bytes (newer-export chronology rows with a `pr` field). `embedded`: an attachment inside its parent (v5 lists 1,308 names under e-mails; `member` is untrusted display text, never a path). `missing`: the converter found no original (`ASSET_MISSING_AT_BUILD`, warning).
- Parents must exist (`ASSET_PARENT_UNKNOWN`), chains are acyclic and at most 4 deep (`ASSET_PARENT_CYCLE`), and a parent should be a container type (`ASSET_PARENT_NOT_CONTAINER`, warning).
- **Paths.** Non-empty, no leading `/` or `\`, no drive letter (`C:` or the URL form `C|`), no backslash, no control character, no empty, `.` or `..` segment; at most 1,024 UTF-8 bytes, 255 bytes per segment and 32 segments. Absolute, UNC, drive and `..` paths are `ASSET_PATH_TRAVERSAL`; other violations `ASSET_PATH_INVALID`; anything under `.clearcase/` is `ASSET_PATH_RESERVED`. Two refs naming the same path are aliases (`ASSET_SHARED_PATH`, info); two different paths that collide after case and NFC folding are `ASSET_AMBIGUOUS_MAPPING` (error). The same rules apply to package paths (`PKG_PATH_*`).
- **Unsupported media is not missing text.** `textStatus` is judged against the media type's capability (`media.ts`): `none` on text-capable media (PDF, e-mail, office, text, HTML) is `TEXT_NONE` (warning: the extractor ran and found no text); media without an extractor (images without OCR, archives, unknown binaries) carry `unsupported` and give `MEDIA_UNSUPPORTED` (info: open or download only); `pending` gives `TEXT_PENDING` (info); a status the media cannot have is `TEXT_STATUS_INCONSISTENT`. The adapter maps v5 `none` on image media to `unsupported` because v5 had no OCR stage; the source `text_status` stays untouched in `chronology`. In the v5 sample, 255 rows have `none`: 242 become `TEXT_NONE` and 13 images become `MEDIA_UNSUPPORTED`.

### The case folder

Import requires the operator-selected case folder and verifies every referenced original in full:

- The folder is opened read-only. Only paths named by the asset index are touched; unrelated case files are never scanned or hashed, and nothing is ever written inside the case folder (`.clearcase/` is only a reserved name). Stores live outside it, in `$CLEARCASE_DATA_DIR`, defaulting to `${XDG_DATA_HOME:-~/.local/share}/clearcase/` (GRS-12).
- Each path is walked one segment at a time from the folder's real path. A segment that is a link is resolved with `realpath` and must stay under the folder's real path before anything below it is listed or opened, which catches symlinks at any depth (`ORIG_ESCAPE`). A link out of the folder is refused whether or not the indexed name exists beyond it, so nothing outside the folder is listed or opened and the verdict does not reveal outside names. A path that resolves into `.clearcase/`, for example through an in-folder alias, is `ASSET_PATH_RESERVED` (error). A dangling or looping link counts as missing. The result must be a regular file (`ORIG_NOT_FILE`; a FIFO is refused without blocking) and match the indexed size and sha256 (`ORIG_FINGERPRINT_MISMATCH`). All three are errors. A missing path is `ORIG_MISSING` (warning) and stays visibly flagged; a cited missing original adds `CITE_TARGET_NO_ORIGINAL` (warning) and does not block activation.
- The mapping records the real on-disk path relative to the case folder, after any link inside the folder, and that is the path to serve. Files are opened with `O_NOFOLLOW` and `O_NONBLOCK`, so a FIFO swapped in after the check cannot block.
- Exact names first, segment by segment. Only when a segment's exact name is absent is its directory, already resolved and inside the folder, listed for a case- or NFC-insensitive match (lower-casing after NFC, not full Unicode case folding). A file found that way is `ORIG_CASE_MISMATCH` (warning), and the real on-disk relative path is recorded; on-disk names are never NFC-normalised. An ambiguous fold match counts as missing.
- Content that contradicts its declared type (HTML inside a `.pdf`) is `ORIG_MEDIA_MISMATCH` (warning) and the original is only offered as a download.
- Bounds apply before any byte is hashed: at most 8 GiB per original (`ORIG_TOO_LARGE`, and `ASSET_TOO_LARGE` for a declared size) and 32 GiB of unique referenced bytes (`ORIG_TOTAL_TOO_LARGE`). Hashing streams in 1 MiB chunks and hashes each unique real file once. Validation has a 120-second deadline (`IMPORT_DEADLINE`) and honours an `AbortSignal` (`IMPORT_ABORTED`), checked between files and datasets and every few thousand values as well as while hashing; both give a rejection with no candidate, and nothing has been written. Progress is reported per phase (`snapshot`, `validate`, `stat`, `hash`, `done`) with file and byte counts.

## Validation and diagnostics

Order: snapshot of the source; manifest, format and version; listed files (paths, duplicates, presence, bounds, size and sha256, strict JSON, canonical form); envelopes, the user-work boundary and record shapes; the document register; the asset index; citations, links and text; source metadata and seeds; identity recomputation; then, only when there is no error so far, the originals in the case folder.

Every diagnostic is `{code, severity, cls, file, pointer, subject, message, hint, fingerprint, baseline}`:

- **severity**: `error` rejects the import (no candidate) and is never waivable. `warning` lets a candidate through, but each new warning needs the operator's acknowledgement before activation. `info` is shown only.
- **cls**: `structural` (shape, identity, containment, version), `integrity` (bytes or fingerprints disagree), `quality` (defects carried over from the source data).
- **pointer**: RFC 6901 pointer into `file`. **subject**: the ref, path, key or field concerned (untrusted text). **hint**: the operator's next action.
- **fingerprint**: sha256 of the code, file, a stable pointer and the subject (32 hex). In dataset content the stable pointer replaces each array index by the element's identity: the `ref` of a document-register row, otherwise a digest of the element's canonical content with an occurrence number among equal elements (a `ref` elsewhere is a citation, not an identity); outside dataset content indexes become `*`. A fingerprint is therefore stable across rebuilds and record reordering, and a new record with the same defect is a new warning. Refs are package-local aliases, so a diagnostic about an original (`ORIG_*`, `ASSET_PATH_RESERVED`) also binds the asset's indexed sha256, size and path: the same document keeps its fingerprint, but a different document under the same ref, or the same ref at another path, is a new warning that an earlier acknowledgement does not cover.
- **baseline**: `known` or `new` against the trusted baseline the caller supplies; errors are always `new`.
- At most 2,000 diagnostics per code are listed, the first 2,000 in sort order (never the first to arrive, so parallel hashing cannot change the list); the rest are counted (`DIAG_TRUNCATED`). Every instance is still fingerprinted: `warningFingerprints` and `errorFingerprints` in the import result are complete and uncapped.
- `diagnosticsSha256` is the digest of the baseline-independent content (validator version, counts, warning fingerprints and the listed diagnostics without `baseline`). Messages contain no timings and no absolute paths, so the same inputs give the same digest.
- A subject is cut to at most 200 UTF-16 units, never inside a surrogate pair, and stored text is well-formed. If the diagnostics cannot be digested anyway, the import rejects with `PKG_UNPROCESSABLE` alone and never throws.

Any unexpected failure while reading or validating untrusted input becomes `PKG_UNPROCESSABLE` (error) rather than an exception, and the import result is frozen. Errors are, among others: fingerprint mismatch, original escape, not a regular file, unsafe link scheme or locator, path traversal, duplicate ref, manifest/envelope/record count mismatch, non-canonical file, unsupported version, archive violations and exceeded bounds. Missing originals, unresolved citations, absent text and META disagreements are warnings. The full registry with hints is `codes.ts`; the table is at the end of this page.

### Known baseline, acknowledgement and activation

- The **trusted baseline** is the set of warning fingerprints accepted with the active version plus an operator-accepted local register. It defaults to empty. Nothing in a package can add to it. A known count does not make a defect trusted: on the first v5 import every warning is new, including the reference known defect, the 20 unresolved `bundles.catalogue` refs (17 `XD-`, 3 `AF-`).
- An **acknowledgement** (`acknowledgement.schema.json`) binds `{resultsVersion, manifestSha256, diagnosticsSha256, validatorVersion, warningFingerprints[]}` and optionally `acknowledgedBy` and `at`. It must cover every new warning, including those that appear only in capped totals. Any difference in a bound field makes it stale; changed diagnostics need a fresh acknowledgement.
- `canActivate(result, acknowledgement, trustedBaselineFingerprints)` is a pure function over a fresh `ImportResult`. It refuses a rejected import (`REJECTED`), any error (`ERRORS_PRESENT`), any attempt to waive an error through the acknowledgement or the baseline (`ERROR_NOT_WAIVABLE`), unacknowledged new warnings (`ACK_REQUIRED`, `ACK_INCOMPLETE`) and stale acknowledgements (`ACK_STALE`).
- **Carry-forward.** After activation, `acceptedWarnings(result, acknowledgement, trusted)` is the activated version's accepted set; it joins the trusted baseline for the next import. A reconversion with the same defects, even with reordered records, then needs no new acknowledgement; a new defect does.

### Importer requirements (normative for GRS-12)

These rules are storage-neutral; GRS-12 owns the stores (`results.sqlite`, `work.sqlite`), the import transaction, activation, recovery and backups.

1. Import calls `importCandidate(source, caseFolder, options)` with the operator's case folder. A `reject` result is shown with its diagnostics and nothing is stored.
2. To store a candidate, persist exactly the bytes from `candidate.snapshot()` (manifest plus listed files) without reopening producer files, together with `resultsVersion`, `manifestSha256`, `diagnosticsSha256`, `validatorVersion` and the diagnostics.
3. Before activation, verify the stored bytes with `verifyCandidateBytes(storedFiles, {resultsVersion, manifestSha256})`; then revalidate the originals read-only by running `importCandidate({files: storedFiles}, caseFolder, {trustedBaseline})` on the stored bytes; then call `canActivate` on that fresh result with the operator's acknowledgement and the trusted baseline; then record the bound acknowledgement with the activation.
4. On any failure the active version and every stored version stay unchanged. An interrupted or rejected import leaves no partial version.
5. Activation never writes into results and never rewrites user rows.
6. Originals are served only through the originals rules below, from the verified mapping (`candidate.original(ref)`), never from a path taken from a dataset field.

## Safe rendering and links

Every imported value (narrative, filename, subject, sender, URL, metadata) is untrusted text.

- **Text.** Views put imported values only into text nodes. The single exception is the output of `renderNarrative(text, {resolveCitationHref})` (`render.ts`, browser-safe), which escapes everything first and then emits only `<p>`, `<br>`, `<a class="cite" href="…">` and `<span class="cite-broken">`. Blank lines separate paragraphs; single newlines become `<br>`. Markdown links, bare URLs and any markup stay literal text.
- **Hidden characters** (C0 and C1 controls, DEL, soft hyphen, zero-width and directional marks, bidi embeddings, overrides and isolates, invisible operators, BOM) render visibly as `⟨U+XXXX⟩` (`revealInvisible`), so `invoice‮fdp.exe` cannot pass as a PDF. In data they are `TEXT_CONTROL_CHARS` (warning).
- **Filenames** are never links and never filesystem paths; `displayFilename` truncates at 120 characters. Paths come only from the verified asset mapping.
- **Citations.** `[[REF]]` and `[[REF#pN]]` follow the ref grammar. The app supplies `resolveCitationHref(ref, page)`, which returns its own route (the pilot uses `documentRoute(resultsVersion, ref, page)`, i.e. `/v/[vid]/doc/[ref]?page=N`) or `null`. Every returned href is checked by `isSafeAppHref`: a same-origin absolute path without scheme, authority, backslash, whitespace, control character or `.`/`..` segment (also percent-encoded). A citation that does not resolve or whose href fails the check renders as a broken citation. Imported URL fields are never used as `href`.
- **Link fields** (`url`, `headline_url`, `sliceUrl`, `file`, `indexFile`, `planFile`, `folder`, `extracts`, `caselinesSrc`, …) and Markdown links in authored prose are classified by `classifyLink` after browser-equivalent normalisation (leading C0 and space stripped, TAB, LF and CR removed). In prose, inline destinations (also in `<…>` and after leading white space), reference definitions (`[x]: dest` where the label opens a line) and autolinks (`<scheme:…>`) are found by a linear scan; backslash escapes are removed and HTML character references decoded first, as a Markdown renderer would. A destination longer than 2,048 characters, counted before decoding, is `LINK_RELATIVE_UNSAFE`: the scan reads at most 2,049 characters of it and never cuts or decodes it into a shorter locator that could pass. A link value is likewise refused above 2,048 characters. Errors: `javascript:`, `vbscript:`, `data:`, `file:`, `blob:`, `filesystem:`, `about:`, `chrome:`, `intent:`, `jar:`, `view-source:`, `ws(s):`, `ftp:` and similar (`LINK_UNSAFE_SCHEME`); protocol-relative `//`, UNC, absolute `/…`, drive letters and traversing locators (`LINK_RELATIVE_UNSAFE`). `https` with a host and no credentials, and `mailto` (address only; a query such as `?bcc=` is dropped), are inert external links (`LINK_EXTERNAL`, info) that open only on an explicit click with `rel="noopener noreferrer"` and are never fetched (`safeExternalHref`). Other schemes, including `http`, are text only (`LINK_TEXT_ONLY`). `./` locators are package paths, kept as data; a v5 `url` that disagrees with the indexed path is `LINK_ASSET_MISMATCH`.
- **Exports.** The app owns the CSV contract in `src/lib/components/csv.ts`: user-entered cells in CSV exports get a leading `'` when they start with `=`, `+`, `-`, `@`, TAB or CR (`exportCell`); `userCell` also applies `atSegments` escaping, and `csvCell` applies it to every CSV cell, including imported values.

`tests/case-package/render.test.ts` proves this in headless Chromium inside `unshare -rn`: a control page with the same payloads inserted raw executes (script, `onerror`, timers), while both the server-rendered output and the in-browser bundle of `browser.ts` execute none of them and contain only the allowed elements and attributes.

## Serving originals (rules for GRS-12)

Original bytes are never served from the application origin. GRS-12 builds the server; `servePolicy(mediaType, filename, contentMismatch)` (`media.ts`) returns the headers.

- A separate loopback origin. The hardened prototype serves originals from `http://clearcase-originals.localhost:<port>` bound to 127.0.0.1 and renders PDFs in a sandboxed pdf.js frame; PDF behaviour (whether a CSP sandbox breaks Chromium's viewer) is GRS-12's to measure.
- Always `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: private, no-store`, and an RFC 6266/8187 `Content-Disposition` whose filename has controls, quotes and bidi characters replaced and is cut to 200 UTF-16 units on a code-point boundary.
- Never `text/html`, `image/svg+xml` or XML. HTML, HTM, EML, TXT and CSV: `text/plain; charset=utf-8` with CSP `sandbox; default-src 'none'` (source shown, never rendered). PDF, PNG, JPEG, GIF, WebP: their exact type, inline; images with CSP `sandbox; default-src 'none'`. Office, MSG, SVG, XML, ZIP, TIFF, BMP, unknown types and anything flagged `ORIG_MEDIA_MISMATCH`: `application/octet-stream` as an attachment.
- Serve only verified mappings: a missing, escaping or mismatched original is never served, and its document shows its flag (`readCandidate().documentState(ref)`).

## User work, seeds and anchors

User notes, registers, selections and preparation material (the v5 browser stores: deadlines, timesheet, disbursements, privilege, POPIA, annotations, transcripts, rescan, bundle and schedule settings, filings register, cross-exam, payments, heads, authorities, …) are user work. They live in the workspace store (GRS-12), never in results.

- The validator rejects user work in results (`DS_USERWORK_EMBEDDED`, error): reserved dataset keys (`annotations`, `notes`, `deadlines`, `user-*`, `backup` and the other store names), `provenance.source` of `user-work`, `local-storage`, `backup` or `workspace`, and browser store keys of the form `<prefix>_<store>_vN` at any nesting depth, including inside residual datasets and manifest extensions.
- **Seeds.** Imported seed rows (`filings.registerSeed`, `lit-crossexam-seed`) remain versioned results. User edits are separate overlays keyed by a stable seed id (`seed:` + digest of the dataset key and the seed's natural key fields: `ref` and `filing` for filings, `witness` and `topic` for cross-exam) and record the `seedSha256` they were made against. `viewSeeds(seeds, overlays)` shows `seed`, `edited`, `conflict` (the seed changed since the edit; both are shown) or `orphaned` (the seed is gone; the edit is kept). Duplicate natural keys are `DS_SEED_ID_AMBIGUOUS`. Activation never rewrites user rows.
- **Anchors.** User work points at a document with `{caseId, sha256, refAtCreation, resultsVersion}`. `matchAnchor` re-anchors by fingerprint in any version: `exact` (one ref has that sha256, possibly a renumbered one), `ambiguous` (several refs share it; disclose and let the operator choose) or `missing` (disclose). A ref alone is never matched across packages.
- GRS-12 persists user work and proves notes survive activation, ref renumbering or reuse, reordered seeds and restart.

## Bounds

All bounds are in `limits.ts` (`LIMITS`); callers may lower them per import (`options.limits`). Each has at least 10 times headroom over the v5 sample.

| Bound | Value | v5 sample |
| --- | --: | --: |
| `manifest.json` | 1 MiB | 12 KB |
| any listed file | 64 MiB | 1.8 MB |
| all listed files | 512 MiB | 6.2 MB |
| files in a package (incl. manifest) / datasets | 1,024 / 512 | 36 / 34 |
| JSON nesting | 32 containers | 9 |
| string | 1 Mi UTF-16 units | 4,000 |
| keys per object / items per array / values per file | 100,000 / 1,000,000 / 20,000,000 | 481 / 1,745 / — |
| assets | 500,000 | 2,997 |
| path / segment / segments | 1,024 B / 255 B / 32 | 219 characters |
| ref | 32 characters | 7 |
| attachment parent chain | 4 | 1 |
| listed diagnostics per code | 2,000 (rest counted, all fingerprinted) | 910 |
| original / unique referenced originals | 8 GiB / 32 GiB | 1.85 GB in total |
| validation deadline | 120 s | about 1.3 s warm |
| zip: entries / per entry / expanded total / ratio above 1 MiB | 1,024 / 64 MiB / 512 MiB / 100:1 | — |

Exceeding a bound is an error with an actionable message, before activation and, for originals, before hashing.

## Zip transport

A `.zip` of the package layout is read without extraction. The central directory is checked before any entry is decoded: encrypted entries, compression other than stored or deflate, zip64 and multi-disk archives are `ARC_UNSUPPORTED`; symlink and special-file entries, absolute, drive-letter, backslash and `..` names, duplicate names (also after case and NFC folding) and a name used both as a file and as a folder are `ARC_ENTRY_INVALID`; bounds are `ARC_LIMIT`; anything inconsistent is `ARC_MALFORMED`. UTF-8 names without the UTF-8 flag are decoded as UTF-8 first. Names are byte-exact: a leading U+FEFF is kept, so `\uFEFFassets.json` is not `assets.json`. Each entry's compressed size is checked against its declared size before any of its bytes are read: a stored entry whose two sizes differ is `ARC_MALFORMED`, and a deflated entry with more than the declared size plus one eighth and 64 bytes (the worst legitimate fixed-Huffman expansion) is `ARC_LIMIT`, so the per-entry and total bounds also cap the compressed bytes held in memory. Only the manifest and listed entries are decoded, in memory, with the expansion capped at the declared size, and the decoded size and CRC-32 must match. Nothing is written to disk.

## Library API

Module paths are relative to `src/lib/case-package/`. `index.ts` is the Node entry point and re-exports everything below. `browser.ts` re-exports only browser-safe modules: `render.ts`, `links.ts`, `refs.ts`, `canonical.ts`, `strict-json.ts`, `codes.ts`, `media.ts`, `paths.ts`, `user-work.ts` and `view-content.ts` (their only other import is `limits.ts`); none of them imports filesystem code or a Node built-in (checked by a test that walks the import graph and bundles `browser.ts` for the browser). The library has no global state. Import and conversion remain read-only. `writePackageDir` writes packages to an explicit, empty output directory. `zip.ts` also exports `extractEntries`, which writes extracted case-pack files to an explicit destination.

| Export (module) | Signature and contract |
| --- | --- |
| `importCandidate` (`import.ts`) | `(source: string \| {files: Map<string, Uint8Array> \| Record<string, Uint8Array>}, caseFolder: string, options?: {limits?, signal?: AbortSignal, onProgress?: (p: Progress) => void, trustedBaseline?: Iterable<string>, concurrency?: number}) => Promise<ImportResult>`. `source` is a package directory, a `.zip` file or caller-owned bytes keyed by package path. |
| `ImportResult` (`candidate.ts`) | `{verdict: 'reject', candidate: null, …}` or `{verdict: 'accept' \| 'report', candidate: Candidate, …}`, both with `diagnostics`, `diagnosticsSha256`, `validatorVersion`, `counts` (per code, uncapped), `warningFingerprints`, `errorFingerprints`. `accept` has no warnings; `report` has warnings to acknowledge. |
| `Candidate` (`candidate.ts`) | Frozen. `caseId`, `formatVersion`, `resultsVersion`, `manifestSha256`, `inputRevisionId`, `manifest`, `assets`; `identity()`; `paths()`; `fileBytes(path)` and `snapshot()` (an iterator of `{path, bytes}`) return copies of the exact bytes; `datasetKeys()`, `dataset(key)` (deep-frozen envelope); `original(ref)` (verified `{ref, path, sha256, size, mediaType, status: 'verified' \| 'case-mismatch', downloadOnly}`), `originalRefs()`, `isUnavailable(ref)`. Changes to the producer directory or to caller-owned buffers after import cannot change it. |
| `verifyCandidateBytes` (`verify-bytes.ts`) | `(storedFiles: Map \| Record \| Iterable<[path, bytes]>, expected: {resultsVersion, manifestSha256}) => {ok, problems: string[]}`: exact membership (manifest plus listed files, nothing else), sizes, sha256 values, `manifestSha256`, recomputed `inputRevision.id` and `resultsVersion`. No filesystem access. |
| `readCandidate` (`reader.ts`) | `(candidate) => {caseId, resultsVersion, dataset(key), chronology, sourceMeta, documentState(ref), attachmentsOf(parentRef), resolveAttachment(key), derivedCounts(), seeds(), originals()}`. `documentState` gives `{file: present \| missing \| blocked, preview: ServeMode \| 'none', text, mediaType, original, flags}`. `resolveAttachment` gives `{route: 'parent', member, original}` (open the container), `{route: 'direct', original}` (extracted attachment) or `{route: 'unavailable', reason}`. |
| `renderNarrative` (`render.ts`, browser) | `(text: string, {resolveCitationHref: (ref, page \| null) => string \| null}) => string` (HTML). Also `isSafeAppHref`, `documentRoute(resultsVersion, ref, page?)`, `displayText`, `displayFilename`, `revealInvisible`, `safeExternalHref`, `exportCell`. |
| `canActivate` (`policy.ts`) | `(result: ImportResult, acknowledgement: Acknowledgement \| null, trustedBaselineFingerprints?: Iterable<string>) => {ok, reasons, newWarnings}`. Also `acknowledge(result, fingerprints, by?)`, `acceptedWarnings(result, ack, trusted)`, `newWarningFingerprints(result, trusted)`. |
| `Acknowledgement` (`schema.ts`) | `{acknowledgement: 'clearcase.acknowledgement/1', resultsVersion, manifestSha256, diagnosticsSha256, validatorVersion, warningFingerprints[], acknowledgedBy?, at?}` |
| `DocumentAnchor`, `SeedRow`, `SeedOverlay`, `matchAnchor`, `viewSeeds` (`user-work.ts`, browser) | Types and pure rules for user work ([User work](#user-work-seeds-and-anchors)). |
| `readViewContent` (`view-content.ts`, browser) | `(data: unknown) => {views(), fields(view), value(view, field), text(…), number(…), list(…), params(…), fill(view, field, params?) => {text, missing} \| null}` over the `view-content` data ([View content](#view-content-code-embedded-case-content)). Also `VIEW_CONTENT_KEY`, `isViewValue`, `isViewTemplate` and the `ViewValue` types. |
| `convertV5` (`v5/adapter.ts`), `reassembleV5` (`v5/reassemble.ts`) | `({html: Uint8Array, htmlName, caseFolder, caseId, caseLabel?, created?, concurrency?, limits?, signal?}) => Promise<{ok, manifest, files: Map<path, bytes>, diagnostics, source, viewContent, stats}>`; `viewContent` is the view-content coverage (`fields` with a status per map entry, `unmapped` prose literal locations). `reassembleV5(datasets)` rebuilds the four v5 roots (`view-content` and the other `(…)` datasets are not part of them). |
| `buildPackage`, `writePackageDir` (`writer.ts`) | Shared producer: spec to exact bytes; bytes to an explicit empty directory (never overwrites). |
| `canonicalJson`, `canonicalText` (`canonical.ts`, browser); `inputRevisionId`, `resultsVersionOf` (`hash.ts`) | The encodings and identity digests above. |

Committed JSON Schemas (2020-12) are in `src/lib/case-package/schema/`: `manifest`, `dataset-envelope`, `assets`, `acknowledgement` and one `data.v5.<key>.v1.schema.json` per recognized dataset. `bun run --bun check` regenerates them in memory, fails on drift, and runs an independent validator (`@cfworker/json-schema`, exact dev pin) next to TypeBox over a freshly emitted synthetic package and malformed examples for every schema.

## Commands

All app scripts run with Bun: `bun install --frozen-lockfile`, then `bun run --bun <script>`.

| Script | What it does |
| --- | --- |
| `check` | `tsc --noEmit`, schema export check, independent schema validation |
| `test` | Invokes Vitest directly on synthetic fixtures. Use the [development page's offline wrapper](development.md#toolchain-and-commands) to make the unit run offline. The Chromium test uses `CLEARCASE_CHROMIUM` or the Playwright headless shell under `~/.cache/ms-playwright/`. |
| `convert` | `--html FILE --case-folder DIR --case-id ID --out DIR [--case-label TEXT] [--report FILE] [--concurrency N] [--no-validate]`: converts a v5 workspace HTML into a new package directory and then validates it in full against the case folder |
| `validate` | `--package DIR\|ZIP --case-folder DIR [--report FILE] [--baseline FILE] [--activation-check [--ack FILE]] [--concurrency N] [--deadline-ms MS]` |
| `measure` | `--ticket CC-02 --baseline REV --candidate REV [--samples 20] [--warmup 2] [--cold 3] [--baseline-median MS] [--out DIR]` |
| `verify:package` | `--fixture-config .local/v5-verification.json --out DIR [--lanes 1,2,…]`: the eleven verification lanes against the local v5 fixture (lane 11: view content, and the accepted identity of every other file with package files set aside, which the fixture configuration's `accepted.resultsVersion` names) |

`bun scripts/case-package/cli.ts acknowledge --report FILE --out FILE [--baseline FILE] [--by NAME]` writes an acknowledgement of a report's new warnings.

- `--case-id` must match `^[a-z0-9][a-z0-9._-]{0,63}$`; it is the operator's case identity and enters `resultsVersion`. The source file name never does.
- `--out` and `--report` may not be inside the case folder, and `--out` must not exist or be empty.
- `--report` writes `clearcase.validation-report/1`: verdict, case id, `resultsVersion`, `manifestSha256`, `inputRevisionId`, `validatorVersion`, `diagnosticsSha256`, counts, all warning and error fingerprints and the listed diagnostics (with `--activation-check`, the decision). For `convert` it adds `conversion` (the adapter diagnostics) and `viewContent`: fields extracted (total and per view), fields not extracted with their status, and unmapped prose literals by scope, line and word count, never their text. `--baseline` is a JSON array of trusted fingerprints.
- **Exit codes**: `0` a candidate (verdict `accept` or `report`; with `--activation-check`, also activatable); `1` rejected, no candidate (including conversion failure, deadline and cancellation); `2` usage or input error (missing flag, bad case id, unreadable HTML, missing case folder, output inside the case folder or not empty, a `--report`, `--baseline` or `--ack` file that cannot be read or is not JSON), with one `error:` line on stderr; `3` a candidate that `--activation-check` refuses (for example unacknowledged new warnings).

## Performance

Budget on puk (decision 8, fixed from the GRS-9 baseline before implementation): converting and fully validating the v5 sample from the extracted case folder takes at most 10,000 ms wall time warm, with peak RSS at most 1 GiB. `measure` runs that workload (`cli.ts convert`) as fresh Bun processes from an isolated copy of each revision, after a documented warm-up, and checks every warm sample against the budget. The first Bun baseline median recorded at the GRS-10 head is the fixed denominator for later repeats (`--baseline-median`, at most 1.25 times). The GRS-10 base has no converter, so its comparison is N/A. Cold samples use `posix_fadvise(DONTNEED)` on the fixture files (no root) and are reported, not gated.

## Open items

- The newer 2,131-document export imports (The v5 adapter, above). Still open: its new datasets (`emails`, `whatsapp`, `organogram`, `anchors`, `text`, `transcripts`, `profile`) stay residual until a view reads them, and its empty prescription summary is demoted rather than derived.
- Embedded attachments carry no fingerprint until a pipeline extracts them.
- Local persistence, activation and PDF isolation already exist (GRS-12). The Markdown round-trip producer remains roadmap work (GRS-23).
- Known gaps from the GRS-11 gate, not yet repaired (N5-N9, N11, N12 in its report). Where this page says otherwise, these qualify it:
  - The reference-definition scan is not linear when one line repeats `]:` many times (N5): about 2.2 s for 1 MiB. The deadline still applies between values, not inside one long scan.
  - Dataset shape reporting emits up to 50 TypeBox validation errors per dataset (N6). `counts` and `errorFingerprints` cover the errors emitted.
  - Manifest `created` is not checked as a calendar date and zone, and a year-0000 date warns through `Date.UTC` (N7).
  - The view-checklist overview and the inventory builder's main-variant selection have documentation and build-only gaps (N8, N9); `--verify` still rejects.
  - Asset paths are not scanned for hidden characters, folding is not full Unicode case folding, and Windows device names and confusable twins are not flagged (N11). For the app's CSV contract, see [Exports](#safe-rendering-and-links).
  - Bare split schemes, padded citation tokens, text-only pseudo-schemes, empty optional timeline refs and the credential and legacy-version messages need grammar or wording clarification (N12); all are inert or fail closed.
  - Still open from GRS-10: a dangling link whose target lies outside the folder is `ORIG_MISSING`, not `ORIG_ESCAPE`, and a link to an outside folder that does not exist is likewise missing.

## Diagnostic codes

| Code | Severity | Class | Meaning |
| --- | --- | --- | --- |
| `PKG_SOURCE_INVALID` | error | structural | package source is not a directory, zip file or byte collection |
| `PKG_MANIFEST_MISSING` | error | structural | manifest.json missing |
| `PKG_NOT_A_PACKAGE` | error | structural | manifest.format is not clearcase.results-package |
| `PKG_MANIFEST_INVALID` | error | structural | manifest does not match the manifest schema |
| `PKG_SYMLINK` | error | structural | symlink inside the package |
| `PKG_SPECIAL_FILE` | error | structural | non-regular file inside the package |
| `PKG_TOO_MANY_FILES` | error | structural | file count limit exceeded |
| `PKG_TOO_LARGE` | error | structural | size limit exceeded |
| `PKG_PATH_INVALID` | error | structural | listed path violates the path rules |
| `PKG_PATH_TRAVERSAL` | error | structural | listed path escapes the package root |
| `PKG_DUPLICATE_PATH` | error | structural | path listed twice (exactly or after case/NFC folding) |
| `PKG_FILE_MISSING` | error | structural | listed file missing |
| `PKG_FILE_HASH_MISMATCH` | error | integrity | file bytes do not match the manifest size or sha256 |
| `PKG_UNLISTED_FILE` | warning | structural | file present but not listed (ignored, never imported) |
| `PKG_NONCANONICAL` | error | structural | file is not canonical JSON |
| `PKG_INPUT_REVISION_MISMATCH` | error | integrity | inputRevision.id is not the digest of its sources |
| `PKG_VERSION_MISMATCH` | error | integrity | resultsVersion is not the digest of the listed content |
| `PKG_UNPROCESSABLE` | error | structural | the package could not be processed (unexpected failure while reading or validating) |
| `PKG_ROLE_INVALID` | error | structural | missing or duplicate asset index |
| `JSON_BAD_UTF8` | error | structural | file is not valid UTF-8 or has a byte order mark |
| `JSON_MALFORMED` | error | structural | malformed JSON |
| `JSON_DUPLICATE_KEY` | error | structural | duplicate key in a JSON object |
| `JSON_LIMIT` | error | structural | JSON nesting or size bound exceeded |
| `VER_UNSUPPORTED` | error | structural | unsupported package format or formatVersion |
| `ARC_MALFORMED` | error | structural | malformed zip archive |
| `ARC_UNSUPPORTED` | error | structural | unsupported zip feature (encryption, method, multi-disk) |
| `ARC_LIMIT` | error | structural | archive bound exceeded (entries, expanded size or ratio) |
| `ARC_ENTRY_INVALID` | error | structural | unsafe archive entry (traversal, absolute, link, duplicate, file/folder clash) |
| `DS_ENVELOPE_INVALID` | error | structural | dataset envelope does not match its schema |
| `DS_MANIFEST_MISMATCH` | error | structural | dataset envelope disagrees with the manifest |
| `DS_COUNT_MISMATCH` | error | structural | declared count differs from the actual record count |
| `DS_SHAPE_INVALID` | error | structural | record does not match the dataset schema |
| `DS_SCHEMA_UNSUPPORTED` | error | structural | a required dataset uses a schema this reader does not understand |
| `DS_UNKNOWN_SCHEMA` | warning | structural | optional dataset with an unknown or opaque schema (preserved, not rendered) |
| `DS_REQUIRED_MISSING` | error | structural | required dataset missing |
| `DS_USERWORK_EMBEDDED` | error | structural | user work found inside immutable results |
| `DS_UNSUPPORTED_FIELD` | warning | quality | field not in the dataset schema (preserved, not rendered) |
| `DS_ENUM_UNKNOWN` | warning | quality | value outside the known set |
| `DS_DATE_INVALID` | warning | quality | date has the right form but is not a calendar date |
| `DS_SEED_ID_AMBIGUOUS` | warning | quality | two seed rows share a stable seed id |
| `ID_DUPLICATE` | error | structural | duplicate document ref |
| `ID_REF_INVALID` | error | structural | ref missing or not matching the ref grammar |
| `ASSET_PATH_INVALID` | error | structural | asset path violates the path rules |
| `ASSET_PATH_TRAVERSAL` | error | structural | asset path escapes the case folder |
| `ASSET_PATH_RESERVED` | error | structural | asset path inside the reserved .clearcase/ area |
| `ASSET_AMBIGUOUS_MAPPING` | error | structural | two refs map to different paths that collide after case/NFC folding |
| `ASSET_SHARED_PATH` | info | quality | several refs name the same original (alias) |
| `ASSET_PARENT_UNKNOWN` | error | structural | parentRef does not exist in the asset index |
| `ASSET_PARENT_CYCLE` | error | structural | parent chain cycles or is too deep |
| `ASSET_TOO_LARGE` | error | structural | declared original size exceeds the per-original bound |
| `ASSET_PARENT_NOT_CONTAINER` | warning | quality | parent media type is not a container (e-mail or archive) |
| `ASSET_NOT_INDEXED` | warning | quality | document has no asset entry and cannot be opened |
| `ASSET_ORPHAN` | warning | quality | asset has no document row and no parent |
| `ASSET_MISSING_AT_BUILD` | warning | quality | the converter found no original for this document |
| `ASSET_DUPLICATE_CONTENT` | info | quality | several refs share identical content (sha256) |
| `TEXT_NONE` | warning | quality | text-capable media but no text was extracted (e.g. a scan without OCR) |
| `TEXT_PENDING` | info | quality | text extraction pending |
| `MEDIA_UNSUPPORTED` | info | quality | media type has no text extractor; open or download only |
| `TEXT_STATUS_INCONSISTENT` | warning | quality | textStatus contradicts the media capability |
| `ORIG_CASE_FOLDER_INVALID` | error | integrity | case folder missing, unreadable or not a directory |
| `ORIG_MISSING` | warning | integrity | original not found in the case folder |
| `ORIG_FINGERPRINT_MISMATCH` | error | integrity | original bytes differ from the indexed size or sha256 |
| `ORIG_ESCAPE` | error | integrity | original resolves outside the case folder (link escape) |
| `ORIG_NOT_FILE` | error | integrity | original is not a regular file |
| `ORIG_UNREADABLE` | error | integrity | original could not be read |
| `ORIG_CASE_MISMATCH` | warning | integrity | original found only by a case- or normalisation-insensitive match |
| `ORIG_MEDIA_MISMATCH` | warning | integrity | content contradicts the declared media type (download only) |
| `ORIG_TOO_LARGE` | error | integrity | original exceeds the per-original bound |
| `ORIG_TOTAL_TOO_LARGE` | error | integrity | referenced originals exceed the total bound |
| `IMPORT_DEADLINE` | error | integrity | validation exceeded its deadline |
| `IMPORT_ABORTED` | error | integrity | import cancelled |
| `CITE_UNRESOLVED` | warning | quality | citation target is not in the document register |
| `CITE_TARGET_NO_ORIGINAL` | warning | integrity | cited document has no original in the case folder |
| `CITE_TOKEN_INVALID` | warning | quality | malformed [[...]] citation token |
| `CITE_BARE_MENTION` | info | quality | ref mentioned in prose without a [[...]] token (not linked) |
| `LINK_UNSAFE_SCHEME` | error | structural | link uses a forbidden URL scheme |
| `LINK_RELATIVE_UNSAFE` | error | structural | link is not a safe locator (absolute, protocol-relative, UNC, drive path, traversing or longer than 2,048 characters) |
| `LINK_EXTERNAL` | info | quality | external link (rendered inert, never fetched) |
| `LINK_TEXT_ONLY` | info | quality | link with a scheme that is shown as text only |
| `LINK_ASSET_MISMATCH` | warning | quality | legacy locator disagrees with the indexed original path |
| `TEXT_CONTROL_CHARS` | warning | quality | text contains control or bidirectional-override characters (rendered visibly) |
| `V5_PAYLOAD_MISSING` | error | structural | required v5 data line not found |
| `V5_PAYLOAD_AMBIGUOUS` | error | structural | v5 data assignment appears more than once |
| `V5_PAYLOAD_NOT_JSON` | error | structural | v5 data line is not pure JSON (refused, never evaluated) |
| `V5_PAYLOAD_ENCODED` | error | structural | v5 data line is encoded or computed (refused, never evaluated) |
| `V5_UNMAPPED_KEY` | warning | quality | source key has no mapping; preserved as an opaque dataset |
| `V5_DATASET_SHAPE_UNMAPPED` | warning | quality | source dataset does not match its v5 schema; preserved as an opaque dataset (its view shows the empty state) |
| `V5_SIZE_CLAIM_MISMATCH` | warning | quality | source size field differs from the original on disk |
| `V5_VIEW_CONTENT_MISSING` | warning | quality | a required view-content field was not found in the v5 viewer code (not extracted, never guessed) |
| `V5_VIEW_CONTENT_AMBIGUOUS` | warning | quality | a view-content anchor matches more than once in the v5 viewer code (not extracted, never guessed) |
| `V5_VIEW_CONTENT_LIMIT` | warning | quality | the v5 viewer code is too large or too slow to read; no view content was extracted (fails closed) |
| `V5_META_COUNT_DISAGREEMENT` | warning | quality | source META count disagrees with the count derived from the records |
| `V5_SOURCE_INDEX_DROPPED` | info | quality | the source's own search index was not carried into the package |
| `DIAG_TRUNCATED` | info | quality | more instances of a code than listed |
