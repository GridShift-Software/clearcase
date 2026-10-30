# Post-mortem: why the first hosted alpha was slow and hard to use (28 October 2026)

**Summary.** Twenty days of carefully planned, heavily reviewed work produced a hosted app that was correct on paper but slow and hard to use. The plan aimed at the wrong target. Every check measured correctness against fakes, or parity of data against v5. None measured whether a client could use the live app. The agents optimised exactly what was measured.

## Root causes
1. **Cloudflare was kept off-limits until 25 October.**
   - Every "hosted" check ran locally against fakes with zero latency, so the gates passed while the live app was unusable.
   - The distance from South Africa to the EU databases, multiplied by about 86 database calls per page, stayed hidden until day 18.
   - The first time anyone used the live app like a client was 27 October.
2. **The working end-to-end path came last in the plan.** It sat behind a foundation ticket, a design gate, proofs and tooling. "Ship a usable live thing first" appeared in no rule file before 25 October.
3. **The alpha was specified like a production compliance system.** It had an app per client, sign-off on an exact version with sealed evidence, and "one failed preview holds the whole update". That last rule alone makes the real v5 case impossible to publish (1,308 email previews fail it).
   - Two rules that came from review findings made every read slow: grants read on every call, and an audit record on every delivery.
4. **Reviews had no point where they stopped.**
   - Each round brought a fresh reviewer told to fix the whole class of problem, so each round found new edge cases.
   - One sign-in fix took 6 rounds. Session renewal took 5 rounds over 9.5 hours and still couldn't fix the real problem, a 60-second token, because that needed a design change.
   - 57% of briefs were reviews, fixes or re-checks.
5. **The tooling became the product.**
   - From 18 to 24 October, 52% of changed lines went to guards, receipts, locks and CI tests. Only 4.5% of what merged into `dev` that week was app code.
   - The rule files roughly tripled in size, and no rule was ever retired.
6. **Approval was given on records, not screens.**
   - The 322 decision records covered v5 data and behaviour; none covered layout or navigation.
   - The client app was a separate bare shell, built in two days, with no view navigation.
   - The partner design arrived after the build and was applied only as colours and fonts.
7. **The hot paths were built for proof, not speed.**
   - Every PDF request (and every range pdf.js asks for) reads and SHA-256s the whole file twice from R2.
   - Every page re-loads and re-hashes the whole case.
   - Every authorization calls Clerk.

## Measured on 28 October
| | Local release candidate | Hosted |
| --- | --- | --- |
| Sign-in | none | 11–24 s |
| Opening a view | 60–300 ms | 1.2–3.6 s |
| First PDF page | 1.9 s for a 258 MB file | 4.5–7 s even for 633 bytes |
| Search | 71 ms | returns 503 |

## Rules so it doesn't happen again
1. Add a process rule only by deleting one. Cap the size of the rule files.
2. The first deliverable each week is a URL a person opens. If nobody can use it, no review, guard or ADR counts as progress.
3. Set the bar as numbers before work starts: page time, one review, two fix rounds. A finding outside those numbers goes to follow-ups; it doesn't start another round.
4. Write down once where speed beats proof at this stage. Left alone, agents choose assurance.
5. On the third round of the same problem, change the premise, not the model.
6. If reading the project state takes more than two minutes, the project has turned into the process.
