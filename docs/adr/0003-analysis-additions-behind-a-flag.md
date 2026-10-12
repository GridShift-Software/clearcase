---
status: conditional
date: 2026-10-12
---

# Analysis additions behind a default-off flag

Item 2 of the questionnaire covered additions to the analysis views: defence-matrix references shown in the display and the CSV export, and heading additions. The user accepted them on 12 October 2026, on condition that a feature flag controls them until the client approves full inclusion. The flag gates only these additions. It does not gate correctness: timeline escaping fixes apply whether the flag is on or off.

Until the client approves, the flag defaults to off. This is the conservative direction: with the flag off, v5's functions and layout are preserved and nothing is removed, but correctness and escaping fixes still apply. The flag is never a reason to restore a v5 escaping bug. Client approval is absent: no record of it exists, and nobody may treat the flag as approved or switch its default without one.

Considered options: ship the additions unconditionally, which the client has not approved, or drop them, which loses work the user accepted.

## Consequences

- GRS-48 builds the flag. That follow-up implementation is still pending, and these records implement nothing.
- Timeline escaping fixes ship in both flag states and are not part of GRS-48's gating.
- When the client approves, a new ADR supersedes this one and the default changes in a reviewed PR.

Affects GRS-15 (PR #20) and GRS-48.
