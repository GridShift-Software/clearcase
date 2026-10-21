# Make the CC-11 matrix refuse crashed or partial evidence inputs

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-68/make-the-cc-11-matrix-refuse-crashed-or-partial-evidence-inputs) is the execution authority.

The <issue id="9c8b3267-fbf1-4821-a6f1-69ff48337884" href="https://linear.app/vaper/issue/GRS-21/verify-complete-v5-parity-and-local-release-readiness">GRS-21</issue> fix re-check at `e604b7a` (RECHECK-21) closed H1, H2, M1 and M2 from the second review. It found one new fail-open in `scripts/verify/matrix.mjs`. The committed results are not affected: both real layout runs cover 42 views with no error.

* **Medium (probed):** the matrix reads only `failures` from the layout inputs (`matrix.mjs:98,104`). `layout.mjs:248-255` writes a stamped `layout.json` from its `finally` block even when the run throws. In the probe, a layout input cut to 4 views, with `exit: 2` and an error, still produced "42 PASS". Fix: BLOCK when `exit` is 2, when `error` is set, or when `views` does not hold every `VIEWS` id. Apply this to both the synthetic and v5 layout inputs.
* **Low:** `isSha` at `matrix.mjs:78` accepts any prefix. Require at least 12 characters.
* **Low:** only the root e2e `summary.json` is stamped (`matrix.mjs:50-60`). A per-category `*/summary.json` left over from an earlier gate would still count.

Until this is fixed, the coordinator checks `exit`, `error` and the view count in both `layout.json` files by hand whenever the matrix is regenerated.

Write reservation: scripts/verify/matrix.mjs and tests/gate/matrix.test.ts. First reconcile the accepted head: if the exact failure classes are already fixed, independently verify and close with receipts rather than reimplementing them.
