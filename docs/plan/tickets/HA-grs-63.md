# Build the V2 prompt-pack eval harness

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-63/build-the-v2-prompt-pack-eval-harness) is the execution authority.

## Outcome

A prompt change to the V2 processing prompt pack gets three separate verdicts from one command: does it still resolve functionally the same (Function), is the content better or worse (Content), and has rigour been lost (Rigour).

V2 rewrites the pack (`RAWS/ClearCase Prompts.zip`, which today produces a single-file HTML) so that the model emits data only. For each section it writes one JSONL file whose records have a stable `id`, an `order` and `refs[]`. A new adapter compiles those files into the existing `v5.*@1` datasets of a results package. This issue builds the harness that measures any prompt change, plus one pilot section (the risk matrix) that goes through it end to end. ADR 0006 (`docs/adr/0006-v2-prompt-pack-data-contract-and-evals.md`, in review) records the decisions.

## Scope

* `bun run --bun evals` CLI, with results under the ignored `.local/evals/`:
  * `check`: free code checks, runs in seconds.
  * `run <section> --k N --live|--replay --budget USD`.
  * `compare vN vM <section>`.
  * `calibrate <section> --labels FILE`.
  * `show <run> --failures`.
* Three layers of checks:
  * L0 compares sections that code generates to golden files. These are the document index and derived data: prescription, recon, counts, and copied titles and dates.
  * L1 reuses the `validate` code checks (shape, counts, refs, unresolved citations, bare mentions, links, dates) and adds new ones:
    * derived fields agree with the chronology;
    * enums, and length bounds;
    * `id` and `order` present, and `id` continuity between runs;
    * authorities appear on an allow-list;
    * the prescription interruption date is cited and within range.
  * L2 is model-graded: key-fact coverage, citation support, rigour counts, pairwise comparison. It runs only in the eval loop, with k samples, a cost cap, and a record and replay cache.
  * L0 and L1 run in `gate`. L2 never runs in `gate` or CI.
* Model calls use `output_config.format` with a JSON schema. The harness checks refs in code. It sets effort explicitly on every call, because Opus 5.5 defaults to medium. It sends no sampling parameters, because they return 400 on the 5.5 models.
* Gold sets:
  * Tier 1 is a synthetic case with planted facts, built by extending `scripts/fixtures/v5fixture/`. It runs in CI.
  * Tier 2 uses the authored datasets of the v5 sample as the baseline on the real case. It runs locally only.
  * Human-labelled sets come later. Until then, judge scores are advisory and never pass or fail a change.
* Each section has one prompt template, one JSON schema and one gold checklist.

## Out of scope

Rewriting the prompts beyond the one pilot section. OCR, which is a separate research item. The `@2` schemas. Hosted processing.

## Blockers

None are hard. Related: [GRS-22](<https://linear.app/vaper/issue/GRS-22/import-and-verify-the-newer-2131-document-export>), [GRS-23](<https://linear.app/vaper/issue/GRS-23/round-trip-one-manually-authored-analysis-through-markdown>), [GRS-33](<https://linear.app/vaper/issue/GRS-33/design-pi-durable-processing-against-the-proven-manual-contract>).

## Acceptance

- [ ] The CLI has all five subcommands and `docs/development.md` documents them.
- [ ] `evals check` runs offline in seconds and `bun run --bun gate` runs it.
- [ ] The risk-matrix pilot has a prompt template, a JSON schema, and an adapter whose output `validate` accepts.
- [ ] L0 and L1 are green on the synthetic case.
- [ ] One L2 run at k=5 has its cost recorded. A `--replay` of that run costs nothing.
- [ ] `compare` prints Function, Content and Rigour verdicts with paired confidence intervals.
- [ ] No case text, names or amounts appear in Git, fixtures, or any JSON schema sent to the API. A leak scan passes.
- [ ] No L2 code path is reachable from `gate` or CI. A test shows it.

## Verification

Report PASS or FAIL at an exact SHA. `bun run --bun gate` must be green at that SHA. Report the spend of the L2 run in USD, and the paths of the recorded run and its replay under `.local/evals/`.

## Forbidden

Case text, names or amounts in Git, fixtures or JSON schemas. L2 in `gate` or CI. Codex, Cursor, and effort `max`. Writes to `RAWS/` or production.

Hosted-alpha sequencing: this advanced prompt-pack evaluation/pilot is later M6 work after the manual hosted workflow is proven; it does not block alpha. The alpha operator-handoff issue must still prove a fresh complete results package using its actual manual recipe, without pretending this risk-only pilot supplies every required section. Preserve the existing synthetic-only external model/eval boundary and explicit budgeted live runs.
