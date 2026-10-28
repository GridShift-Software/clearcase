# 20: RC gate, Monday 2 November
**Wave:** 3 · **Size:** 0.5 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
By the end of Monday 2 November staging is a working release candidate: v5 published, every original loaded, a few notes, deadlines and a custom bundle pre-loaded so those screens are not empty, and J1–J10 run from a South African network at a recorded SHA, with pages under 2 s, the first PDF page under 3 s, sign-in under 5 s and no 401 or 503 across a 20-minute idle. Each failing step becomes a `journey-fail` Linear issue naming the step, the SHA and the measured value. A rollback SHA is recorded.

How: `spec.md` "The release gate" and `research/journeys.md` "Staging". The owner's Astra on the South African network runs `MODE=hosted BASE_URL=https://clearcase-staging.shiny-sunset-211d.workers.dev CASE_ID=v5-demo RESULTS_VERSION=<rv> EXPECTED_SHA=<sha> IDLE_MINUTES=20 bun tests/journeys/run-all.mjs` three times; p95 per step from the three runs. Before the run, pre-load through the UI on staging (synthetic text only): two document notes, two deadlines, one custom bundle with two synthetic PDFs; record what was loaded in `docs/sprint/rc/preload.md` with no case content. Record `docs/sprint/rc/2026-11-02.md`: SHA, version id, rollback version id, the per-journey table, the Linear keys of any `journey-fail` issues, and the `scripts/deploy-staging.sh --rollback` dry run. If 16, 17a or 18 are not merged, J7, J8 or J9 are reported as "not in scope at this SHA", not as failures. Any failure goes to the ticket that owns the step (README table); the fix follows the normal loop, and the gate is re-run on the new SHA.
## Reserved paths (edit only these; new files under them are fine)
- `docs/sprint/rc/`
Shared files this ticket owns, which others must not edit until it merges: none.
## Blocked by
- 06 TRACER · 08 Fast originals · 09a App session · 10 Restyle · 11 Chronology · 12 Documents · 13 Analysis part 1 · 14a Analysis part 2 · 15 Search (merged into the sprint branch); 16, 17a, 18 if merged by Monday
## Acceptance
- [ ] `docs/sprint/rc/2026-11-02.md` exists with the SHA, `/health` revision match, version id, rollback version id and the J1–J10 table (three runs, p95 per step).
- [ ] J1 (shell, 42 entries or "coming soon"), J2, J3, J4 (three bands), J5 (24 views or "coming soon" for unported), J6 pass at p95 under 2 s per page and 3 s for the first PDF page.
- [ ] Sign-in under 5 s p95; J10 with `IDLE_MINUTES=20`: no 401 or 503, no failed request, no page error.
- [ ] Every failing step has a `journey-fail` issue (Urgent, label `sprint-hosted-demo`) naming step, SHA and value, assigned to the owning ticket's lane.
- [ ] Pre-load recorded; a colleague on a phone (390 px) confirms overview, chronology and one PDF open (three lines in the "Human log" document).
- [ ] Rollback proven on the preview or staging: `scripts/deploy-staging.sh --rollback` then redeploy, both under 2 min, in the record.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
MODE=hosted BASE_URL=https://clearcase-staging.shiny-sunset-211d.workers.dev CASE_ID=v5-demo RESULTS_VERSION=<rv> EXPECTED_SHA=<sha> IDLE_MINUTES=20 bun tests/journeys/run-all.mjs   # three runs, from the South African network
scripts/deploy-staging.sh --rollback && scripts/deploy-staging.sh                 # timed
```
## Read first
`spec.md` "Testing Decisions"; `research/journeys.md` (all); `docs/sprint/README.md` "Gates"; `tests/journeys/README.md`; `docs/sprint/runbooks/02-staging.md` and `06-publish.md`.
## Decisions already made (don't re-decide)
- The gate is measured from a South African network by the owner's Astra; boat or EU vantage points give functional coverage only.
- Targets are the spec's: pages under 2 s, first PDF page under 3 s, sign-in under 5 s, no 401 or 503 across 20 minutes idle, at a recorded SHA.
- Monday to Wednesday is bug fixing only; no new features after this gate. Wednesday 4 November is a full rehearsal on the demo laptop and network with the rollback SHA at hand.
- Pre-loaded user work is synthetic text; the real v5 content stays on staging and out of every record.
- Before the demo the owner confirms that v5 may be shown to the prospective client, or a scrubbed copy is used.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git (no case names, refs or dates in `docs/sprint/rc/`); new guards, receipts or process files; a second review round; loosening a journey budget to make it pass; redeploying sandboxes A or B; fixing product code in this ticket (file the issue, fix in the owning lane).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit (the record only); staging at the recorded SHA; J1–J6 and J10 pass there from South Africa; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
