---
name: sprint-review
description: "The one agent review of a sprint PR: `/sprint-review <PR number>` reads the ticket named in the PR title, the diff, and the ticket's Acceptance and Forbidden sections, checks the change against them (plus the four hosted classes for security-sensitive tickets), and posts at most 5 findings as one `review: <model>` PR comment. Run it in a fresh session on the other model family from the builder."
---

# sprint-review

Input: a PR number against `sprint/hosted-demo-20261105`. About 30 minutes (60 for a security-sensitive ticket). This is the only review a sprint PR gets: no Greptile, no second round, no re-check. Read-only apart from the one comment.

## Steps
1. `gh pr view <N> --json title,headRefOid,baseRefName,files,body`. The title is `GRS-NNN: ...`; the ticket is the `docs/sprint/tickets/NN-*.md` file for that issue (read `docs/sprint/tickets/README.md` for the mapping). If the base is not `sprint/hosted-demo-20261105`, stop and say so.
2. Read the ticket's "What to build", "Reserved paths", "Acceptance", "Checks", "Decisions already made", "Forbidden" and "Security-sensitive" lines. Read the PR body's check results.
3. `gh pr diff <N>`. Check out the head in a scratch worktree only when you need to run something.
4. Judge the change against these, in order:
   - **Does what the ticket asks.** Each Acceptance line has a matching change or test; nothing the ticket does not ask for.
   - **Stays in its reserved paths.** Every changed file is under a reserved path, or is a new file the ticket allows. Shared files belong to the ticket that names them. Anything under `dev`/`main`, sandboxes A or B, or real case material or secrets is High.
   - **Forbidden list.** None of it appears: loosened or skipped tests beyond what the ticket names, new guards or process files, a second review round.
   - **Tests for user-visible behaviour.** New behaviour has a test that would fail without it; the PR body shows the ticket's Checks block with PASS or FAIL at the head SHA.
5. If the ticket says `Security-sensitive: yes` (auth, tenancy, audit, sign-in routes, grant producers, R2 object serving), also check these four classes, and probe at most 3 of them in a scratch checkout:
   - **Wrong client:** another client's Worker, bucket or database is reachable.
   - **Wrong case:** a case without a grant is reachable by id, asset URL, ticket, cache or export.
   - **Capability outlives authority:** a ticket, cookie or URL still works after expiry, revocation or sign-out.
   - **Secret in a log, receipt or report:** a cookie, token, ticket or password visible in output.

## Output
At most 5 findings, most severe first. Each has: severity (High, Medium or Low), `file:line`, the failure scenario in one or two sentences (concrete input, wrong result), and the fix. High is a broken acceptance line, a path breach or a security hole. Medium is a missing test for user-visible behaviour or a likely bug. Low is the rest. No findings is a valid result; say what you checked.

Post one comment: `gh pr comment <N> --body-file <file>`, headed `review: <your model name>`, then the findings, then one line with the head SHA you read. Do not approve, request changes, merge or edit anything else. Report the comment URL.
