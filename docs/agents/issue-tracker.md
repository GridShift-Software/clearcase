# Use Linear for ClearCase work

Use the Gridshift team's [ClearCase - Realignment project](https://linear.app/vaper/project/clearcase-realignment-e64366f52809), project UUID `f473fd2d-c994-4dc6-84e2-b90a68848e48`.

The project holds delivery milestones, implementation issues, decision/discovery issues and independent acceptance gates. `docs/plan/work-items.json` maps stable local planning keys to Linear IDs. `docs/plan/view-coverage.json` assigns all 42 v5 views to an implementation owner.

During execution, live Linear status and blocking relations determine readiness. The local map is a snapshot, not authority to override later Linear changes. Read live relations at pickup and reconcile the snapshot before dispatch. Keep scope and acceptance criteria synchronized when either changes.

Use the team's existing statuses. Planned work starts in Backlog. The coordinator moves ready work to Todo, dispatched work to In Progress, review candidates to In Review and independently accepted work to Done. A dependency or missing receipt is not completion. Record external blockers in the issue and coordination state because the team has no separate Blocked status.

Only the coordinator writes Linear status. Workers return evidence and proposed follow-ups. Keep issues self-contained with outcome, scope, blockers, acceptance, verification and forbidden actions. Planning-created issues do not need a second triage pass. Do not create a parallel GitHub or local issue tracker.

The user authorized this plan's issues and milestones on 8 October 2026. Do not import unrelated per-issue approval requirements from Jove history. Newly discovered work outside the authorized product scope belongs in a proposal until the user expands that scope.
