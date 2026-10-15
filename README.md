<img src="assets/icon.svg" width="64" height="64" alt="">

# ClearCase

ClearCase is a local workspace for reviewing a legal case. An operator imports a case pack (the `.zip` as received, or the folder it was extracted to), which the app converts into a results package (the processed case data and its links to the case's original files). An operator who already has a results package imports it directly. The operator checks the validation report, then previews and activates the version. The app shows the case through the views of the v5 sample workspace and follows each citation to the original document. The app runs on the operator's machine, listens only on 127.0.0.1, and never writes into the case folder.

V1 rebuilds the v5 sample locally, matching its 1,689 documents and 42 views first and the newer 2,131-document export afterwards. V2 adds hosted client intake, private review and sign-off, and publication to clients. The [product brief](docs/product-brief.md) has the scope.

Status: all 42 views are implemented and marked available in the view registry, and the [CC-11 matrix](docs/acceptance/CC-11/matrix.md) records the parity result for each view. [Linear](https://linear.app/vaper/project/clearcase-realignment-e64366f52809) tracks the remaining work.

## Quick start

You need [Bun](https://bun.sh) 1.4.2 (`packageManager` in `package.json`) on Linux.

```sh
bun install --frozen-lockfile
bun run --bun build   # production build into build/
bun run --bun start   # http://127.0.0.1:41101
```

Then choose **Import a case** and pick the case pack; the [user guide](docs/user-guide.md#importing-a-case) walks through it. From a terminal, `bun run --bun convert` turns a v5 workspace HTML into a package and `bun run --bun validate` checks one without importing it.

Other scripts:

| Script | Runs |
| --- | --- |
| `check` | type checks, schema and view-registry drift checks, `svelte-check`, the Markdown link check, the source check of files `tsc` does not read |
| `test` | the unit and integration tests (Vitest) |
| `test:e2e` | browser and durability suites against `build/`, offline |
| `parity` | the app against the v5 sample, view by view |
| `verify:pilot:v5` | the pilot's lanes on the real v5 sample |
| `gate` | all of the above in order; the check that accepts a revision |

`test:e2e` needs Chromium, `unshare` and `ip`. `parity`, `verify:pilot:v5` and `gate` also need the real v5 sample, which stays outside this repository; CI runs only `check` and `test`. [Development](docs/development.md) covers configuration, architecture and each script.

## Documentation

- [User guide](docs/user-guide.md): starting the app, importing a case, rescan, backup and restore
- [Development](docs/development.md): stack, scripts, configuration, architecture, adding a view
- [Results package](docs/results-package.md): the package format the app imports
- [Parity harness](docs/reference/parity/README.md) and its intentional-differences register
- [Decision records](docs/adr/README.md)
- [Glossary](GLOSSARY.md)
- [Demo runbook](docs/demo-runbook.md): the 14 October demo, the newer ESS pack and the read-only tour
- [CI runner](docs/ci-runner.md): the self-hosted runner that runs `check` and `test`
- [Agent tooling](docs/agent-tooling.md) and [agent instructions](AGENTS.md)
- [Delivery plan](docs/delivery-plan.md), generated from `docs/plan/work-items.json` by `python3 scripts/planning/generate.py`; check it with `scripts/agent-tools/check-plan`
