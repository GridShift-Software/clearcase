# CC-23 / GRS-11 independent gate

**FAIL at `c3c773cf4016d02ab22d62754c6eab5a23ca9401`. GRS-12 is blocked.**

GRS-9's designated reference passes this gate with the brief's accepted follow-ups. GRS-10 fails containment and link-length rejection: directory entries outside the case folder are read during fallback lookup, and over-long Markdown destinations are accepted. No implementation files were changed by this gate.

## Blocking finding G1

`src/lib/case-package/originals.ts:89` calls `readdir(cur)` before checking the real path of each traversed directory. The later check at line 74 only runs when the complete original path resolves.

Synthetic reproduction:

1. Create sibling `case/` and `outside/` directories.
2. Make `case/linked` a symlink to `outside/`.
3. Index `linked/secret.pdf` with a valid synthetic PDF fingerprint.
4. Put `Secret.PDF` in `outside/`, then repeat with that name absent.

Both imports open and read `outside/`. Linux inotify reports directory `IN_OPEN` and `IN_ACCESS`. When the matching name exists, the import rejects with `ORIG_ESCAPE`; when it does not, the import returns a candidate with `ORIG_MISSING`. This reveals filename existence outside the authorized folder. The fixed gate rule blocks any case-folder escape; directory entries are filesystem content. No outside file bytes were read or served by this reproduction.

[The recorded observation](containment-observation.json) comes from a clean clone at the exact reviewed revision. The portable regression uses a real filesystem and the unmodified importer, with kernel observation rather than a mocked acceptance boundary.

Repair request: validate each directory's resolved containment before enumerating it; preserve escape rejection when the final child does not exist. Keep successful case/NFC fallback within the folder. A fresh worker must repair this, rerun the gate suite and affected upstream checks, and obtain an independent review at the repair revision. This gate does not authorize the pilot.

## Blocking finding G2

`src/lib/case-package/validate.ts:384` cuts bare Markdown destinations to 2,048 characters before `classifyLink` sees them. A valid synthetic package containing either `[x](https://example.invalid/` followed by 100,000 `a` characters and `)` or a reference definition `[x]:` with the same URL returns `accept`, with only `LINK_EXTERNAL` information. The complete note remains in the candidate. The identical URL in a link field or angle destination rejects. The contract's `LINK_RELATIVE_UNSAFE` error explicitly includes too-long locators (`docs/results-package.md:376`).

[The exact-head observation](link-length-observation.json) records these outcomes. The renderer still displays the note literally and performs no fetch; G2 blocks because a required rejection is missed. Repair request: detect an over-limit destination without substituting a shorter valid URL, while keeping scanning bounded. Both forms must reject with no candidate.

## Acceptance evidence

| Item | Result | Evidence |
| --- | --- | --- |
| 1. Fingerprints, records, views and inventory | PASS | Independently hashed archive/main; 1,689 rows, 42 NAV entries; [oracle reconciliation](oracle-diff.md) resolves all 26 count differences. |
| 2. Fresh conversion, malformed packages and mappings | PASS for the measured paths | Clean exact-head clone, frozen Bun install, check, 736 upstream tests, two conversions and validations, byte-identical 36-file packages, all ten package lanes. |
| 3. Data/user-work separation, literals and disclosed defects | PASS | All 13 pinned examples rerun twice; all 33,780 chronology values match; all 32 source mappings match; all 1,308 attachment relationships match; nested user work rejects. Source defects remain disclosed. |
| 4. Revision-bound verdict | PASS | The verdict applies only to the named upstream revision. Gate commits add tests and evidence, without changing that implementation. |
| 5. Tooling and BA register | Verified with a tooling-test follow-up | Doctor and source-pin comparison pass; plan/readback checks pass; all BA-01–BA-21 owners match. The optional tooling suite has 480 passes and two stale assertions, retained as failures. The 52-of-55 route sub-item remains HOLD, explicitly accepted as non-blocking by this brief. |
| 6. Hostile content, links, paths and limits | FAIL | Rendering and ordinary rejection controls pass; G1 breaches containment and G2 misses link-length rejection. |

Archive sha256: `(pinned in scripts/fixtures/profiles/v5-002.json)`.

Main HTML sha256: `(pinned in scripts/fixtures/profiles/v5-002.json)`.

The real fixture has 20 unresolved catalogue refs, retained as warnings; first-v5 activation requires acknowledgement. The package source values were inspected independently, not merely compared between two converter runs.

Performance at the reviewed revision on puk:

| Workload | Result | Fixed limit |
| --- | --- | --- |
| Conversion plus full validation, 20 warm samples after two warmups | Median 2,498 ms; p95 2,518 ms; max 2,520 ms; peak 350.4 MiB | 10,000 ms; 1 GiB; repeat median ≤3,118.75 ms (1.25 × accepted 2,495 ms) |
| Archive inventory, seven warm samples | Median 2.961 s; p95/max 3.092 s; peak 89,000 KiB | Repeat median ≤3.3375 s (1.25 × accepted 2.67 s) |

## Run the committed gate tests

Use Linux, Python 3 and Bun 1.4.2. Set `CLEARCASE_TEST_TMP` to a permitted scratch directory if needed. Set `CLEARCASE_CHROMIUM` to a Chromium headless executable; the default is the verified headless-shell location on puk. A missing browser or watcher fails rather than skips.

```sh
scripts/agent-tools/doctor
bun install --frozen-lockfile
unshare -rn bun run --bun test --config tests/acceptance/CC-23/vitest.config.ts
bun node_modules/typescript/bin/tsc --ignoreConfig --noEmit --target es2024 --module preserve --moduleResolution bundler --allowImportingTsExtensions --strict --skipLibCheck --types node tests/acceptance/CC-23/*.ts
```

Run checks through `scripts/agent-tools/receipt`, naming the reviewed base and a permitted receipt directory. The explicit config is required: the upstream default test include covers `tests/case-package/`, and its default typecheck excludes gate tests.

At the reviewed implementation, the gate suite returns exit 1: **25 pass, four regressions fail** (two containment cases and two link forms). The failed tests are deliberate release evidence and must not be skipped or changed to accept the defects. The browser control executes synthetic hostile markup; the rendered page has no execution or unsafe attributes.

## Accepted follow-ups and limits

The brief's six GRS-9 and six GRS-10 follow-ups were reproduced or inspected. Ref-less example verification and malformed HTML fail with exceptions; malformed profile/unprofiled variant builds cannot pass `--verify`; duplicate refs still fail verification. Unsupported-extension PDFs download, dangling outside symlinks have no original mapping, cross-case acknowledgements are stale, surrogate-name crashes produce no candidate, and key-order/negative-zero equivalence preserves the contract's canonical values. None is promoted to a blocker here. The unresolved production route sub-item stays HOLD.

Additional non-blocking findings include diagnostic and serving-filename surrogate cuts, a reserved-area alias through an internal symlink, leading BOM removal in zip member names, and narrow filename/Unicode/export policy gaps. The tooling suite's two failures at lines 641 and 671 expect the pre-app `MIN_BUN` source; the doctor correctly uses the present `packageManager` pin. Initial harness failures and corrected reruns are preserved locally.

The latest data/link probes also confirm quadratic reference-definition scanning (about 0.14, 0.54 and 2.33 seconds for 256 KiB, 512 KiB and 1 MiB notes), shape-error counts capped at eight, permissive provenance timestamp patterns and citation whitespace, and inert split-scheme prose. These remain non-blocking follow-ups or policy clarifications; their imports fail closed where structural errors exist, and inert text does not execute. The adversarial 62-note deadline overrun and full 256 MiB compressed-size variant were not personally rerun and receive no pass credit.

The hostile corpus has 335 recorded outcomes: 255 agree with its stand-in policy, 72 differ, and eight graph/interval cases lack a contract analogue. There were 302 real importer calls covering 290 corpus cases; 37 content payloads were checked as serving policy, and eight were unmapped. Serving-policy checks are not evidence of an implemented HTTP server. The adversarial hardlink observation is reproducible, but its blocking classification is refuted: a hardlink creates a regular directory entry inside the selected folder, and no outside pathname is traversed. The outside-directory read in G1 is a separate confirmed escape.

No archive HTML or scripts were executed. Historical private screens were inspected only as existing evidence. No new screenshots, production requests, Linear access, SQLite/server implementation checks, cold-cache claims or newer-export acceptance are included. Those are forbidden here or belong to later gates.

The full machine-local report, command inventory, receipts, corpus adaptations and case-dependent audits live under `/home/operator/Work/Active/MX-two/ClearCase/clearcase/.orchestration/reports/CC-23/`. Case-dependent outputs remain outside Git. The coordinator owns PR creation, external issue status and reconciliation of late adversarial results.
