# Conflict Check

Screens a typed or picked name against this matter's people and entities only (GRS-18), as v5 matches (people first, then entities, a trimmed lower-cased substring over space-joined fields), and also folds width and diacritics (NFKD without marks, ß as ss), which v5 did not. The input hint is generic, with no personal data (v5's hint held a real company and e-mail address, S-conflict_tab-1). A scope disclosure, with counts from the data, always says what was searched and that a result is not a conflict clearance; the no-match line keeps v5's wording with neutral styling.

## Sub-features

- `conflict-pick` choosing a party in `#confsel` copies it (a person without the e-mail) into `#confq` and runs the check.
- `conflict-check` `#conf-check` runs the check; Enter does not (v5, S-conflict_tab-3).
- `conflict-result` `#confres .badge[data-result=matches]` with the Kind | Match | Detail rows, or `[data-result=none]` "No conflict match found for "<q>"".
- `conflict-scope` `#conf-scope` names the counts of people and entities searched.

## How to get to it (user POV)

- Choose `Conflict Check` (`#nav-conflict_tab`) under Analysis, or open `/v/<rv>/litigation/conflict_tab`.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed on a synthetic case; the litigation suite uses the checklist's example people and entities.

- **Known example.** *Not yet driven by verify-clearcase* (`tests/e2e/litigation/suite.mjs` `S8-conflict-known`). Type `org a` in `#confq` and press `#conf-check`: two rows, the correspondent first, then the entity.
- **Unknown party.** *Not yet driven* (`S9-conflict-unknown`). Type `zzz`, press `#conf-check`: `No conflict match found for "zzz"` with class `neutral`, and `#conf-scope` visible.
- **Input hint.** *Not yet driven* (`S8-conflict-known`). `#confq`'s placeholder holds no `@` and no imported value.

## Gotchas

- Only the package's `people` and `entities` datasets are read; this is not an external conflict register.
- Short queries match widely and matches can span field boundaries (v5 S-conflict_tab-2, copied).
