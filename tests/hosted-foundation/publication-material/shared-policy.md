# Shared import/publication validation policy: source-only evidence

`shared-policy.test.ts` reproduces M1 through the real request composer: a canonical synthetic manifest with two
700,000-character extension values is larger than 1 MiB but smaller than the explicitly configured 2 MiB file budget.
The actual validator/stager/native importer links it privately. The old fixed material policy rejects those immutable
bytes with `integrity`; the composed shared policy reads them with unchanged content identity and diagnostics.

`validation-policy.ts` derives all six resource limits from validated storage budgets: `packageFiles`, `fileBytes`,
`manifestBytes`, `packageBytes`, `originalBytes`, `originalsTotalBytes`. Every other canonical parser rule is retained.
Tests observe genuine validator calls in all three stager passes and material revalidation, exercise smaller/larger
bounds, immutable factory capture, configuration refusal, and exact over-budget diagnostics. No allocation defaults
are supplied. A missing renderer still returns pending previews and a 422 `preview-not-ready`, without sign-off,
publication or an apply receipt.

Parent light-check hooks (run through `scripts/agent-tools/receipt` at the committed parent head):

- `bun run --bun test --config tests/hosted-foundation/publication-material/vitest.config.ts --maxWorkers=1`
- `bun run --bun test --config tests/hosted-foundation/native-stager/vitest.config.ts --maxWorkers=1`
- `bun run --bun tsc --noEmit -p .`
- `bun run --bun check:hosted-imports`

Identity and SQLite/R2 transports are explicit doubles; these checks are not native acceptance. Native runtime,
providers, real authentication, deployment, browser checks, full suites and full builds remain UNRUN here.
