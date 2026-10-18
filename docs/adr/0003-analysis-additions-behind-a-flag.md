---
status: conditional
date: 2026-10-12
---

# Analysis additions behind a default-off flag

Item 2 of the questionnaire covered additions to the analysis views: defence-matrix references shown in the display and the CSV export, and heading additions. The user accepted them on 12 October 2026, on condition that a feature flag controls them until the client approves full inclusion. The flag gates only these additions. It does not gate correctness: timeline escaping fixes apply whether the flag is on or off.

Until the client approves, the flag defaults to off. This is the conservative direction: with the flag off, v5's functions and layout are preserved and nothing is removed, but correctness and escaping fixes still apply. The flag is never a reason to restore a v5 escaping bug. Client approval is absent: no record of it exists, and nobody may treat the flag as approved or switch its default without one.

Considered options: ship the additions unconditionally, which the client has not approved, or drop them, which loses work the user accepted.

## Consequences

- The flag is the server-side `CLEARCASE_ANALYSIS_ADDITIONS` (GRS-48). It defaults to off: unset, `0` and every value other than exactly `1` leave the additions off. The user's answer of 12 October 2026: "make a feature flag for now, need client approval before include fully". `CLEARCASE_ANALYSIS_ADDITIONS=1 bun run --bun start` previews the additions for a review session; it does not record client approval.
- The flag gates all three additions (the user's decision of 18 October 2026). With it off the analysis views behave as v5's: the defence matrix hides its free-text Refs column, the defence CSV has no `refs` column, and Timeline, Defence & Rebuttal and Info Required keep v5's headings (Chronology & Timeline, Defence & Rebuttal Matrix, Information & Documents Required). With `1` all three show. That decision came from the product owner. It does not record client approval either.
- The parity register records the flag-off state, the one the gate runs. The entries that registered the additions as intended differences (IDR-150, IDR-155, IDR-157 to IDR-159, IDR-163 and IDR-169) are retired. S-vdm_matrix_tab-1 and S-timeline-4 are known gaps while the flag is off.
- Timeline escaping fixes ship in both flag states and are not part of GRS-48's gating.
- When the client approves, a new ADR supersedes this one and the default changes in a reviewed PR. That PR registers the differences again under new ids.

Affects GRS-15 (PR #20) and GRS-48.
