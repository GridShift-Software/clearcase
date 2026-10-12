---
status: conditional
date: 2026-10-12
---

# Analysis additions behind a default-off flag

Item 2 of the questionnaire covered two additions to the analysis views: defence-matrix references shown in the display and the CSV, and timeline changes that escape text correctly and make headings match. The user accepted them on 12 October 2026, on condition that a feature flag controls them until the client approves full inclusion.

Until the client approves, the flag defaults to off. This is the conservative direction: with the flag off, the v5 functions behave as v5 does and nothing is removed. No record of client approval exists. Nobody may treat the flag as approved or switch its default without one.

Considered options: ship the additions unconditionally, which the client has not approved, or drop them, which loses work the user accepted.

## Consequences

- GRS-48 builds the flag. These records implement nothing.
- When the client approves, a new ADR supersedes this one and the default changes in a reviewed PR.

Affects GRS-15 (PR #20) and GRS-48.
