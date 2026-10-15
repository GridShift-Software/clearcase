# Litigation registers: Cross-Exam Prep, Heads of Argument, Authorities

Three preparation registers (GRS-18). Cross-Exam Prep shows the package's seed topics (`lit-crossexam-seed`, never copied) first, then the user's own topics; deleting a seed records an overlay `{deleted: true}`. Heads of Argument holds the user's submissions with evidence refs (linked when a ref names a document row) and exports a plain-text skeleton. Authorities shows the package's authorities, then the user's, and exports them as CSV. Every add keeps the typed values and shows an error when the store is busy or the app cannot be reached.

## Sub-features

- `crossexam-list` seeds first in data order, then user topics by insertion order; the view-content tip and the scope note.
- `crossexam-add` both Add buttons (page header and form) submit one form; a topic needs a witness or a topic.
- `crossexam-delete` a user row is deleted by row id; a seed by a `{deleted: true}` overlay; with nothing left, "No cross-exam topics yet."
- `heads-add` a submission needs a heading or a submission; numbered rows; evidence refs split on spaces and commas.
- `heads-export`, named by the package's view-content `heads_tab.exportFileName`, else `heads_of_argument.txt` with the `[data-export-note]` note beside the button: `HEADS OF ARGUMENT — <view-content caption>`, a blank line, then the numbered submissions.
- `authorities-add` an entry needs an authority; no edit or delete (as v5).
- `authorities-export`, named by `authorities_tab.exportFileName`, else `authorities.csv` with the note (`EXPORT-neutral`): header, imported rows unchanged, then user rows through `userCell`.
- `register-failure` a busy store or a lost request shows `[role=alert]` and keeps every typed field.

## How to get to it (user POV)

- Choose `Cross-Exam Prep` (`#nav-crossexam_tab`), `Heads of Argument` (`#nav-heads_tab`) or `Authorities` (`#nav-authorities_tab`) under Litigation strategy.
- Open `/v/<rv>/litigation/crossexam_tab`, `/litigation/heads_tab` or `/litigation/authorities_tab` directly.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed on the synthetic case. The plain synthetic case that `lib/inner.mjs` builds (`tests/case-package/fixtures/synth.ts`) has one seed topic and one imported authority; the litigation e2e suite uses `mainCase` (`tests/e2e/litigation/lib/cases.mjs`).

- **Open Cross-Exam Prep.** *Not yet driven by verify-clearcase* (driven by `tests/e2e/litigation/suite.mjs` `NAV-crossexam_tab`, `S7-crossexam`). Choose `#nav-crossexam_tab`. `main[data-ready=crossexam_tab]`; `#cx-table tr[data-kind=seed]` rows first; the h1 has focus.
- **Add a topic.** *Not yet driven* (`S7-crossexam`). Fill `#cx_w`, `#cx_t`, `#cx_put`, `#cx_docs`; press `#cx-add-header` or `#cx-add-form`. A `tr[data-kind=user]` row appears last and the inputs clear; work.sqlite `register_row` store `crossexam` has the row with `seq`.
- **Delete a seed.** *Not yet driven* (`S7-crossexam-delete`). Press the Delete of a `tr[data-kind=seed]`. The row goes; `seed_overlay` holds `{"deleted":true}` for its seed id; results are unchanged.
- **Draft heads.** *Not yet driven* (`S6-heads`, `S10-export`). Fill `#hd_head`, `#hd_sub`, `#hd_auth`, `#hd_ref` (`OD-001, XX-9`); press `#hd-add-button`. The row shows `OD-001` as `a.cite` and `XX-9` as text. Press `#heads-export`: the download is `heads_of_argument.txt`.
- **Add and export an authority.** *Not yet driven* (`S5-authority`). Fill `#au_topic`, `#au_auth`, `#au_prop`; press `#au-add-button`; the `tr[data-source=user]` row follows the imported ones. Press `#auth-export`: `authorities.csv`.
- **Failure keeps input.** *Not yet driven* (`FAIL-busy`, `FAIL-lost`). Hold `BEGIN IMMEDIATE` on `<data>/work.sqlite` for 13 s, or stop the server, then submit: `#cx-error` / `#hd-error` shows the error and every field keeps its value; nothing is written.
- **Proof.** The suite's `$CLEARCASE_E2E_OUT/litigation/<scenario>.json`.

## Gotchas

- Authorities have no Delete (v5 S-authorities_tab-1): rows a run adds stay. Use a fresh data directory.
- A deleted seed cannot be restored in this wave (no overlay-delete API); run probes that need the original seeds in a fresh data directory.
- Under `CLEARCASE_FIXED_NOW` rows share `createdAt`; order comes from the `seq` field, never from `listRows` order.
