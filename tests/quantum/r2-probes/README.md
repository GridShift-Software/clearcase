# CC-06 r2 starting probes (synthetic)

The verification lanes' synthetic probes for the CC-06 fix round, copied from the lanes' folders before the cache could
be cleaned (`/home/vaper/.cache/cc06-v01`, `cc06-v02`, and `.orchestration/reports/CC-06/verify/lane-0N/probes`).
They are development probes, not tests: vitest collects only `*.test.ts`. Each `.ts` file has two added lines at the
top (`// @ts-nocheck` and `export {};`) so the type check skips it; the rest is unchanged, except that three dates the leak scan matched to case dates are replaced by synthetic ones (2081-2089). Lane 02's probes point at
its removed checkout; pass a checkout root where a probe takes one. The regression tests that replace them are
`tests/quantum/writes.test.ts`, `tests/quantum/r2-limits.test.ts` and the r2 scenarios of `tests/e2e/quantum/suite.mjs`.
