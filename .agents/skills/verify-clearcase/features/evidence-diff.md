# Document Diff (evidence)

Document Diff compares the indexed text excerpts of two documents the user chooses, word by word or line by line (v5's LCS diff). It never pairs documents itself: the page says the pair is compared because the user chose it, how many documents have an excerpt to compare and how long excerpts are, and for each comparison the excerpt length and text status of both sides. Every document with an excerpt can be chosen.

## How to get to it (user POV)

- Choose `Document Diff` (`#nav-hoa_diff_tab`), or open `/v/<rv>/evidence/hoa_diff_tab?a=<ref>&b=<ref>&mode=words|lines`.

## Driving it with verify-clearcase

- **Open.** `main[data-ready=hoa_diff_tab]`, `data-result=none`, heading focused, `#diff-coverage`.
- **Compare.** Choose `#diffA`, `#diffB` and `#diffmode`, then `#diff-run`. `main[data-result=diff]`; `#diffOut h3` reads `<A> vs <B>`; `#diff-body` holds text and `span.diffdel` / `span.diffadd`; `#diff-pair-coverage` states both excerpts.
- **One document.** With `#diffB` on `— pick —`, `#diffOut .empty` reads `Pick two documents.`

## Gotchas

- Read segment classes with `classList.contains`: Svelte adds a scoped class to each span.
