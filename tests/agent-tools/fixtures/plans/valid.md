# Synthetic widget plan

A synthetic fixture for the agent-tools tests. It contains no case material.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. Check a box only when its evidence exists.

The program runs `playbooks/orchestrate.md`.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] Compare against the release branch with `git show origin/main:README.md` only.

- [ ] Do not arm `/loop 1h`. Send a status message only for material changes.

### Spawn owners

- [ ] Use one owner per ticket.

### PR mechanics, for every PR

- [ ] Push the feature branch.

### Verdict and merge, for every PR

- [ ] Record PASS, HOLD or FAIL.

### Boot recipe, for every live lane

- [ ] Record the exact revision.

## Print a greeting (W-01)

**Depends on.** None.

**Files.**

- [ ] Own `src/greeting.txt` for this unit.

**Build.**

- [ ] Write the greeting.

**You see.**

- [ ] The greeting appears.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Run the synthetic unit check.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `synthetic-model high` at the PR head.

- [ ] Lane 1. Synthetic scenario 1. Save `reports/lane-01.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 2. Synthetic scenario 2. Save `reports/lane-02.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 3. Synthetic scenario 3. Save `reports/lane-03.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 4. Synthetic scenario 4. Save `reports/lane-04.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 5. Synthetic scenario 5. Save `reports/lane-05.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 6. Synthetic scenario 6. Save `reports/lane-06.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 7. Synthetic scenario 7. Save `reports/lane-07.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 8. Synthetic scenario 8. Save `reports/lane-08.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 9. Synthetic scenario 9. Save `reports/lane-09.txt` for a CLI transcript. Pass when the scenario prints the expected line.

- [ ] Lane 10. Synthetic scenario 10. Save `reports/lane-10.txt` for a CLI transcript. Pass when the scenario prints the expected line.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Elapsed time.

- [ ] Probe. Time the synthetic command.

- [ ] Baseline. Record N/A for a new feature.

- [ ] Rule. No regression above 1.25 times.

**Review gate.** None. The fixture has no interaction.

**Merge.**

- [ ] Merge after an independent verdict.

## Close the program

- [ ] Reconcile all tasks.

## Appendix A. Prototype evidence

No prototype.
