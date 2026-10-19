# Case: open a provisioned case

A signed-in user sees only the cases their grants name and opens one by its stable case id. Case identity, label and publication state come from the local D1 fixture tables through the store double; results stay unavailable until GRS-117 and GRS-118, so a case with no publication shows `ResultsState` pending, and user work shows apart from results.

## Sub-features

- `case-list` on `/cases`: one `a[data-action=open-case][data-case-id]` per granted case, and no case of another client or without a grant.
- `case-shell` on `/cases/<caseId>`: `h1[data-case-id]`, `[data-results-state]`, `[data-originals-state]` with the originals, `[data-user-work-state]`.
- `wrong-case` answers 404 with no label for a case of the same client without a grant; *covered by `test:hosted`'s `denials` leg*.

## How to get to it (user POV)

- Sign in, then follow the case's link on `/cases`.
- The header's `ClearCase` link leads back to `/cases`.

## Driving it with verify-clearcase-hosted

Preconditions:

- `identity-sign-in` passed: the page is `/cases`, signed in as `client-a/a-viewer`.

- **Open.** Read the list, then click `a[data-action=open-case][data-case-id=case-a1]`. Step `open-case`. The list holds `case-a1` only; `/cases/case-a1` shows the heading "Synthetic matter A1", `[data-results-state=pending]`, `[data-originals-state=available]` with `a1-letter` and `a1-note`, and `[data-user-work-state=unavailable]`.
- **Proof.** The screenshot `case-a1`.

## Gotchas

- The fixture's case A2 is withdrawn and B1 belongs to client B; neither may appear on a-viewer's list.
- Results state is the case's, not a page default: when GRS-117 lands a published version, this step's expectation changes with the fixture.
