---
status: proposed
date: 2026-10-26
---

# Integrity metadata is checked, not displayed

A dataset's `required` flag means a reader must understand its schema ([results package](../results-package.md#manifest)). The hosted sign-off gate also used it to mean that a view must display the dataset. That made `meta` and `source-layout` hold every converted package, although no client view shows either one. `meta` is the workspace's own summary counts. `source-layout` records key order so the v5 roots reassemble losslessly.

We decided that these two datasets are integrity metadata, not views. The registry declares them by exact key and schema (`meta` / `v5.meta@1`, `source-layout` / `v5.source-layout@1`). The gate checks each against its existing contract. A dataset that passes is `integrity-verified`; one that fails is `invalid`.

- **`meta`** passes when the canonical validator's META count check ran (both the `meta` and `chronology` schemas present) and found no disagreement. Validation only warns about a disagreement (`V5_META_COUNT_DISAGREEMENT`), but this check fails.
- **`source-layout`** passes when the datasets and the layout round-trip as the converter defines it. Every registered dataset sits at its registered source path, and no path is used twice. Reassembly returns every dataset unchanged. The layout the converter would record for the reassembled roots equals the stored one exactly. Converter and gate share one module, `src/lib/case-package/source-layout.ts`, so the Worker can use the same rule.

Sign-off clears `integrity-verified` only for those two keys. The state is part of the candidate snapshot, so the material digest pins it. Every other required dataset still needs its real hosted view rendered and checked, including `discovery-schedules` and `caselines-index`, which are view data. An unknown or new required schema stays `unsupported`. So does a known integrity schema under another key.

## Considered options

- **Keep `unsupported` until a view exists.** This was rejected: no view will ever display these datasets, so every converted package would hold forever.
- **Report `valid`.** This was rejected: `valid` means a view rendered and its markers were checked, and these datasets have no view.
- **Accept them by schema name alone.** This was rejected: a layout that drops a dataset, or a META that disagrees with its records, would pass.

## Limits

- The check proves that the layout is consistent with the package's own datasets. Without the original HTML it cannot prove the order matches the source bytes. A permuted `DATA` key order that lists exactly the datasets present still round-trips.
- A dataset whose source path lies outside the four v5 roots makes reassembly fail. One example is the newer export's unmapped analysis overlay (`mod_00_analysis.js:X`). Its layout is then `invalid`, so the check fails closed.

Status is proposed. The native alpha coordinator decided this under its autonomous alpha authority on 26 October 2026, in these words: "meta and source-layout are integrity metadata, not artificial display pages." It awaits wave review. There is no user answer to quote, and no human approval is recorded.
