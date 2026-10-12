---
status: accepted
date: 2026-10-12
---

# Validated monetary credits stay numeric in CSV

CSV exports neutralise cells that a spreadsheet could read as a formula, including cells that start with `-`. That rule also prefixes a validated negative credit such as `-500.00` with an apostrophe, so a spreadsheet reads it as text and leaves it out of totals. On 12 October 2026 the user chose option A for item 9: a monetary value that has passed validation exports as a plain number, including a negative credit. Free text keeps the full formula protection, including after `;`, tab, CR or LF within a cell.

Considered option: neutralising every leading `-`. It is safe but breaks totals in the exported sheet.

## Consequences

- The exemption applies only to values the app has already validated as monetary. Imported or free-text cells that look numeric are still protected.
- GRS-49 implements this. Until it merges, the current exports keep neutralising these values.

Affects GRS-49 and the shared CSV rules from GRS-13 (PR #15).
