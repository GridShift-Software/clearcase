# Define the Fable and swarm delivery operating plan

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-94/define-the-fable-and-swarm-delivery-operating-plan) is the execution authority.

## User decision — 19 October 2026

Review contract confirmed: Dian reviews one coherent wave PR at a time, at most seven tickets, asynchronously with no promised hours. Routine updates remain at 08:30 SAST on weekdays; urgent failures that stop agents are surfaced immediately in the coordinator's T3 thread. Existing independent ticket reviews, checkpoint evidence, one written fix round and one re-request remain. No direct-message/email authority is added.

---

## Question

How should the agreed design become milestones and self-contained implementation tickets, with explicit model roles (including rare Claude Fable/Astra escalation), independent review, path/worktree ownership, worker limits, budgets and serial integration? Reconcile the old workspace bans with the user's requested approach and configure pstack only after role choices are confirmed.

## User-supplied verification reference

The user supplied [Agents Write the Code. Your System Has to Prove It.](<https://alexlavaee.me/blog/verifying-agent-written-code/>) via [their X link](<https://x.com/alexlavaee/status/2110521585623003572>) as the intended direction for verification layers. In this decision, map approved requirements to independent pass/fail checks, run deterministic checks before model review, retain exact-revision evidence, and distinguish PC1/PC2 feedback from real hosted acceptance. Cover protection against weakened tests and bounded repair loops. Scale verification to the change. Specific tools, judge counts and operating rules remain to be decided here; no Atomic/Qlty adoption or implementation is implied.
