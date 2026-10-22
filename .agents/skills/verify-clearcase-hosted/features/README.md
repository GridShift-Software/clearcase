# The hosted feature map

What `verify-clearcase-hosted` drives in the hosted-gate artifact on local workerd, one file per user-facing feature. `bin/verify-clearcase-hosted features` lists them by discovery and checks each file's contract; there is no list to edit.

| Feature | Step | Boundary behind it |
| --- | --- | --- |
| [identity-sign-in](identity-sign-in.md) | `sign-in` | identity: test double (GRS-113 replaces it with Clerk) |
| [case-open](case-open.md) | `open-case` | store: D1 fixture tables through a double (GRS-115, GRS-117) |
| [original-open](original-open.md) | `open-original` | assets: R2 originals through a double (GRS-115, GRS-118) |
| [access-denied](access-denied.md) | `wrong-client` | identity and assets doubles; the deployment's client var |

Each file has an H1, one paragraph, then `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-clearcase-hosted` and `Gotchas`. The driving section names each step it drives as ``Step `<id>` ``, and each step in `../lib/steps.mjs` names its feature file; `features` and every run refuse a mismatch.

## Extending

An owner who replaces a double (GRS-113 identity, GRS-115 storage and assets, GRS-120 viewer) updates that feature's file and its step in `../lib/steps.mjs` in the same change, keeps the selectors the stable handles listed here, and makes the gate summary's boundary entry say `real` only for a boundary a real provider answered. A new feature gets a file here and a step there. Run `bun run --bun gate:hosted` at the final SHA before handoff. The standalone skill run is available for focused debugging; a passing gate already includes its lifecycle and feature drive.
