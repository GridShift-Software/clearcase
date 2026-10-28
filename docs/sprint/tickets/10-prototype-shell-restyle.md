# 10: Prototype shell restyle
**Wave:** 1 · **Size:** 1–1.5 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
Local and hosted look like the partners' prototype v0.1: a 240 px dark navy sidebar with numbered, grouped entries and a teal active edge; a 56 px top bar with search (Ctrl/Cmd+K focuses it), the published-version pill, the account name with sign-out and the case switcher; 6 px cards with a light shadow; 14 px body, 28 px KPI figures, 13 px tables with 40 px headers; a navigation drawer at 390 px. Views not yet ported show the "Coming soon" card. System font stack only; the Montserrat, Schibsted and Instrument font files are gone. Keyboard focus stays visible. J1 passes locally and on staging; screenshots at 1440 and 390 px match `research/ui-spec.md`.

How: `research/ui-spec.md` tokens table and sections 1–5, 19. Tokens and element rules live in `src/app.css` only (03 moved the hosted tokens there): adopt the prototype navy/teal, surfaces, text, borders, status pairs, radius 6, shadow, focus 2 px outline with enough contrast on teal. Style `AppShell.svelte` (grid: sidebar, topbar, main; drawer under 40 rem with a labelled toggle, focus return on close), `TopBar.svelte` (search 36 px high, Ctrl/Cmd+K handler, pill with a teal dot, account menu, "All cases" switcher), `ViewNav.svelte` (36 px rows, 11 px group labels, numbering from the group order, `aria-current`, greyed `soon` entries), `UnavailableView.svelte` (centred card, 48 px icon hidden from AT, 15 px/600 heading, "Back to overview"), `PageHeader`, `OverviewSlots` (four primary tiles 276 px wide, 16 px gap, anchors with visible labels), `DataGrid`, `TableScroll`, `Narrative`, `DegradedRows`, `ResultsState`, `ConfirmDelete`, `DateValue`, `OriginalOpen`. `analysis.css` and `quantum.css` take the shared tokens. Remove `@font-face` rules and `static/fonts/*` font files (keep nothing that references them). Local root and version layouts (`src/routes/+layout.svelte`, `src/routes/v/[vid]/+layout.svelte`) and the hosted root layout get the shell wiring only. Do not touch route `+page.svelte` files or `src/lib/views/**/*.svelte`: those take tokens through the stylesheet and belong to their feature tickets.
## Reserved paths (edit only these; new files under them are fine)
- `src/app.css`, `src/lib/views/analysis/analysis.css`, `src/lib/views/quantum/quantum.css`
- `src/lib/components/*.svelte`, `src/lib/components/*.test.ts` (styling and the drawer/Ctrl+K behaviour; `ShellData` props additive only)
- `src/routes/+layout.svelte`, `src/routes/v/[vid]/+layout.svelte`, `deploy/client/routes/+layout.svelte`
- `static/fonts/`
Shared files this ticket owns, which others must not edit until it merges: `src/app.css`, every `src/lib/components/*.svelte`.
## Blocked by
- 03 Route base and shared seams (merged into the sprint branch)
## Acceptance
- [ ] J1 passes locally and on staging (`bun tests/journeys/J1.mjs`): all nav entries open their view, shell under 2 s on staging.
- [ ] Screenshots at 1440×1000 and 390×844 of the overview, chronology (local), a coming-soon view and the sign-in page saved under `.local/ui/10/` and compared against `research/ui-spec.md` sections 1, 2, 3, 19: sidebar 240 px, topbar 56 px, main padding 24, card radius 6, KPI 28 px, nav row 36 px, drawer at 390 with no horizontal overflow (Astra or Playwright `getBoundingClientRect` values in the PR body).
- [ ] `getComputedStyle(document.body).fontFamily` names no web font; `git ls-files static/fonts` lists only the licence files or nothing; no `@font-face` in the repo.
- [ ] Ctrl+K and Cmd+K focus `search-input`; Enter navigates to the search view with `?q=`; Tab reaches every control with a visible outline (component tests plus a Playwright probe).
- [ ] The drawer toggle is labelled, `aria-expanded` reflects state, focus returns to the toggle on close; the nav keeps `aria-current="page"` (ViewNav tests).
- [ ] `bunx svelte-check --fail-on-warnings` 0 errors; `build:hosted` passes; bundle size delta in the PR (`wrangler deploy --dry-run`).
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun run --bun test src/lib/components tests/hosted-smoke/case-overview tests/system
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # screenshots at 1440 and 390, Ctrl+K, drawer; note ms
```
## Read first
`research/ui-spec.md` (tokens table, sections 1–5, 19; the rest for per-view tokens); `research/spike-hosted-views.md` trap 5; `research/journeys.md` selector contract; `docs/development.md` "Adding a view" (shared components).
## Decisions already made (don't re-decide)
- Fonts: system font stack only. Delete the three font families' files and rules.
- Follow the prototype for desktop shell, tokens, cards and placeholders; keep local route semantics, provenance text and truthful totals. No prototype surface selector, tray, "what changed" or Outlook.
- Phones get a drawer; the sidebar never pushes content below the fold. Keep the 16 px side padding and 358 px usable width at 390.
- `ShellData` (03) is the contract: style what it carries; add optional fields only, never rename. The hosted layout (06) is not yours.
- `src/lib/views/**/*.svelte` (RegisterPage, Builder, Kpi, TileWidget, EntryState) are styled through tokens only; their markup belongs to 17a, 18, 14a.
- An unported view shows "Coming soon" with a return link and no numbers; never a prototype sample value.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git (the prototype HTML stays out: it holds real dates); new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing route `+page.svelte` files, `view-registry.ts`, `views.ts`, `model.ts`, the hosted version layout (06's), `availability.ts` (03's, flipped by feature tickets).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J1 passes on staging and the two screenshot sets match the spec; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
