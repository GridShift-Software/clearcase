# GRS-194 independent review

Reviewed diff: `e05d9a8175afd12aacbf580ce29bbb50829ecf15...3423d90b8c9423e623c8b7556e6d24305635093e`. Two separate T3 child reviews using the code-review skill; source review only, neither reproduced runtime tests. Both used Codex GPT-6 Astra, high reasoning, standard service tier.

## Standards

- P2: imported anchor and organogram text bypasses `revealInvisible`, contrary to `docs/results-package.md`; HTML escaping alone leaves bidi/zero-width characters active. Display hidden characters visibly while preserving stored source and identity values.
- P3 heuristic: `DatePhase` duplicates the schema's fields, creating a future drift risk. Derive it from the typed schema.

## Spec

- P2: the timeline loader carries `refs`, but the page displays only `ref`. The synthetic invoice cites OD-002 and SD-001; the second citation is invisible. Show all references and test the second target.
- P2: source text bypasses the package's hidden-character protection (same defect as Standards P2).
- P2: the machine-readable compatibility inventory and prose still expect residual anchors, organogram and date phases. Update the intended mappings, retain historical evidence and keep real-export verification HOLD.

## Fix disposition

The two behavioral tests were committed first and failed at `10630fa6ad632e448633fb8531fe8b2af054743d` (receipt in the report). The fix applies `revealInvisible` at display boundaries, renders every supplied timeline citation, derives DatePhase from its schema, and updates intended compatibility mappings while preserving the previous inventory in a separate historical file. Final verification and fresh recheck are pending; no reviewer approval is inferred.

Round 1 task identifiers: `grs194-standards-r1-3423` and `grs194-spec-r1-3423` (client request IDs; full app task IDs retained in this thread).
