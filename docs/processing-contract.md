# Processing output for hosted publication

Words follow [GLOSSARY.md](../GLOSSARY.md). The alpha loop is manual: download originals, process them, then upload the results zip for private review and sign-off. Import alone does not publish. GRS-205 is a post-alpha proposal, not a working pipeline; its stages are ordered:

1. Local OCR and CLI tools prepare the source material.
2. Schema-constrained extraction and classification with Clef and Clairic. Both are models, not deterministic tools (GRS-205), so their output can be wrong. What is fixed is the output shape and the checks on it: the package contract and its validation below. Re-running a stage can change values, so reconcile and validate every output.
3. A model performs cross-correlation on the extracted and classified output (GRS-205).

GRS-205 has two open blockers: the user has not decided whether case text may go to Workers AI, which would be a new third party; and Clairic has no open weights, so a self-hosted Clairic is not possible today.

Either route must produce the same [results package](results-package.md) and identify its unchanged originals. The producer obligations below are not all enforced on dev. Source references are pinned to dev `1ed4b6342d22ceca64b4f98e6d7363117692144e`.

The planned units belong to the real-export publication work (ADR-0013, and the proposed ADR-0014): U9 is scaled PDF evidence; U10 is asset policy states; U11 is the file-preview schema and validation; U12 is the META `disagrees` state; U15 is resumable import at scale. These labels describe planned work, not deployed behavior.

## Emit reconciled META

Compute each META count from records actually emitted after extraction and classification, not an earlier inventory or a model estimate. Include relevant zero counts and make definitions match the datasets; never omit records to force agreement. **Producer obligation; not fully enforced on dev.**

**Enforced on dev:** `V5_META_COUNT_DISAGREEMENT` is a quality warning, not a rejection, for differing derived counts and for absent bundle or docType counts (`src/lib/case-package/validate.ts:529-532`, `src/lib/case-package/codes.ts:113`). The hosted gate accepts `integrity-verified` only for an integrity dataset (`src/lib/publication/hosted/rules.ts:53-58`). **Arrives with unit U12:** legacy counts may use `disagrees` only when exact discrepancies have matching acknowledged fingerprints; unverifiable counts remain `invalid`. New output should reconcile instead.

## Extract embedded attachments

Extract each embedded attachment as a `file` asset with its own original bytes, path, size and sha256, and a `parentRef` naming its container. Preserve the source and parent relationship. **Producer obligation; not enforced on dev:** dev accepts an `embedded` asset without independent bytes (`src/lib/case-package/validate.ts:274,282`).

**Enforced on dev:** the validator checks the parent exists, is a container, and has no cyclic or overly deep chain (`src/lib/case-package/validate.ts:289-301`). A non-rendered required asset holds sign-off as `preview-not-ready` (`src/lib/publication/hosted/rules.ts:60-61`). **Arrives with unit U10:** the specific `embedded-not-extracted` hold.

## Supply converted file previews

Supply a faithful PDF file preview for each non-PDF `file` asset, including extracted attachments, bound to the original's sha256; keep the original unchanged and independently available. The preview must be readable and pass the hosted render check. **Producer obligation; arrives with unit U11:** the optional `preview` member and validation, including rejection of byte mismatches. Follow that schema when it lands; do not invent a wire format here. **Arrives with unit U10:** `preview-required` when absent. A converted preview must never present generated pagination as original pagination (`docs/adr/0011-originals-and-complete-in-app-file-viewing.md:16`; `docs/acceptance/viewers/contract.md:128`). See the page-citation rule below before using it.

**Enforced on dev:** rendering is attempted only for PDF `file` assets with an available fact that is not `downloadOnly` and with a configured `renderChecker` (`src/lib/server/runtime/hosted/publication-material.ts:281`). Non-rendered required assets hold sign-off as `preview-not-ready`; the U11 preview schema and named future checks do not exist at the pinned revision.

**Enforced on dev — import limits:** the code has no default budgets. Each client's deployment policy supplies `storageBudgets` and `importBudget`, and a missing or malformed bound makes storage unavailable (`src/lib/storage/cloud/budgets.ts:1-3`; `deploy/native-alpha/runtime-config.ts:135,203-206`). The stager refuses a package over `maxPackageBytes`, `maxPackageFiles` or `maxDocuments` (`src/lib/server/runtime/hosted/candidate-stager.ts:212-216`). The package schema itself allows 1,024 files (`src/lib/case-package/limits.ts:9`); a deployment's policy may set far lower bounds. Size an export against the target client's deployed policy. **Arrives with unit U15:** staged, resumable import, with the schema and policy limits raised to a reviewed ceiling and the per-request budgets unchanged.

## Keep refs stable across versions

Assign a valid unique ref to each document and retain it for that document in later versions of the case. Do not recycle or renumber refs; keep citations and asset mappings consistent, and preserve information for identity comparison. A changed package gets a new `resultsVersion`. **Producer obligation; no cross-version stability enforcement on dev, and none of units U9 to U15 covers it:** refs are package-local aliases, not proof of identity ([version policy](results-package.md#identity)).

**Enforced on dev:** `ID_DUPLICATE` checks uniqueness only among chronology refs (`src/lib/case-package/validate.ts:161`). `ID_REF_INVALID` covers four keys: a chronology `ref` that is missing or off the ref pattern (line 160); an asset key that is not a ref or `<ref>.a<ordinal>` (line 173); a package-file key that is not `P-` plus the first 16 hex digits of the path's sha256, or that belongs to an embedded or parented asset (line 181); and an embedded asset key that is not `<parentRef>.a<ordinal>` (line 282). `CITE_UNRESOLVED` reports a target missing from the package (`src/lib/case-package/validate.ts:428-431`).

## Cite pages that exist

Citations must resolve to supplied, indexed originals. For a page citation use a positive page that exists in the actual PDF rendition; check it against the exact preview bytes supplied for that version. Do not guess, clamp or silently renumber. **Producer obligation; converted-preview evidence arrives with unit U11.**

ADR-0011's exact rule is: “Converted previews identify their reviewed version and page. Preserve supplied original-document references and show original and processed-preview references when they differ and a verified mapping exists. Do not label generated pagination as original pagination. An unmatched supplied reference holds the candidate for operator repair; any reviewer correction is audited and requires fresh approval.” See [ADR-0011](adr/0011-originals-and-complete-in-app-file-viewing.md). The current dev implementation is stricter: “No clamp, renumbering, generated pagination or mutation of supplied references is permitted” (`src/lib/server/runtime/hosted/publication-material.ts:323-324`). Do not treat the planned converted-preview label as permission to bypass either rule.

**Enforced on dev:** unresolved, malformed or unavailable targets make `supplied-references` `invalid` (`src/lib/server/runtime/hosted/publication-material.ts:268-276`); for a rendered PDF, a cited page beyond the verified count fails with `page-reference-out-of-range` (`src/lib/server/runtime/hosted/publication-material.ts:289-290`). **Arrives with unit U9:** rasterise the first and every cited page and verify the exact count. **Arrives with unit U11:** extend evidence to converted previews.
