# Enforcement Roadmap

The package's enforcement steps (`lit-enforcement`) by phase, in first-appearance order, with the view-content subtitle and "Why this matters" narrative (GRS-18). Each step's status saves on change as an override keyed by `stepKey` (sha256 of the canonical `{phase, step}`), never by position; the imported status stays unchanged and is shown under an override that differs. An imported status outside v5's options stays selected as its own option. A step whose `{phase, step}` repeats is disclosed and gets no status.

## Sub-features

- `roadmap-content` phases (`.chead`), steps, legal basis and notes (authored text with `[[REF]]` citations), footer and scope note.
- `roadmap-status` a status change saves (`[data-saved]`), survives reload and restart, and follows its step into a reordered results version.
- `roadmap-status-failure` a failed save shows `[data-save-error]` in the row and keeps the chosen value.
- `roadmap-duplicate` a repeated `{phase, step}` shows `[data-duplicate]` and no select.

## How to get to it (user POV)

- Choose `Enforcement Roadmap` (`#nav-enforcement_tab`) under Litigation strategy, or open `/v/<rv>/litigation/enforcement_tab`.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed on a synthetic case with enforcement steps (`tests/e2e/litigation/lib/cases.mjs` `ENFORCEMENT`).

- **Open the roadmap.** *Not yet driven by verify-clearcase* (`tests/e2e/litigation/suite.mjs` `S1-roadmap`). `main[data-ready=enforcement_tab]`; `tr[data-step=<64 hex>]` rows with a `select[name=status]`.
- **Change a status.** *Not yet driven* (`S2-status`). Choose `Done` in a step's select; `[data-saved]` appears in that row; reload: the select shows `Done` and `[data-imported]` names the imported status. work.sqlite `register_row` store `enforcement-status` holds `{stepKey, status, seq}`.
- **Busy store.** *Not yet driven* (`S2-status-busy`). With `BEGIN IMMEDIATE` held on `work.sqlite`, change a status: `[data-save-error]` shows and the select keeps the choice; after release, choose again to save.
- **Proof.** The suite's scenario JSON files.

## Gotchas

- `ENF_OPTS` is viewer code (a literal in the app), not results.
- A v5 `ess_dcs_enf_status_v1` index maps to a `stepKey` only within the same results version (see `mapV5EnfStatus`).
