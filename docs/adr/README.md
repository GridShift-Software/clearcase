# Decision records

These ADRs record the product decisions the user confirmed from 11 to 16 October 2026. Records 0001 to 0006 govern the local v5 pilot; records 0007 to 0011 govern the hosted alpha. The 12 October answers refer to the orchestrator's 23-item V1 questionnaire. Each record says whether a decision is accepted, conditional or still pending, and names the issues and pull requests it affects.

| ADR | Decision | Status | Affects |
| --- | --- | --- | --- |
| [0001](0001-v5-parity-and-calculation-rules.md) | Full v5 parity and calculation rules | Accepted, 11 Oct | GRS-16 (#16), GRS-17 (#18), GRS-18 (#17), GRS-21 |
| [0002](0002-approved-v1-behaviour-corrections.md) | Approved V1 behaviour corrections (items 3–6 and 8) | Accepted, 12 Oct | GRS-14 (#19), GRS-15 (#20), GRS-16 (#16), GRS-17 (#18), GRS-18 (#17), GRS-19 (#22), GRS-45 |
| [0003](0003-analysis-additions-behind-a-flag.md) | Analysis additions behind a default-off flag (item 2); escaping fixes apply in both states | Conditional, 12 Oct | GRS-15 (#20), GRS-48 |
| [0004](0004-local-rescan-backup-and-case-import.md) | Local rescan, backup and per-case import/update (item 7) | Accepted, 12 Oct; importer design pending | GRS-20 (#21), GRS-47 |
| [0005](0005-numeric-monetary-csv-credits.md) | Validated monetary credits stay numeric in CSV (item 9, option A) | Accepted, 12 Oct; implementation pending | GRS-49, GRS-13 (#15) |
| [0006](0006-local-case-pack-import.md) | The local app converts a case pack itself (import by clicking) | Accepted, 13 Oct; PRs in review | GRS-70 (#42), demo build (#43) |
| [0007](0007-hosted-client-isolation-and-identity.md) | One isolated client instance per client, Global Admin and firm admin roles, assigned case viewer/editor grants, audited service-team access, Clerk authentication | Accepted, 14 Oct; audit contract and SSO open | GRS-85, GRS-113, GRS-114, GRS-116 |
| [0008](0008-workers-runtime-and-cloudflare-first-stack.md) | Hosted SvelteKit on Workers with Bun builds; per-client Worker, D1, R2, secrets and subdomain in one Cloudflare account; per-client and internal Clerk applications, invite-only, MFA initially off | Accepted, 14–15 Oct; runtime, storage, identity and tooling proofs UNRUN | GRS-86, GRS-26 (GRS-106 to GRS-111), GRS-36 (GRS-112 to GRS-118) |
| [0009](0009-manual-queue-and-candidate-import-contract.md) | Shared FIFO processing queue, one results-import contract into private candidates, hosted Rescan & Update through the same path | Accepted, 14 Oct; Rescan & Update 16 Oct; SLA metric open | GRS-87, GRS-28 to GRS-30, GRS-134, GRS-135 |
| [0010](0010-exact-version-signoff-and-publication.md) | Exact-version sign-off, explicit publisher, editable private candidates with audited corrections, failed required content holds the update | Accepted, 15 Oct; review topology proof UNRUN | GRS-88, GRS-30, GRS-31, GRS-130 |
| [0011](0011-originals-and-complete-in-app-file-viewing.md) | Unchanged originals, every accepted format viewable in the app, verified citations, complete exports, durable PDF bundle versions | Accepted, 15 Oct; viewer selection and proofs UNRUN | GRS-90, GRS-97, GRS-120 to GRS-123, GRS-118, GRS-128 |

## Superseded for the hosted app

These earlier statements still hold for the local pilot but not for the hosted alpha. The older records are not rewritten.

- **Bun in production and a durable local disk.** The workspace rule that production runs as `bun build/index.js` with SQLite applies to the local pilot. The hosted app runs in Workers with D1 and R2 ([ADR-0008](0008-workers-runtime-and-cloudflare-first-stack.md)).
- **Local rescan.** [ADR-0004](0004-local-rescan-backup-and-case-import.md)'s folder rescan applies to the local pilot. Hosted Rescan & Update submits files through the processing queue and private review ([ADR-0009](0009-manual-queue-and-candidate-import-contract.md)).
- **Local case-pack conversion.** [ADR-0006](0006-local-case-pack-import.md) applies to the local app. Hosted results arrive only through the results-import contract as private candidates.

## What these records do not decide

- **Unanswered questions.** Item 1 (evidence) and those of items 10–23 (V2 and launch) that records 0007 to 0011 do not settle have no answer. Nothing in these records approves them. Dates and cost figures in older V2 drafts are not current evidence.
- **Proofs.** The hosted records choose a design. Every runtime, storage, identity, recovery, viewer and notification proof they name is UNRUN until its owner reports PASS at an exact SHA.
- **Release approval.** Accepting a decision does not waive the diff review, the external PR review, `bun run --bun gate`, the parity gate or any milestone gate. Each change still has to pass them at its exact SHA.
- **Register approval.** Product-visible entries in `docs/reference/parity/intentional-differences.json` keep `approvedBy: null` until the user approves them in the relevant PR. These ADRs do not fill that field.
- **Production and hosted implementation.** No record authorises production changes, hosted implementation, provisioning, transfer of real case data by agents, or any unresolved hosted choice. Hosted work waits for approval of the complete plan ([GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha)).
- **Operating targets.** Spend targets, worker limits and similar reversible operating choices are kept in the delivery operating plan, not in ADRs.
- **Missing links.** Missing package-file links (GRS-45) and missing captions remain defects to fix. They are not accepted gaps.

## Adding a record

Number the next ADR sequentially, keep it short, and add a row above. Supersede a record by adding a new one and marking the old one `superseded by ADR-NNNN`; don't rewrite history.
