# CC-23 / GRS-11 independent gate

PASS at `ca46a49189b6aee69b2c536dc71589daceac5ac0`, round 2. This gate head merges repaired package `adf4fa9108dea063e6da9ce41f1c6142788ad2e4` into `feature/grs-11-gate-reference-package`.

G1 and G2 are fixed. Previously passing checks show no regression, and N1-N4 and N10 hold. The independent reviewer changed acceptance documentation only. The later evidence commit records this verdict; all release receipts bind to the clean reviewed merge revision above.

## G1

Before, an intermediate escaping symlink caused outside-directory IN_OPEN and IN_ACCESS events, with a verdict that revealed whether the outside filename existed. The unchanged kernel watcher now records zero of both events. Both variants return identical results, reject with ORIG_ESCAPE=1 and no candidate. The independent containment tests pass. The upstream regressions also cover deeper links, contained links and case/NFC matches.

## G2

Before, a 100,024-character inline or reference-definition destination was cut into a valid external URL and accepted. Both forms now reject with LINK_RELATIVE_UNSAFE=1 and no candidate. The unchanged independent tests pass. Upstream regressions also cover angle links, autolinks, entity shrinking and the 2,048/2,049 boundary.

## Follow-up fixes

| Item | Rechecked behavior |
| --- | --- |
| N1 | A 199-unit subject followed by an emoji is cut on a code-point boundary. A directory import returns frozen, canonicalisable diagnostics. The upstream invalid-ref regression still rejects. |
| N2 | The corresponding long filename produces a well-formed Content-Disposition header without URIError. |
| N3 | Directory aliases, folded aliases and file links into `.clearcase/` reject with ASSET_PATH_RESERVED and no candidate. |
| N4 | An ordinary stored zip accepts. A BOM-prefixed assets.json stays a distinct name and rejects with no candidate. |
| N10 | All 482 agent-tool assertions pass with package.json and its Bun packageManager pin present. |

## Acceptance evidence

All release checks passed at the clean reviewed revision. Receipt locations, capture hashes and local artifact hashes are bound in [execution-summary.json](execution-summary.json).

| Receipt | Result | Exit | Receipt SHA-256 |
| --- | --- | --- | --- |
| `doctor` | 21 required preflight checks | 0 | `af512e93e1f4b8a461e2455a362eae3fddd9d850965ddaa4d2ddca44c16e9b9f` |
| `r2-install` | Frozen Bun 1.4.2 install | 0 | `cc02e9a0be6273210072e8ff753ccc0582755e9315471654e3ef0a2ec2d24001` |
| `r2-check` | Types; 38 schemas; 71 accepted and 59 rejected examples | 0 | `bcff0842e304c1ace2e0ada25a8f2eeae3a7aa029fc00ab689e659c5485372b1` |
| `r2-test` | 751 passed, 0 failed, 0 skipped | 0 | `bea6145b01e6765df9e4c42d54028f5451ca4eaedf3c5ac64eab2cf75f99a831` |
| `r2-tooling-tests` | 482 passed, 0 failed; package.json present | 0 | `c671e1b76c3613309ae537659831bd2aa1a4c6031dfc868dee0492be78e9adb6` |
| `r2-gate-tests` | 29 passed, 0 failed, 0 skipped | 0 | `d93096313938a67fba8dc0f69d8c762c39b2194a232c251a8ad8a2f525585c3a` |
| `r2-gate-typecheck` | Strict gate typecheck | 0 | `f41be3ac8179a616d4960aeca6b44e5c0aa18cb0bd6042eb444a5b891402a9bf` |
| `r2-g1-observation` | No outside IN_OPEN/IN_ACCESS; identical results | 0 | `281083cf169bb70f161b50bc5a514537c65645040c96b5c5582376af7a673425` |
| `r2-g2-followups-observation-final` | G2 rejection and direct N1-N4 observations | 0 | `4499e1be286fa7b0ca8091860be95ddd8b2e19ce79d959e1d6d53639fcbedd2b` |
| `r2-inventory` | 33 checks; 1,689 records; 42 views | 0 | `aaa8ec72ca69d9cca72d2e90d5860bd8ebcd7bc60ffa8419eeb598a4e3228c2d` |
| `r2-package-ten-lanes` | Ten passing lanes; fixture unchanged | 0 | `b0d1940bce9204dd9aacef72902cc37bd9e074ea80478659c05cb253c2a63880` |
| `r2-retained-conversion` | 36 files with full original validation | 0 | `7a442eaf0e71478d8269b3291504a8b99d0544e4baac485061bbee0b5c311028` |
| `r2-conversion-output-diff-final` | 36 files byte-identical to c3c773c | 0 | `43e23f70343907f80d2e4a688f0b15ffd899702bd9f93566d522bfe72257b15d` |
| `r2-conversion-report-diff` | Validation report byte-identical | 0 | `74f7571b2cf337c8abd67f7f277e7601356d34761e185884508e4614bf35a79a` |
| `r2-measure` | All budgets pass | 0 | `0c4f02fcc1bbec12177fa13e607f59f0c38cd5b477692bbfa8a7c9092bfbc9b7` |
| `r2-history-leak-scan` | CLEAN; 82 commits; 1,147 distinct blobs | 0 | `205cd1fcd8d0dabf63a8ea4d03e485267efcd4c772c74e5ed0fa2bd8b49037c4` |
| `plan-graph` | 28 issues; 42 owned views; acyclic graph | 0 | `7014a06c9ffcb98ca443f93775486cc7722a250a5991a12957a2a1051df02671` |
| `plan-format` | 13 PR sections; zero problems | 0 | `e0e5f9d46ec9d77f028d80472ca04b68d12793533b8c2e6821578dc824ba9f8a` |
| `linear-relations` | Existing readback only; no external request | 0 | `47127d7bf1ded09dde75d87cc2dd5c966d7c03b343650ea25f70fb6f38ad70a5` |
| `r2-evidence-audit` | 23 clean exact-head receipts audited | 0 | `15b3cd714f580e2c289a56c0d561bc80f65d80cb27dc4971982a14e49a998fe6` |

The package verification and measurement tools ran from a local copy under the reserved r2 report directory at the same Git head. All 351 tracked files matched byte for byte. This keeps their hard-coded `.local` scratch output inside the reserved directory. Independent gate tests and the retained conversion ran directly in the gate worktree.

All 33,780 compared chronology values match the independent reference, all 1,308 attachment relationships resolve, and all ten real-v5 lanes pass. All 36 conversion files and the full validation report are byte-identical to the first gate's c3c773c outputs.

Performance uses 20 warm samples after two discarded warmups per revision. The repaired head has median 2,479 ms, p95 2,496 ms, maximum 2,499 ms, and peak RSS 347.6 MiB. Limits are 10,000 ms, 1 GiB, and a repeat median at most 3,118.75 ms based on the recorded 2,495 ms baseline. All samples exited 0. Cold results are informational.

The history scanner returned CLEAN over `81c3f4b..HEAD`. The final post-commit scan and pushed evidence head are recorded in the local report.

## Preserved attempts

A first wrapper invocation omitted its required name and exited 2 before Git ran. The corrected merge exited 0; its receipt is SKIPPED with wrapper exit 3 because HEAD changed during the command. It has no release-pass credit.

An extra N1 probe initially expected an unlisted file to reject, although the contract treats it as a warning. That probe exited 1; its corrected run passed. A first conversion diff exited 2 because the ten-lane verifier deletes its scratch packages. A retained conversion and the final package/report diffs exited 0. An evidence-writer preparation command had a quoting error and exited 1 before writing files. These failures remain in local receipts and the summary; none is counted as PASS.

## Previous gate and limits

The first gate was FAIL at `c3c773cf4016d02ab22d62754c6eab5a23ca9401`, with 25 independent tests passing and four failing. Its immutable [containment observation](containment-observation.json) and [link-length observation](link-length-observation.json) remain available. This round closes G1 and G2 at the reviewed revision.

The six GRS-9 and six GRS-10 follow-ups, N5-N9, N11 and N12 remain non-blocking. The 52-of-55 route sub-item remains HOLD under the brief. No unchanged-code audit, newer-export acceptance, implemented HTTP-serving acceptance, SQLite pilot acceptance or cold-cache gate is claimed. No archive HTML or archive scripts were executed. Case-dependent outputs stay local and outside Git.

The full local report is `/home/vaper/Work/Active/MX-two/ClearCase/clearcase/.orchestration/reports/CC-23/r2/report.md`. The coordinator owns later ticket status and integration.
