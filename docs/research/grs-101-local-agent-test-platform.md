# GRS-101: Local agent test platform (pc1, PC2, workerd)

Decision support for [GRS-101](https://linear.app/vaper/issue/GRS-101). It blocks the GRS-94 delivery operating plan. App base `b93bad097fdd7b3c076d68025267c36395fc9921`, branch `research/grs-101-local-agent-test-platform`. Sources were read on 15 October 2026. Labels: **[F]** fact from the cited source, the repository or a read-only observation; **[I]** inference; **[R]** recommendation, not yet tested; **[U]** unknown.

This is research only. Nothing was installed, provisioned, started, stopped, deployed or relocked. No firewall, DNS, VM or runner state changed, and no credentials were created. No app code changed, and the app gate was not run. Dependency, Clerk and Void-adoption facts live in GRS-100 (`docs/research/grs-100-hosted-software-audit.md` on branch `research/grs-100-hosted-software-audit`), and storage facts live in GRS-95. This note repeats neither, except for the one correction below.

## Verdict

1. **Smallest proper platform [R].** Run the agent loop on the workstation, in a per-worktree **lease** with its own ports, persistence directory and temporary directory. Workers code runs in local workerd, through Wrangler and Miniflare, and through `@cloudflare/vitest-plugin` for tests. A lease scheduler grows out of `orch-bin/browser-lock`, and the existing receipts produce the failure report. No new host or service is needed for the first proof.
2. **Keep the pc1 runner as trusted CI only [R].** It is persistent and has no per-job isolation (`docs/ci-runner.md`, Isolation) [F]. Unreviewed agent work must not run on it or share its VM.
3. **pc1 host capacity is unknown [U].** The documented SSH path, in BatchMode with a 5 s connect timeout, stopped at Tailscale SSH's interactive check. I did not authenticate. Any agent role for pc1 depends on that capacity.
4. **PC2 is unknown [U].** No access is documented in the repository, the workspace or `~/.ssh` (which has no `config`). I did not scan or probe for it.
5. **Correction to GRS-100 [F].** `@cloudflare/vitest-pool-workers` (0.23.0, peer `vitest ^4.1.0`) is deprecated: "has been renamed to @cloudflare/vitest-plugin. This package will not receive future updates." [S4]. `@cloudflare/vitest-plugin` 1.4.3 declares peer `vitest ^4.1.0 || ^5.0.0` [S4], so Workers-runtime tests on this repo's vitest 5.0.3 are possible on paper. A declared peer range is not proof; see proof step 1.
6. **Void is not a local agent platform [F]/[R].** Its documentation describes no supported fully local preview mode for app previews or agents (see [Void](#void-local-and-self-host-modes)).

## Observed capacity (read-only, 15 October 2026)

| Machine | Observed | Unknown |
| --- | --- | --- |
| Workstation (runs agents today) | Linux 7.2 x86_64; i7-12700, 20 threads; 15.3 GiB RAM, 11.0 GiB available when sampled, with 4.5 GiB of 15.3 GiB swap in use; one NVMe, 477 GB, 86% used (67 GB free); `/tmp` tmpfs 7.7 GB (4.6 GB free), `/dev/shm` 7.7 GB; load 1.23/0.52/0.23; `/dev/kvm`, podman, docker, qemu, bwrap and systemd-run present; Node 26.10.0, Bun 1.4.2 | Peak use during gates and browser lanes. This was one idle-ish sample. |
| pc1 host | Documented: Arch-based (pacman), QEMU 11.1.1, hosts the CI VM (`docs/ci-runner.md`) | OS version, CPU, RAM, disks, utilisation: SSH needs an interactive Tailscale check [U] |
| pc1 CI VM | Documented: 4 vCPU, 8 GiB, 40 GiB sparse disk; CI job about 36 s warm with 6 Vitest workers (GRS-60 table) | Not re-read: a stopped SSH session on the host blocks the guest path too |
| PC2 | Nothing documented | Everything [U] |

**Do not infer headroom or safe concurrency from these specs [R].** `browser-lock` already waits for more than 3,500 MB available and allows two slots. Swap already in use on a 15 GiB machine suggests memory, not CPU, is the binding limit [I]. Measure it (proof step 5) before raising slot counts.

## What local Cloudflare execution covers [F]

- **Runtime.** `wrangler dev` and the Cloudflare Vite plugin both run Worker code in Miniflare on "the production runtime `workerd`" with `TZ=UTC`. `wrangler dev --remote` uploads to Cloudflare instead, and the Vite plugin has no remote mode [S1][S2].
- **Bindings.** Bound resources "are simulated locally" by default [S1]:
  - D1, R2, KV, Queues, service bindings, Images, Email and Browser Run support both local and remote modes;
  - Durable Objects, Workflows, Assets, Containers, Hyperdrive, Rate Limiting and Analytics Engine are local only;
  - AI, Vectorize, mTLS and Media Transformations are remote only [S2].
- **Remote bindings are not local.** With `remote: true`, operations on that binding "will affect your actual data" and "incur standard operational costs" [S1]. **Rule for the agent loop [R]: no `remote: true` binding and no `--remote`.** A binding without a local simulation is out of scope for the local loop.
- **State.** Local state goes in `.wrangler/state`, or in `--persist-to DIR`, which must be passed on every `dev` run and every `--local` data command. Deleting the folder resets it [S3]. Seeding uses `wrangler d1 execute DB --file=... --local` and `wrangler r2 object put BUCKET/KEY --file=... --local` [S3].
- **SvelteKit.** adapter-cloudflare "emulates" platform values in `vite dev` and `vite preview` through `platformProxy`. To test the build, run `wrangler dev .svelte-kit/cloudflare/_worker.js` with Wrangler 4 [S5]. Under `vite dev`, SSR runs in the Vite process (Bun or Node) with proxied bindings, so it is not workerd evidence [I]. adapter-cloudflare 7.2.9 peers Kit `^2.0.0` and wrangler `^4.0.0`; 8.0.1 needs Kit 3 [S4].
- **Vitest in workerd.** `@cloudflare/vitest-plugin` is configured with `cloudflareTest({ wrangler: { configPath } , miniflare: {...} })` and "requires Vitest 4.1 or later" [S6]:
  - integration tests call `exports.default.fetch()` from `cloudflare:workers`;
  - storage is isolated per test file: "the test runner will undo any writes to storage at the end of each test file" [S7];
  - `reset()` clears all bindings, and `applyD1Migrations` applies migrations that `readD1Migrations` reads in Node [S8];
  - known issues: no native V8 coverage, fake timers do not reach the KV, R2 and cache simulators, `import()` fails inside handlers, and `globalSetup` runs in Node, not workerd [S7].
- **Toolchain runtime.** Wrangler 4.151.0 declares `engines.node >=22` and pins workerd 1.20261012.1 and miniflare `5.20261012.0-beta`. vitest-plugin 1.4.3 pins the same beta miniflare [S4]. Cloudflare's install page centres on Node, and a Wrangler changelog says it warns that Bun "is not officially supported" [S9]. Worker code always runs in workerd, whichever runtime starts Wrangler.

## Void local and self-host modes

[F], from [S10]–[S14]:
- **Platform installation** requires a Cloudflare account and "external PostgreSQL and a configured login method… in either mode". `--workers-dev` is still hosted on Cloudflare. A team platform "requires Workers for Platforms".
- **The platform's "Local Development" guide** is for contributors to the platform: the API and admin UI against a local PostgreSQL, with a development auth bypass "for local UI work only". It does not cover app previews, and no page read describes per-branch or per-agent previews.
- **SvelteKit under Void** sets `platformProxy: { configPath: './.void-wrangler.jsonc' }`, the same Miniflare emulation as plain adapter-cloudflare.
- **Void's `remote` option** uses a deployed project's D1, KV and R2: "Writes affect real data."

**Verdict [R].** Void has no supported fully local agent preview mode. It adds nothing local over Wrangler, and its self-host adds a control plane and Postgres. No preview manager was found with a concrete advantage over a per-worktree `wrangler dev`, so none is proposed.

## Options

| Option | Isolation | Cost | Verdict |
| --- | --- | --- | --- |
| A. Agent jobs on the existing pc1 runner | None between jobs; runner credential present | 0 new | **Reject**: trusted CI only [R] |
| B. Workstation, per-worktree lease + local workerd | Separate worktree, ports and state; same user and kernel | Smallest: reuses browser-lock, receipts, pidfile | **Adopt first** [R] |
| C. B inside rootless podman or bwrap per lease | Filesystem and network namespace per job | Moderate; Chrome needs user namespaces | Add only if unreviewed agent code must be contained further [R] |
| D. Disposable agent VM on pc1 (pc1-vm pattern, no runner, no credential) | VM per pool, destroyed per batch | Needs pc1 capacity [U] and host changes | Later, if B's measured memory is insufficient [R] |
| E. Void self-hosted platform | Cloudflare and Postgres | New control plane | **Reject** [R] |
| F. Deployed preview Worker per change | Real Cloudflare | Cloud compute; Access setup | Final gates only, not every edit [R] |

## Recommended platform [R]

**PC roles.**
- The workstation runs the develop, verify and fix loop.
- The pc1 VM stays the trusted PR runner, unchanged.
- pc1 host capacity for agents is decided after it is measured, and only as option D: never inside the runner VM.
- PC2 gets no role until its access is documented.

**Per-job isolation.**
- One lease per worktree, numbered `n`, taken through a `flock` slot like `browser-lock`'s.
- A port block from the lease number, all bound to `127.0.0.1`: app `PORT`, `ORIGINALS_PORT`, `wrangler dev --port` and `--inspector-port` (the default inspector port collides across sessions [I]).
- `--persist-to .local/workerd/<n>`, and `TMPDIR` in a fresh `/dev/shm` directory per job, as CI does.

**Repeatable build.**
- A clean worktree at the exact SHA, then `bun install --frozen-lockfile` and the build. The existing fresh-build stamp refuses a dirty or stale tree.
- The receipt records the SHA and the versions of Bun, Node, Wrangler, workerd, Vitest and the plugin.

**Data.**
- Synthetic seeds only: committed D1 migrations plus a synthetic R2 object set.
- Reset deletes the lease's persist directory. Idempotence is proved by seeding twice and getting the same table and object digest.
- Real case files stay in ignored `.local/` and never reach a seed.

**Browser preview and artifacts.**
- Preview stays on loopback, opened through an SSH `-L` forward, or within the tailnet if the user chooses. No public tunnel (no Funnel, no `workers.dev`), and no production keys.
- Screenshots and traces are files under `.local/`, referenced by path in receipts, never base64.

**Cleanup.**
- `stop` kills by recorded pidfile and process group (`scripts/pidfile.ts`), never `pkill`, then removes the persist and temp directories.
- The stall-reclaim rule of `lock-watchdog.sh` applies to leases.

**Scheduler.**
- Generalise `browser-lock` to N lease slots, with the 3,500 MB floor and the current waits.
- Wait, never kill another agent's job.
- Start at 2 slots, the current value, until proof step 5 measures otherwise.

**Trust split.** Interactive and unreviewed agent work never uses the runner VM, its credential or `_work` directory. CI keeps running only reviewed PR code (`docs/ci-runner.md`).

## Cost loop [R]

1. A script, not an agent turn, runs focused checks first: changed test files, the Workers Vitest project, and one named e2e scenario. Each check is wrapped in `scripts/agent-tools/receipt`, and `scripts/ci/summary.ts` produces the JSON problems (`check`, `where`, `detail`, `reproduce`).
2. The agent gets only the SHA, the failing test or scenario, a log tail of at most 40 lines, and the artifact paths. Then it fixes.
3. The checks broaden at hand-in: the full `gate`, then a fresh independent review, pc1 CI, then the hosted gates. Cloud runs for integrity, ranges, large-export and recovery come only after the local checks pass, not on every edit.
4. Local compute saves cloud test compute and queue time. It does not by itself cut LLM spend, which follows turns and context. Measure both before claiming savings. No local model is assumed.

## Evidence boundaries [R]

| Question | Local (workerd, Miniflare D1/R2) | Needs deployed |
| --- | --- | --- |
| Worker code runs in workerd and the bundle has no Node-only modules | Yes (built `_worker.js`) | Bundle-size limits are confirmed on deploy |
| D1 SQL, migrations, R2 object round trips, idempotent seeds | Yes, for logic | Hosted concurrency, placement, latency, limits, backups |
| Auth hook fail-closed logic | Unit tests with local fixtures only | Real dev or test Clerk flow and the final hosted test (GRS-100 proofs) |
| Browser paths on synthetic data | Yes, as user-path evidence | Access, TLS, cache headers, custom domains |

A mocked acceptance boundary is never a PASS. Local results are reported as local, at an exact SHA.

## Proof recipe (a later implementation ticket; each step leaves a receipt)

1. **Version proof.** On a throwaway branch, pin `wrangler` and `@cloudflare/vitest-plugin` 1.4.3 next to vitest 5.0.3, and add a second Vitest project for Worker tests. One test writes D1 and R2 through `exports.default.fetch`. Run it under `bun run --bun test` and under Node, and record which works, with exact versions.
2. **Build proof.** Build a separate hosted entry with adapter-cloudflare 7.2.9, then run `wrangler dev .svelte-kit/cloudflare/_worker.js` with lease ports and `--persist-to`. `/api/health` must answer, and an import guard must show no `node:sqlite` in the bundle.
3. **Seed, reset, idempotence.** Seed, take a digest, seed again, check the digest is unchanged, delete the persist directory, and check the store is empty.
4. **Browser lane.** One synthetic e2e scenario runs against the workerd preview under `browser-lock`. Artifacts are file paths only.
5. **Concurrency.** Run 1, 2 and 3 leases at once on the workstation. Record peak RSS, the lowest available memory, swap, and wall time. Set slot count and memory floor from those numbers.
6. **Cleanup.** After `stop`, no lease port listens, no lease process remains, and the directories are gone. Another worktree's job keeps running throughout.
7. **Hosted.** Run the GRS-100 deployed-preview proofs as the final gate.

## Unresolved choices

- **Node for Wrangler and the plugin.** The workspace rule says `bun run --bun`, while Wrangler declares Node ≥22 and does not officially support Bun. Step 1 decides between documenting a Node exception for Workers tooling and proving Bun.
- **pc1 host capacity.** The user completes the Tailscale SSH check, or runs `uname`, `nproc`, `free` and `df` on pc1 and pastes the output.
- **PC2.** Its identity, access path and intended role.
- **Containment.** Whether B is enough for unreviewed agent code, or C (container per lease) is required.
- **Kit 3 timing.** It picks adapter 7 or 8 and changes how bindings are read (`cloudflare:workers`).
- **Private preview access.** SSH forward or tailnet-only serve.
- **Slot count and memory floor.** These come from step 5.

## Sources (all read 15 October 2026)

[S1] https://developers.cloudflare.com/workers/local-development/ · [S2] https://developers.cloudflare.com/workers/local-development/bindings-per-env/ · [S3] https://developers.cloudflare.com/workers/local-development/local-data/ · [S4] npm registry `latest` and pinned manifests: `@cloudflare/vitest-plugin` 1.4.3, `@cloudflare/vitest-pool-workers` 0.23.0, `wrangler` 4.151.0, `@cloudflare/vite-plugin` 1.64.0, `@sveltejs/adapter-cloudflare` 7.2.9 and 8.0.1, `void` 1.1.11 · [S5] https://svelte.dev/docs/kit/adapter-cloudflare · [S6] https://developers.cloudflare.com/workers/testing/vitest-integration/ and `.../write-your-first-test/` · [S7] `.../vitest-integration/known-issues/` · [S8] `.../vitest-integration/test-apis/` · [S9] https://developers.cloudflare.com/workers/wrangler/install-and-update/ · [S10] https://void.cloud/reference/cli/platform-installation · [S11] https://void.cloud/guide/self-hosted-platform · [S12] https://void.cloud/guide/platform/development/local and `/runtime` · [S13] https://void.cloud/integrations/frameworks/sveltekit · [S14] https://void.cloud/reference/config (`remote`). Repository: `docs/ci-runner.md`, `scripts/ci/pc1-vm`, `scripts/ci/summary.ts`, `scripts/gate.mjs`, `scripts/pidfile.ts`, `docs/development.md`, and the workspace's `orch-bin/browser-lock`.
