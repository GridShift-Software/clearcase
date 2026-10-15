# Document Diff (evidence)

Document Diff compares the indexed text excerpts of two documents the user chooses, word by word or line by line (v5's LCS diff). It never pairs documents itself: the page says the pair is compared because the user chose it, how many documents have an excerpt to compare and how long excerpts are, and for each comparison the excerpt length and text status of both sides. Every document with an excerpt can be chosen. A ref given in the URL that is not a document, or has no excerpt, is not compared and the page says why; a pair whose comparison table would pass 4,000,000 token pairs is refused with a message in `#diff-pair-coverage[data-too-long]`.

## Sub-features

- `diff-pick` offers every document with an excerpt for the explicit pair.
- `diff-compare` shows the literal word diff of the chosen pair and its compared coverage.

## How to get to it (user POV)

- Choose `Document Diff` (`#nav-hoa_diff_tab`), or open `/v/<rv>/evidence/hoa_diff_tab?a=<ref>&b=<ref>&mode=words|lines`.

## Driving it with verify-clearcase

Preconditions: `activate` passed on the synthetic case of `lib/inner.mjs` (`buildCase`, 7 rows); step `every-view` has opened this view once.

- **Open.** Step `every-view` (page and heading only). `main[data-ready=hoa_diff_tab]`, `data-result=none`, heading focused, `#diff-coverage`.
- **Compare.** *Not yet driven.* Choose `#diffA`, `#diffB` and `#diffmode`, then `#diff-run`. `main[data-result=diff]`; `#diffOut h3` reads `<A> vs <B>`; `#diff-body` holds text and `span.diffdel` / `span.diffadd`; `#diff-pair-coverage` states both excerpts.
- **One document.** *Not yet driven.* With `#diffB` on `— pick —`, `#diffOut .empty` reads `Pick two documents.`; a ref chosen by URL that cannot be compared adds `.diff-pick-reason`.

## Gotchas

- Read segment classes with `classList.contains`: Svelte adds a scoped class to each span.
