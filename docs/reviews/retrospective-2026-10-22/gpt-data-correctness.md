# ClearCase retrospective: data correctness

Independent GPT review, 22 October 2026. Scope: converter/schema/import/export, calculations, version changes, saved user work and bundle source identity.

## Revision and evidence limits

- Reviewed baseline and working-tree HEAD: `225b7e00578319d16383678a8d1ae6efb362a0ba`, on the supplied audit checkout. All implementation line references below refer to this SHA unless explicitly stated otherwise. The tree was clean at the beginning and at the last pre-report check.
- Read the repository `AGENTS.md`, relevant development and results-package contracts, glossary, calculation-differences document, and hosted bundle brief. No other reviewers' reports were read. No agents or skills were invoked.
- Attempted `bash scripts/agent-tools/doctor`. It exited **1 before the doctor ran**, with `WSL ... execvpe(/bin/bash) failed: No such file or directory`. No receipt was produced. Independently, `scripts/agent-tools/_common.sh:6` refuses non-Linux hosts. This is an unsupported environment, not an application test failure.
- **Acceptance status at this SHA: UNRUN.** No build, unit suite, gate, browser acceptance, parity, or real-case check was run. No PASS claim is made. Examples below are small synthetic inputs and deterministic source traces, **not executed reproductions**. Confidence describes the code finding, not end-to-end verification.
- Only this report was written. No branch changes, commits, pushes, deployments, external-service mutations, secret/private-data reads, or implementation/test/configuration changes were made.

Incoming work was examined without checkout:

- `origin/wave/proofs-final`: `a3f80d1305294a8c685a87351281eef7928c7d9c` (PR 114). Its incoming diff has no `src/` product changes. Its storage proof explicitly describes a model, with GRS-117/118 still implementing product storage. The proof's snapshot-consistency correction is valuable incoming work; it is not evidence that the product's hosted results-import endpoint works. See `docs/acceptance/hosting/storage.md:5` **at that incoming SHA**. Recorded proof results were read, not rerun here.
- `origin/wave/guard-followups`: `99cf56bba6afc0bf30d0dc914816ad97d1a750ae`. Compared from merge base `e44e12b397561e7d7ad229e8fad00753db9f00bc`, its incoming diff also has no `src/` changes. A two-endpoint diff misleadingly appears to remove newer converter/CSV/interest protections already on baseline; these are branch divergence, **not incoming regressions**.
- Consequently, neither inspected incoming delta resolves the findings below. This is not a claim about uninspected local work or the live issue tracker.

## Highest-return findings

### D1 — P1: the bundle builder carries case A's files/output into case B

**Confirmed by source trace; high confidence.**

`src/lib/views/bundles/builder.svelte.ts:5-9` defines one module-wide builder, document map and blob map, without a case or resultsVersion key. `Builder.svelte:16` receives no case identity. Clearing is manual (`:44-50`); navigating away does not clear or scope that module. The containing page's navigation guard protects only index-header edits (`src/routes/v/[vid]/bundles/court_bundle_tab/+page.svelte:107-110`).

The generated output contains no originating case/version (`Builder.svelte:84`). Save posts that output to the **current relative page URL** (`Builder.svelte:117`; `src/lib/views/bundles/post.ts:12`). The action obtains the case exclusively from the current `params.vid` and stores the submitted entry there (`court_bundle_tab/+page.server.ts:94-106`).

**Synthetic trace:** build a PDF with a distinctive “CASE A ONLY” page in A; navigate through All cases to B in the same browser tab; open B's builder; Save. The same `bld.out` remains available, while the save action selects B. Even an unfinished builder brings A's selected files into B's assembly. This is local cross-case contamination, not a claim of hosted authorization bypass. Client navigation does not provide an implicit reset: the current [SvelteKit state-management contract](https://svelte.dev/docs/kit/state-management#Component-and-page-state-is-preserved) explicitly preserves page/layout state, and module state here has an even longer lifetime.

**Smallest fix:** key builder state and retained outputs by case identity, bind each output to its originating case/resultsVersion, and verify that identity on save. Preserve drafts per case rather than silently discarding them. Capture the originating context before asynchronous reading/assembly, so completion after navigation cannot populate another case's active builder.

**Validation:** real two-case browser test with client navigation, A→B→A, both before and during asynchronous assembly/save; B must neither display A's PDF nor save its item list. This is needed now, independently of durable hosted bundle history.

### D2 — P1: generic-register deletion ignores the row version and can erase a newer saved edit

**Confirmed by source trace; high confidence.**

Edits correctly compare `versionOf(cur)` in `src/lib/user-work/registers.server.ts:34-41`. Deletion, however, calls `deleteRow` using only case/store/id (`:45`). The delete form sends no version (`src/lib/views/registers/RegisterPage.svelte:273`), and the action checks confirmation but never checks whether the row changed (`src/lib/views/registers/page.server.ts:123-133`). Serializing operations only determines their order; it does not make a stale deletion safe.

**Synthetic trace:** tabs A and B load the same deadline, transcript or disbursement. B saves important new text. A confirms Delete on its old display. The current saved row is deleted, including B's unseen update. Confirmation establishes intent to delete what A saw, not acceptance of a later unseen edit. This affects all seven generic register views listed in `src/lib/views/registers/defs.ts:3`.

**Smallest fix:** include the displayed row version in the delete form and compare it inside the same `inTurn` section before deletion. Missing/stale versions should produce a conflict and show the current row. Reuse the existing version function, not just a timestamp. The core register implementation already demonstrates guarded deletion (`src/lib/local-case/registers.server.ts:112-115`).

**Validation:** two-tab edit-then-delete, edit between confirmation and POST, and retry after restore. Check that the newer row remains byte-identical after a rejected stale deletion. Existing stale-edit coverage in `tests/registers/actions.test.ts:90` does not establish this property.

### D3 — P2: dotted source keys collide with structural paths; reassembly also mishandles `__proto__`

**Confirmed by source trace; high confidence.**

The adapter represents both literal property names and structural paths as an unescaped dotted string. `src/lib/case-package/v5/adapter.ts:48-51` splits every dot; `:150-153` constructs paths with raw source keys and uses those strings to decide whether a field was already mapped.

**Synthetic input:** valid v5 DATA containing both `lit: {authorities: [...]}` and a separate own key `"lit.authorities": {"marker":"KEEP_LITERAL"}`. Mapping the nested authorities adds `DATA.lit.authorities` to `mapped`. The residual loop then skips the distinct literal key. Its value never reaches any dataset. With only a literal unknown `"a.b"` key, a residual is retained, but `reassembleV5` creates nested `a.b`; the source-layout ordering cannot restore the literal `"a.b"` key. Thus this affects both conversion preservation and the advertised lossless reassembly contract (`docs/results-package.md:81`).

There is a related unsafe reconstruction boundary: `src/lib/case-package/v5/reassemble.ts:18-22` uses ordinary assignment and inherited-property lookup. A literal own `__proto__` residual does not become an own property in the reconstructed DATA, unlike the strict parser's explicit `defineProperty` protection (`src/lib/case-package/strict-json.ts:174-175`). A path such as a literal `"__proto__.marker"` also lets traversal select an inherited object. I am not claiming this helper is an exposed HTTP execution path; its demonstrated defect is incorrect/unsafe reconstruction.

**Smallest fix:** represent source locations as root plus escaped segments, or distinguish root keys from registered nested paths while retaining a reversible encoded provenance. Reconstruct only own properties into null-prototype objects or with `own`/`defineProperty`. Changing the provenance encoding needs compatibility and identity review; simply refusing dots would narrow the accepted value space and should be explicit.

**Validation:** convert and reassemble fixtures containing both nested and literal dotted keys, empty keys, `__proto__`, `constructor`, and `prototype`; assert every source marker survives and object prototypes remain unchanged. Keep existing v5 accepted-identity checks.

### D4 — P2: newer CaseLines section mapping silently collapses duplicate or malformed section identifiers

**Confirmed by source trace; high confidence.**

`src/lib/case-package/v5/newer-workspace.ts:145-156` transforms `caselinesSections` from a list into `Object.fromEntries(...[str(s.sec), ...])`, then overwrites the original list. The field-level `setKeepingSource` guards inside each section do not protect the list itself.

**Synthetic input:** two sections with `sec: "001"`, different titles and ranges. Only the second survives. Numeric `1` and text `"1"` collide too; missing/object-valued identifiers become `""`; non-object list members are filtered out by `objs`. The resulting object can satisfy the bundle schema, so later validation cannot diagnose the missing source records. The behavior follows the standard's repeated property writes in [Object.fromEntries](https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.fromentries).

**Smallest fix:** check identifier type and uniqueness before materializing the map. Preserve the complete original section array under a collision-safe residual/source field whenever projection is lossy, and report the ambiguity. Do not silently choose which section supplies page ranges.

**Validation:** duplicate sections in both orders, numeric/string collisions, empty identifiers, and mixed object/scalar arrays. Check both marker preservation and a visible diagnostic. Current `tests/case-package/newer-overwrite.test.ts:18` exercises fields within one section, not duplicate section records.

### D5 — P2: numeric coercion can discard original precision before preservation checks run

**Confirmed behavior; high confidence. The four-decimal rounding policy is already tested; the defect is losing the original value.**

`amountText` rounds a numeric value with too many decimals using `toFixed(4)` (`src/lib/case-package/v5/carry.ts:7-13`). The preservation predicate then treats that rounded output as proof the input was fully handled (`:30`), so `keepRest` drops the original numeric field (`:66-67`). `chronologyRow` writes that projected amount and lists `amt` as consumed (`src/lib/case-package/v5/json-workspace.ts:65-74`).

**Synthetic input:** `amt: 1.00499` becomes amount `"1.005"`, with no retained raw `amt`; rounding the projected amount to cents now produces 1.01, whereas rounding the original amount directly produces 1.00. `tests/case-package/json-workspace.test.ts:203` explicitly expects numeric `20.123456` to become `"20.1235"`, but does not establish preservation of the source number. Numeric inputs and string inputs with the same digits also take different paths: an overprecision string is rejected by `AMOUNT` and retained, while the numeric version is rounded and consumed.

The same pattern affects counts: JSON mapping's `count()` clamps/truncates finite numbers (`json-workspace.ts:14`), while the `num` kind accepts all finite numbers (`carry.ts:28`). A person's `sent: -1` or `sent: 1.9` becomes 0 or 1, and the original is considered consumed (`json-workspace.ts:140`).

**Smallest fix:** separate “can project for display/schema” from “losslessly consumed.” Preserve the original under a collision-safe source field whenever normalization changes numeric value, and diagnose it. If financial calculations should not use rounded inputs, leave the typed amount unavailable until repaired; do not invent a financial rounding policy in the converter.

**Validation:** numeric/string twins, values just below/above cent boundaries, negative/fractional counts, tiny exponents, and existing `source_amt` collisions. Assert both typed output and exact retained source value. Expected-output tests alone can enshrine the loss.

### D6 — P2: the same accepted imported amount can display different cents in different views

**Confirmed by source trace and existing arithmetic contract; high confidence.**

Quantum uses `importedUnits → unitsToCents → centsText` (`src/lib/views/quantum/ledger.ts:8-13`), which rounds decimal amounts exactly. Chronology instead invokes `money(r.amount)` (`src/routes/v/[vid]/chronology/+page.svelte:70`), and overview does the same for headline due (`src/routes/v/[vid]/overview/+page.svelte:42`). That formatter calls `parseFloat` then `toFixed(2)` directly (`src/lib/components/format.ts:3-10`).

**Synthetic value:** accepted amount `"1.005"`. Quantum displays R 1.01; the direct floating-point formatter displays R 1.00. A four-decimal package amount is explicitly valid (`src/lib/case-package/records.ts:9`). This is not a disputed interest convention: `docs/reference/calculation-differences.md:14-16` already records exact half-away-from-zero for imported figures and gives this same floating-point counterexample.

**Smallest fix:** put one exact imported-money formatter at the shared calculation/component boundary and use it in chronology, overview and timeline monetary interpolation. Preserve raw values in exports and results. Do not route permissive free-text UI formatting through a stricter parser without checking callers.

**Validation:** one synthetic package carrying the same `1.005` and `-1.005` in chronology, quantum and headline fields; assert identical formatted cents across views and unchanged raw CSV/package values. Add a large-but-schema-valid imported amount to expose the already documented double-formatting limit separately.

### D7 — P2: the backup exporter can produce a file that every restore entry point rejects

**Confirmed boundary mismatch; high confidence. Scale threshold not exercised here.**

`createBackup` gathers all eligible rows without a total-size ceiling (`src/lib/user-work/backup/backup.server.ts:32-50`). `backupFile` pretty-prints and returns the whole result without checking its encoded size (`src/lib/views/system/backup.server.ts:42-45`). Yet upload, filesystem restore and `checkBackup` all refuse above 64 MiB (`views/system/backup.server.ts:52,60`; `user-work/backup/backup.server.ts:70`). Nothing limits a case to a total amount of saved user work below that boundary: individual notes and register entries are bounded, their total count is not (`src/lib/local-case/user-work.server.ts:32-33,106-115,151`).

**Synthetic construction:** enough individually valid near-64-KiB transcript/register entries exceed 64 MiB after backup metadata and pretty-printing. The download succeeds as a ClearCase backup, but restoring its unchanged bytes fails. The pre-restore JSON copy has the same problem (`backup.server.ts:111`), though the separate SQLite backup remains another recovery mechanism. This is not total loss of all recovery options.

**Smallest immediate fix:** validate the exact serialized UTF-8 size before offering a backup as restorable, show the limit and an explicit supported recovery alternative, and never silently truncate. To meet the general round-trip goal, provide a bounded/chunked or streaming backup-and-restore format; merely increasing an arbitrary ceiling repeats the defect later.

**Validation:** generated user work just below/at/above the byte limit, including non-ASCII and JSON-escaped text, with download→unchanged restore and pre-restore recovery. Existing oversized-input rejection tests (`tests/system/backup.test.ts:116`) cover only the reader side.

### D8 — P2: a Word index can link a changed source selection to the old generated PDF

**Confirmed predicate gap; high confidence.**

`src/lib/bundles/builder.ts:124-125` considers an output linkable when title, row count and destination page intervals match. It does not compare ordered source file identities or source intervals. `docxBundle` then uses the current rows but the old output's filename/index-page offset (`:130-132`). `Builder.svelte:100-102` exports this combination.

**Synthetic trace:** build a two-item bundle where each item occupies one page. Swap the two items (or change a segment to another one-page source) without rebuilding. Destination intervals remain 1–1 and 2–2, so `linkable` stays true. The exported Word index now describes the new ordering but links to the old PDF's pages. Page numbers existing in a PDF are not enough to establish that they contain the indexed evidence.

**Smallest fix:** compare the ordered source file IDs and source ranges against the immutable build snapshot before linking, or generate a linked index strictly from the output snapshot. Use a build/source digest when durable inputs arrive. Invalidating links can preserve harmless description-only edits if that is an explicit policy.

**Validation:** equal-page-count row swap, same-length range shift, replacement by a different same-size PDF, and unchanged-plan control. `tests/bundles/builder.test.ts:121-135` tests changed destination extents, but its final sequence restores the original range; it does not prove identity preservation after a genuinely different source selection.

## Sound designs and boundaries to retain

- **Strict package ingestion:** the bounded strict JSON parser rejects duplicate keys, including escape-equivalent keys, and makes `__proto__` inert. Canonical file bytes and content identities are checked before creating a candidate. Unknown optional schemas remain opaque; recognized malformed optional source datasets are retained as residuals. `src/lib/case-package/strict-json.ts`, `canonical.ts`, `validate.ts`, `import.ts`, and `v5/adapter.ts:122-148` form a substantially stronger boundary than plain JSON parsing. The reconstruction issue D3 should not be misreported as a failure of the strict parser itself.
- **Many field collisions are already repaired:** `keepAside`, `ownOrAside`, `putDerived`, and `setKeepingSource` preserve existing `source_` fields instead of overwriting them (`v5/carry.ts:44-60`; `newer-workspace.ts:24-30`). Tests specifically cover those cases. D3–D5 identify different lossy operations outside that protection.
- **User-work persistence:** results and user work are separate; note anchors use fingerprints and return ambiguous/missing states instead of guessing across versions (`local-case/user-work.server.ts:66-70`; `case-package/user-work.ts:17-22`). Seed overlays retain conflicts/orphans. Restore validates schemas and key collisions before mutation, runs in a transaction, preserves excluded tables, and does not restore activation/trust (`local-case/user-work.server.ts:309-386`). INTEGER/BLOB export uses tagged representations rather than lossy JSON numbers. These protections should remain while fixing caller-level delete and backup limits.
- **Calculations:** exact integer arithmetic handles imported sums and simple interest; date arithmetic avoids local-time/DST subtraction; typed amounts reject extra decimals rather than silently rounding. Compound/settlement floating-point evaluation is explicitly bounded and disclosed. The interest comparison checks dates and recorded payments rather than presenting unrelated bases as a reconciliation (`views/quantum/interest.ts:78-120`). No claim is made here about the legal correctness of a rate, prescription rule or allocation convention.
- **CSV boundary:** baseline `components/csv.ts:4-22` applies formula-start protection to imported and typed text, quotes separators, and has an explicit signed-money path. It intentionally changes dangerous text; spreadsheet CSV is not a byte-lossless archive. Package bytes and user-work backups should supply the lossless path. I found no confirmed additional CSV execution defect in this inspection and did not test Excel/LibreOffice behavior. Ordinary `JSON.parse` remains in backup/legacy paths; that deserves strict-boundary fuzzing, but the checksummed current backup format means duplicate-key acceptance alone is not proof of silent corruption of an unchanged generated backup. [ECMAScript's JSON.parse contract](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse) confirms that duplicate keys otherwise overwrite earlier values.

## Planned work, hypotheses, and follow-up evidence

**Tracked planned work, not new baseline defects:** durable uploaded bundle inputs, exact rendition/version pins, regeneration history and retention are explicitly GRS-128 (`docs/plan/tickets/HA-bundles.md:27-31`). The local builder intentionally retains only item lists after closing the window (`src/lib/bundles/builder.ts:135-140`). Complete hosted case export is GRS-118; production durable storage/user work are GRS-117/115; Markdown round-trip editing is GRS-23. Do not call these shipped merely because PR 114 proves related storage techniques. D1 and D8 are distinct correctness problems in already-available local user paths.

**Hypotheses requiring separate execution, not confirmed findings:** lossless handling of unusual SQLite affinities/collations across real backup restore, malformed legacy JSON numeric tokens, and finite but extreme compound-interest results. Existing defenses and tests are substantial; this review did not establish a new failure there. The backup's ordinary JSON parser is not a reason to remove the tagged 64-bit integer support by blindly replacing it with the package parser.

Highest-return validation order on a supported Linux host: (1) two-case builder navigation and two-tab stale deletion; (2) marker-preserving converter fixtures for dotted keys, duplicate sections and lossy coercion; (3) shared monetary display and same-page-count bundle identity; (4) bounded backup round-trip size tests. Then run the relevant unit suites through receipt tooling and the real pilot workflow at the **fixed commit SHA**, followed by the required gate/parity checks. No test result in this report substitutes for those runs.
