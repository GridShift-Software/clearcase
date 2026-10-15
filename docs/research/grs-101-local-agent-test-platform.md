# GRS-101: Local agent test platform (pc1, PC2, workerd)

Decision support for [GRS-101](https://linear.app/vaper/issue/GRS-101). It blocks the GRS-94 delivery operating plan. App base `b93bad097fdd7b3c076d68025267c36395fc9921`, branch `research/grs-101-local-agent-test-platform`. Sources were read on 15 October 2026. Labels: **[F]** fact from the cited source, the repository or a read-only observation; **[I]** inference; **[R]** recommendation, not yet tested; **[U]** unknown.

This is research only. Nothing was installed, provisioned, started, stopped, deployed or relocked. No firewall, DNS, VM, runner, SSH or Tailscale state changed, and no credentials were created. No app code changed, and the app gate was not run. No hardware probe ran after the access block below, and none is proposed until the user supplies access. Dependency, Clerk and Void-adoption facts, and the Kit security and migration matrix, live in GRS-100 (`docs/research/grs-100-hosted-software-audit.md` on branch `research/grs-100-hosted-software-audit`), and storage facts live in GRS-95. This note repeats none of them, except the one correction below.

## Verdict

1. **The user asked for the spare PC1 and PC2 to be used [F]. Sparing the loaded workstation is the point, so it is not the preferred platform [R].** The workstation is already RAM-limited (see capacity), and being unable to reach PC1 or PC2 over SSH is a reason to finish the access step, not a reason to default to it. Recommend **conditional, isolated agent job pools on PC1 and/or PC2, adopted only after an access and capacity proof**, kept separate from the trusted CI VM on pc1. The workstation may run only an optional small **bootstrap compatibility proof** (proof steps 1–3 below), not the default gates. No role, concurrency or headroom claim is made for any machine until it is measured.
2. **Per-worktree directories and ports are logical isolation, not a security boundary [F]/[R].** Same user, same kernel, same files. A shared agent platform should default to a **VM, or an appropriate container where a VM is not available**, per pool or job, with no CI credential, distinct from the persistent runner VM. See [Isolation](#isolation-logic-versus-security).
3. **The trusted CI runner is not an agent pool [R].** It is persistent, holds a runner credential and has no per-job isolation. The runbook says to run only code from trusted writers, which is not the same as reviewed (`docs/ci-runner.md`, Isolation) [F]. Review status is not guaranteed there.
4. **Tailscale shows both PC1 and PC2 online, but neither is usable yet [F].** See [Access status](#access-status). Capacity of both is **[U]**.
5. **Current limits stay [R].** The agent and browser limits in force (two browser slots, the 3,500 MB floor) remain until measured and adopted under GRS-94. This note proposes no unqualified growth in slots and no third browser job beside the two slots.
6. **Correction to GRS-100 [F].** `@cloudflare/vitest-pool-workers` (0.23.0, peer `vitest ^4.1.0`) is deprecated: "has been renamed to @cloudflare/vitest-plugin. This package will not receive future updates." [S4]. `@cloudflare/vitest-plugin` 1.4.3 declares peer `vitest ^4.1.0 || ^5.0.0` [S4], so Workers-runtime tests on this repo's vitest 5.0.3 are possible on paper. A declared peer range is not proof; see proof step 1.
7. **Void has no documented, supported, dedicated, fully local agent preview platform [F].** Adopting or rejecting it stays with the user ([Void](#void-local-and-self-host-modes)). **Node for Wrangler is a helper-tooling choice, not necessarily a conflict with Bun app builds [R]** ([runtime](#runtime-for-wrangler-and-the-plugin)).

## Access status

Read-only facts, reported by the parent session from its Tailscale status read on 15 October 2026. I did not re-run them and made no new probe [F]:
- **Both PC1 and PC2 appear as online peers advertising Linux.** Addresses, DNS names, usernames and host keys are deliberately not recorded in this file.
- **PC2:** an initial direct tailnet SSH attempt with strict known-hosts checking refused an unknown host key. After the user supplied the existing login, ordinary aliases did not resolve on the workstation; Tailscale-native SSH reached the peer but required an additional authentication check.
- **PC1:** ordinary aliases did not resolve on the workstation; Tailscale-native SSH reached the peer with the supplied existing login but required the same additional authentication check ([S18] describes this check mode).
- No SSH session succeeded and no OS, CPU, RAM or disk value was read for either machine. No authentication, host-trust or known-hosts setting was bypassed or changed.
- **Pending with the user (asynchronous):** complete the additional authentication check for both PCs, or supply OS, CPU, RAM and disk output. The login is now known; capacity remains **[U]**. No further retry before the check is completed.

## Observed capacity (read-only, 15 October 2026)

| Machine | Observed | Unknown |
| --- | --- | --- |
| Workstation (runs agents today) | Linux 7.2 x86_64; i7-12700, 20 threads; 15.3 GiB RAM, 11.0 GiB available when sampled, with 4.5 GiB of 15.3 GiB swap in use; one NVMe, 477 GB, 86% used (67 GB free); `/tmp` tmpfs 7.7 GB (4.6 GB free), `/dev/shm` 7.7 GB; load 1.23/0.52/0.23; `/dev/kvm`, podman, docker, qemu, bwrap and systemd-run present; Node 26.10.0, Bun 1.4.2 | Peak use during gates and browser lanes. This was one idle-ish sample. |
| pc1 host | Online Linux peer (Tailscale). Documented: Arch-based (pacman), QEMU 11.1.1, hosts the CI VM (`docs/ci-runner.md`) | OS version, CPU, RAM, disks, utilisation, free capacity next to the CI VM |
| pc1 CI VM | Documented: 4 vCPU, 8 GiB, 40 GiB sparse disk; CI job about 36 s warm with 6 Vitest workers (GRS-60 table) | Not re-read |
| PC2 | Online Linux peer (Tailscale). Nothing else documented | OS, CPU, RAM, disks, role, owner policy, whether it may host agent work |

**Do not infer headroom or safe concurrency from these specs [R].** `browser-lock` waits for more than 3,500 MB available and allows two slots. Swap already in use on a 15 GiB machine suggests memory, not CPU, is the binding limit on the workstation [I]. Measure disk, RAM and CPU on each chosen host before any role or slot count (proof step 5).

## Isolation: logic versus security

| Layer | What it separates | What it does not |
| --- | --- | --- |
| Per-worktree lease (own directory, ports, `--persist-to`, `TMPDIR`) | Logic and process collisions: ports, state, temp files, stale data between jobs | Anything a hostile or buggy job can reach as the same user: other worktrees, `~/.ssh`, credentials, the kernel, `/tmp` of other jobs |
| bwrap or rootless podman per job | Filesystem view, and a network namespace if configured; reduced blast radius | The shared host kernel. Chrome needs user namespaces, so a profile must be tested |
| Disposable VM per pool or job (`scripts/ci/pc1-vm` pattern, no runner, no credential) | A kernel boundary and a state boundary: destroy and recreate wipes it | Resources, since it shares host CPU, RAM and disk; the host itself |
| The pc1 CI VM | Persistent trusted-writer CI only | Per-job isolation: none, and it holds a runner credential [F] |

Rules [R]: the shared platform default is the VM row, or a container where a VM is unavailable, on a host that does not hold the CI credential. Unreviewed agent code never runs in the runner VM, its `_work` directory or with its credential. Leases are used inside the VM or container to stop collisions, and are never described as the security boundary.

## What local Cloudflare execution covers [F]

- **Runtime.** `wrangler dev` and the Cloudflare Vite plugin both run Worker code in Miniflare on "the production runtime `workerd`" [S1]. `wrangler dev --remote` uploads to Cloudflare instead, and "Remote development is not supported in the Vite plugin" [S1].
- **Bindings.** Bound resources "are simulated locally" by default [S1]. Per [S2]:
  - D1, R2, KV, Queues, service bindings, Images, Email and Browser Run support both local simulation and remote connection;
  - Durable Objects, Workflows, Assets, Containers, Hyperdrive, Rate Limiting and Analytics Engine are local simulation only;
  - AI, Vectorize, mTLS and Media Transformations are remote only.
- **Remote bindings are not local.** Writes to remotely connected bindings "will affect your actual data" [S1]. **Rule for the agent loop [R]: no remote binding and no `--remote`.** A binding without a local simulation is out of scope for the local loop.
- **State.** Local state goes in `.wrangler/state`, or in a `--persist-to` directory that must be passed on every `dev` run and on other commands that modify local data. Deleting the folder resets it [S3]. Seeding uses `wrangler d1 execute <DB> --command="<SQL>" --local` and `wrangler r2 object put <BUCKET>/<KEY> --file=<PATH> --local` [S3].
- **SvelteKit.** adapter-cloudflare "emulates" platform values in `vite dev` and `vite preview` through `platformProxy`. To test the build, run `wrangler dev .svelte-kit/cloudflare/_worker.js` with Wrangler 4 [S5]. Under `vite dev`, SSR runs in the Vite process with proxied bindings, so it is not workerd evidence [I]. adapter-cloudflare 7.2.9 peers Kit `^2.0.0` and wrangler `^4.0.0`; 8.0.1 peers Kit `^3.0.0-next.0` and wrangler `^4.118.0` [S4].
- **Vitest in workerd.** `@cloudflare/vitest-plugin` "requires Vitest 4.1 or later" and is configured with `cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })` imported from `@cloudflare/vitest-plugin` [S6]:
  - integration tests call `exports.default.fetch()`, with `exports` imported from `cloudflare:workers` [S8];
  - "any writes to storage during a test file are not visible to other test files" [S7];
  - `reset()` (from `cloudflare:test`, runs in workerd) deletes all data from attached bindings; `applyD1Migrations()` is also a `cloudflare:test` export, and `readD1Migrations()` comes from `@cloudflare/vitest-plugin/config` and runs in Node [S8];
  - known issues: "Native code coverage via V8 is not supported", fake timers "do not apply to KV, R2 and cache simulators", dynamic `import()` fails inside `export default` handlers, and `globalSetup` runs in Node [S9].

## Runtime for Wrangler and the plugin

- **Facts [F].** Wrangler 4.151.0 declares `engines.node >=22.0.0` and depends on workerd 1.20261012.1 and miniflare `5.20261012.0-beta`; vitest-plugin 1.4.3 uses the same miniflare beta [S4]. Cloudflare's install page says it supports "the Current, Active, and Maintenance versions of Node.js" and shows `bun add -d wrangler@latest` as an install form without stating Bun support [S10]. The Wrangler changelog entry I earlier cited for "Bun is not officially supported" was not re-read in this pass and is not relied on. Worker code always runs in workerd, whichever runtime starts the CLI.
- **Position [R].** Bun stays the runtime for app dependencies, builds, dev and existing local tests and the local POC entry point; the agreed hosted runtime is workerd. A supported Node runtime for the vendor CLI and the Workers test host is a **helper tooling choice**, not a change to the app build or hosted runtime. Whether to document it as a policy exception, or require proof that Bun hosts these tools, is a **user policy choice, pending**.
- **Evidence labels [R].** Each receipt names its runtime: Node-hosted Wrangler or plugin evidence is never reported as Bun evidence. Do not force the Workers tests to run remotely to satisfy Bun. Other hosts' Node versions are **[U]**.

## Void local and self-host modes

[F], from [S11]–[S17] and the published `void` 1.1.11 package:
- **Platform installation** requires a Cloudflare account and "external PostgreSQL and a configured login method… in either mode". `--workers-dev` is still hosted on Cloudflare. A team platform "requires Workers for Platforms" [S11][S12].
- **The platform's "Local Development" guide** is for contributors to the platform (API and admin UI against a local PostgreSQL). It does not cover app previews, and no page read describes a dedicated per-agent preview platform [S13].
- **The direct SDK and Vite plugin can use local Miniflare.** `void` 1.1.11 depends on `miniflare 5.20261012.0-beta` and `@cloudflare/vite-plugin ^1.64.0` [S4]. Its guide states "Void normally uses local D1, KV, and R2 through Miniflare" [S16]. SvelteKit under Void sets `platformProxy: { configPath: './.void-wrangler.jsonc' }`, the same proxy form as adapter-cloudflare [S14].
- **Void's `remote` option** (or `VOID_REMOTE=1`) uses a deployed project's D1, KV and R2: "Writes affect real data" [S15][S16].

**Position [R].** No supported dedicated, fully local agent preview platform is documented for Void. That does not mean Void adds nothing locally: the optional direct SDK or Vite-plugin convenience (local Miniflare dev, migrations, local inbox) is a convenience that should be compared with plain Wrangler, separately from the CF-backed self-hosted platform. This note does not adopt or reject Void. Adoption stays a user decision, with no architecture, provider or adoption change implied here. Local Void or Wrangler results do not replace real Clerk and hosted proofs.

## Options

| Option | Isolation | Cost | Position |
| --- | --- | --- | --- |
| A. Agent jobs on the existing pc1 runner | None between jobs; runner credential present | 0 new | **Reject**: trusted-writer CI only [R] |
| B. Per-worktree lease on any host | Logic only (ports, state, temp); same user and kernel | Small: reuses browser-lock, receipts, pidfile | Component inside C or D, never the security boundary [R] |
| C. Disposable agent VM on PC1 and/or PC2 (pc1-vm pattern, no runner, no credential) | Kernel and state boundary; destroyed per batch | Needs access and capacity proof [U]; host changes later | **Preferred shared default, conditional** on proof step 0 [R] |
| D. Rootless podman or bwrap per job on a spare host | Filesystem and network namespace; shared kernel | Moderate; Chrome needs user namespaces | Where a VM is unavailable; weaker than C [R] |
| E. Workstation | B only | Already RAM-limited | Optional small bootstrap compatibility proof only, not default gates [R] |
| F. Deployed preview Worker per change | Real Cloudflare | Cloud compute; Access setup | Final gates only, not every edit [R] |

## Recommended platform [R]

Everything below is a design to be proved, in order, not a finding.
**Step 0: access and capacity proof.** The user supplies an approved route to PC1 and PC2, or pastes `uname -a`, `nproc`, `free -m`, `df -h`, `lscpu` and KVM availability from each. Only then decide each machine's role, from measured values.
**Pools (if step 0 passes).**
- A pool is a disposable VM, or a container where a VM is unavailable, on PC1 or PC2. It holds no CI credential, no runner directory and no real case data.
- The trusted CI VM on pc1 is unchanged and separate. If a pool shares pc1's host, host RAM and disk headroom for the CI VM is measured first, and the pool must not be able to starve it.
- Roles, job counts and memory floors come from measured numbers (proof step 5), adopted under GRS-94.
**Inside a pool.**
- One lease per job, via a `flock` slot like `browser-lock`'s, with a port block bound to `127.0.0.1` (app `PORT`, `ORIGINALS_PORT`, `wrangler dev --port` and `--inspector-port`; the default inspector port collides across sessions [I]) and `--persist-to .local/workerd/<n>`.
- A clean worktree at the exact SHA, `bun install --frozen-lockfile` and the build. The fresh-build stamp refuses a dirty or stale tree. The receipt records the SHA and the versions of Bun, Node, Wrangler, workerd, Vitest and the plugin.
- The two-slot browser limit and its memory floor apply within the platform as they do today.
**Data.**
- Synthetic seeds only: committed D1 migrations plus a synthetic R2 object set. Real case files stay in ignored `.local/` on the user's workstation and never reach a seed or a pool.
- Reset is defined in [Temporary data](#temporary-data-and-reset). Idempotence is proved by seeding twice and getting the same table and object digest.
**Preview and artifacts.** Preview stays on loopback, reached through an SSH `-L` forward or within the tailnet if the user chooses; no public tunnel (no Funnel, no `workers.dev`) and no production keys. Screenshots and traces are files referenced by path in receipts, never base64.
**Scheduler.** Generalising `browser-lock` to more lease slots is a later change, justified only by proof step 5 and adopted under GRS-94. Until then the two slots stay. Wait, never kill another agent's job.

## Temporary data and reset

- **Not `/dev/shm` by default [R].** The workstation has 15.3 GiB RAM with swap in use, and `/dev/shm` is 7.7 GB of that RAM. v5-sized uploads and exports must not default to it. CI's `/dev/shm` use is a trusted-writer, VM-sized case and does not carry over.
- **Default: quota-bounded per-job disk directories** on the chosen host (a size-limited volume or filesystem quota, or a VM disk), with an upper bound per job. **Memory-backed tmpfs** only for small cases proved small, with its size capped. Disk capacity and quota are measured next to RAM and CPU (proof step 5): the workstation NVMe is 86% used, and PC1 and PC2 disks are **[U]**.
- **Preserve before cleanup [R].** Copy failure logs, screenshots, traces and receipts to a retained artifacts directory before removing any job directory.
- **Cleanup scope.** Lifecycle cleanup stops and removes only the lease's own process group (recorded in the pidfile, `scripts/pidfile.ts`), never by `pkill`, and never touches another job.
- **Reset order.** Stop the lease's own server first; then delete the SQLite and state files; then restart and reseed. Never delete state files under a live file handle, because deleted-but-open files keep their space and can corrupt a running store.

## Cost loop [R]

A script, not an agent turn, runs focused checks first (changed tests, the Workers Vitest project, one named e2e scenario), each wrapped in `scripts/agent-tools/receipt`, with `scripts/ci/summary.ts` producing the JSON problems. The agent gets only the SHA, the failing check, a log tail of at most 40 lines and artifact paths. Checks broaden at hand-in: full `gate`, a fresh review, pc1 CI, then hosted gates; cloud runs come after local checks pass, not on every edit. Local compute saves cloud test compute and queue time, not LLM spend, which follows turns and context. Measure both before claiming savings; no local model is assumed.

## Evidence boundaries [R]

| Question | Local (workerd, Miniflare D1/R2) | Needs deployed |
| --- | --- | --- |
| Worker code runs in workerd; guard excludes `node:sqlite`, `node:child_process`, `local-case`/originals/backup/rescan modules and persistence-dependent `node:fs` use | Yes (built `_worker.js`) | Bundle-size limits are confirmed on deploy |
| D1 SQL, migrations, R2 object round trips, idempotent seeds | Yes, for logic | Hosted concurrency, placement, latency, limits, backups |
| Auth hook fail-closed logic | Unit tests with local fixtures only | Real dev or test Clerk flow and the final hosted test (GRS-100 proofs) |
| Browser paths on synthetic data | Yes, as user-path evidence | Access, TLS, cache headers, custom domains |

A mocked acceptance boundary is never a PASS. Local results are reported as local, at an exact SHA. A step that has not been run is reported as not run, never as PASS.

## Proof recipe (a later implementation ticket; each step leaves a receipt, none has been run)

0. **Access and capacity.** Described above. Nothing below runs on PC1 or PC2 until it passes.
1. **Version proof.** On a throwaway branch, pin `wrangler` and `@cloudflare/vitest-plugin` 1.4.3 next to vitest 5.0.3, and add a second Vitest project for Worker tests. One test writes D1 and R2 through `exports.default.fetch`. Run it under Node and under `bun run --bun test`, and record which works, with exact versions and the host runtime.
2. **Build proof.** On a throwaway branch, build a separate hosted entry with the adapter for the Kit line chosen under GRS-100 (7.2.9 only if Kit 2 is kept); run the built Worker with the chosen adapter's Wrangler command, lease ports and `--persist-to`. `/api/health` must answer. The bundle guard excludes `node:sqlite`, `node:child_process`, `local-case`/originals/backup/rescan modules and persistence-dependent `node:fs` use. Neither Kit/adapter pair is approved here.
3. **Seed, reset, idempotence.** Seed, take a digest, seed again and check the digest is unchanged. Stop the server, delete the persist directory, restart and check the store is empty; then reseed and check the digest matches.
4. **Browser lane.** One synthetic e2e scenario runs against the workerd preview under `browser-lock`. Artifacts are file paths only.
5. **Capacity and concurrency.** On each chosen host, run 1, 2 and 3 leases at once. Record peak RSS, the lowest available memory, swap, disk use and free space, and wall time. Any slot count, memory floor, disk quota and role comes from these numbers and is adopted under GRS-94; the 2-slot browser limit holds until then.
6. **Cleanup.** After `stop`, no lease port listens, no lease process remains, retained artifacts exist, and the directories are gone. Another job keeps running throughout.
7. **Hosted.** Run the GRS-100 deployed-preview proofs as the final gate.

## Unresolved choices

- **Access to PC1 and PC2.** Existing login supplied; additional Tailscale authentication checks or the user's pasted `uname`, `nproc`, `free` and `df` output remain pending. No retry before the check completes.
- **Roles, VM or container.** Whether PC1, PC2 or both host pools, whether pc1's host can share with the CI VM safely, and C against D per host (KVM, owner policy, Chrome).
- **Node as a Wrangler helper runtime** is a user policy choice (step 1 supplies evidence). **Void** (plain Wrangler against the optional SDK or Vite-plugin convenience) is a separate comparison and a user decision.
- **Kit 3 timing and adapter version** belong to GRS-100's migration matrix and advisory decisions; neither Kit 3 with adapter 8 nor Kit 2 with adapter 7 is approved here.
- **Private preview access** (SSH forward or tailnet-only serve), and **slot count, memory floor and disk quota** from step 5 and GRS-94.

## Sources (all read 15 October 2026)

- [S1] https://developers.cloudflare.com/workers/local-development/
- [S2] https://developers.cloudflare.com/workers/local-development/bindings-per-env/
- [S3] https://developers.cloudflare.com/workers/local-development/local-data/
- [S4] npm registry manifests: https://registry.npmjs.org/@cloudflare%2fvitest-plugin/1.4.3 · https://registry.npmjs.org/@cloudflare%2fvitest-pool-workers/0.23.0 · https://registry.npmjs.org/wrangler/4.151.0 · https://registry.npmjs.org/@sveltejs%2fadapter-cloudflare/7.2.9 · https://registry.npmjs.org/@sveltejs%2fadapter-cloudflare/8.0.1 · https://registry.npmjs.org/void/1.1.11 (`@cloudflare/vite-plugin` 1.64.0 appears as a `void` dependency, not read separately)
- [S5] https://svelte.dev/docs/kit/adapter-cloudflare
- [S6] https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/ (version requirement and config); landing page https://developers.cloudflare.com/workers/testing/vitest-integration/
- [S7] https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/
- [S8] https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/
- [S9] https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
- [S10] https://developers.cloudflare.com/workers/wrangler/install-and-update/
- [S11] https://void.cloud/reference/cli/platform-installation
- [S12] https://void.cloud/guide/self-hosted-platform
- [S13] https://void.cloud/guide/platform/development/local and https://void.cloud/guide/platform/development/runtime
- [S14] https://void.cloud/integrations/frameworks/sveltekit
- [S15] https://void.cloud/reference/config (`remote`)
- [S16] https://void.cloud/guide/remote-dev
- [S17] https://registry.npmjs.org/void/-/void-1.1.11.tgz, `docs/guide/remote-dev.md` (downloaded to a scratch directory, read, not installed) · [S18] https://tailscale.com/kb/1193/tailscale-ssh (SSH check mode)
- Repository: `docs/ci-runner.md`, `scripts/ci/pc1-vm`, `scripts/ci/summary.ts`, `scripts/gate.mjs`, `scripts/pidfile.ts`, `docs/development.md`, and the workspace's `orch-bin/browser-lock`.
