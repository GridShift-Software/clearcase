<img src="assets/icon.svg" width="64" height="64" alt="">

# ClearCase

ClearCase is being rebuilt in two phases. V1 reproduces the supplied local v5 workspace. V2 adds hosted client intake, private review and human-approved publication.

The repository currently contains the delivery plan and coordination tools. Application implementation has not started.

- [Product scope](docs/product-brief.md)
- [Delivery plan and milestone graph](docs/delivery-plan.md)
- [Orchestration protocol](docs/orchestration.md)
- [Kickoff prompt for the next agent](docs/kickoff-prompt.md)
- [Current context and remaining gaps](docs/context-packet.md)
- [Skill alignment review](docs/reviews/skill-alignment.md)
- [Linear project](https://linear.app/vaper/project/clearcase-realignment-e64366f52809)
- [Linear delivery plan](https://linear.app/vaper/document/clearcase-delivery-plan-and-acceptance-gates-518b0c44b87a)

The initial reference is the main HTML in `ESS_DCS_Lawyer_Pack_v5-002.zip`, with 1,689 documents and 42 views. The newer 2,131-document export is the second acceptance fixture. Original archives live outside this repository and remain read-only.

Regenerate and check the planning artifacts with:

```sh
python3 scripts/planning/generate.py
python3 scripts/planning/check.py --require-linear-ids
node /home/vaper/.agents/skills/poteto-mode/scripts/check-plan.mjs docs/delivery-plan.md
```

Edit `docs/plan/work-items.json` and `docs/plan/program-intro.md`, then regenerate. Do not hand-edit the generated delivery plan or ticket briefs. Reconcile live Linear changes before updating the local snapshot.
