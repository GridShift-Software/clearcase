---
status: conditional
date: 2026-10-12
---

# Analysis additions behind a default-off flag

Item 2 of the questionnaire covered additions to the analysis views: defence-matrix references shown in the display and the CSV export, and heading additions. The user accepted them on 12 October 2026, on condition that a feature flag controls them until the client approves full inclusion. The flag gates only these additions. It does not gate correctness: timeline escaping fixes apply whether the flag is on or off.

Until the client approves, the flag defaults to off. This is the conservative direction: with the flag off, v5's functions and layout are preserved and nothing is removed, but correctness and escaping fixes still apply. The flag is never a reason to restore a v5 escaping bug. Client approval is absent: no record of it exists, and nobody may treat the flag as approved or switch its default without one.

Considered options: ship the additions unconditionally, which the client has not approved, or drop them, which loses work the user accepted.

## Consequences

- GRS-48 uses the server-side `CLEARCASE_ANALYSIS_ADDITIONS` flag. Unset, `0`, and every value other than exactly `1` keep additions off. For an explicit review session, start the app with `CLEARCASE_ANALYSIS_ADDITIONS=1 bun run --bun start`; this opt-in does not record client approval.
- The flag controls the defence matrix free-text Refs display. The supplied `db73856` base already exports the Refs column and uses the navigation-label headings; both remain byte-identical with the flag off and remain available with opt-in. Document citation chips, checklist saves, escaping, focus and unrelated views remain available.
- Fix-round instruction, 17 October 2026: "the flag-off path must be byte-identical to the base." This pins compatibility to `db73856`, rather than reconstructing older v5 headings or removing an existing CSV column. It does not record client approval.
- Run the synthetic analysis browser suite once per flag state. Its display expectations are conditional; baseline export bytes and headings are invariant; timeline-title escaping is checked in both states. Real-v5 parity evidence for both states is still required before acceptance.
- Timeline escaping fixes ship in both flag states and are not part of GRS-48's gating.
- When the client approves, a new ADR supersedes this one and the default changes in a reviewed PR.

Affects GRS-15 (PR #20) and GRS-48.
