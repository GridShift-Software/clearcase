---
status: accepted
date: 2026-10-14
---

# Workers runtime and a Cloudflare-first hosted stack

On 14 October 2026 the user answered the runtime part of [GRS-86, Choose the hosted stack and software audit criteria](https://linear.app/vaper/issue/GRS-86/choose-the-hosted-stack-and-software-audit-criteria). The hosted app keeps SvelteKit and runs in Cloudflare Workers. Bun stays the tool for development, dependencies, builds and the local pilot. The user's answer, verbatim: "we can work on bun for dev and and use workers, if demand rises we can use the boxes or move to boat.dev boxes".

The hosted stack baseline is accepted through the user's answers on 14 and 15 October. The [stack resolution](https://linear.app/vaper/issue/GRS-86/choose-the-hosted-stack-and-software-audit-criteria) holds the complete decision. Its required runtime, storage, identity and tooling proofs remain UNRUN. Dependent implementation waits for approval of the complete hosted-alpha plan ([GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha)).

## What the user confirmed on 14 October

- **Framework.** Retain SvelteKit.
- **Runtime.** The hosted app runs in Workers through SvelteKit's [Cloudflare adapter](https://svelte.dev/docs/kit/adapter-cloudflare). Bun runs development and builds.
- **Provider preference.** Prefer Cloudflare for the app, storage and managed services. Clerk is selected for identity. Live mailbox connections are later work; no new payment checkout is selected.
- **Cloudflare account.** One account managed by the user hosts the client instances. Each client retains separate Workers, databases, file buckets and secrets. Resource isolation does not create separate Cloudflare administrative accounts.
- **Client identity.** Each client has its own Clerk application, separating identity keys, users and configuration. The user chose this separation to support adding and removing accounts per client. Detailed environment and operator-login integration still needs proof.
- **Location and currency.** South Africa is the preferred data location, not a strict country-only requirement. ZAR is the preferred billing display currency; supplier invoices need not be issued in rand. Actual provider locations and fallback regions must be documented.
- **Case-storage fallback.** The EU is accepted where South African placement is unavailable. On 15 October the user selected D1 for structured data and R2 for files as the planned first alpha architecture, conditional on the hosted workload and overhead proofs identified by the completed [storage research](https://linear.app/vaper/issue/GRS-95/assess-d1-and-r2-performance-and-overhead-for-the-alpha-workload). AWS S3 or another provider is only a possible later change.
- **Fallbacks.** Railway was allowed earlier if Workers proves unsuitable. Boxes, or boat.dev boxes, are the path if demand grows. Neither is selected now.
- **Workload.** The sizes known from the proof of concept are the v5 sample, 1,689 documents, and the newer export, 2,131 documents. No byte or concurrency limits are set. Low idle cost matters; bursts during upload and export are expected; background jobs are acceptable.
- **Processing.** Queue processing is manual at first, with roughly 24 to 36 hours as a service target. The accepted queue and publication contracts are recorded in [ADR-0009](0009-manual-queue-and-candidate-import-contract.md) and [ADR-0010](0010-exact-version-signoff-and-publication.md); the fair timing metric remains with alpha acceptance.

## Additional choices confirmed on 15 October

- **Supported framework line.** Plan SvelteKit 3 and its matching Cloudflare adapter before alpha. Preserve the current navigation and accepted behavior through compatibility gates; exact supported patch versions are revalidated at implementation. This is a planning decision, not a completed upgrade.
- **Tooling host.** Supported Node may host vendor CLI and Workers test tooling. Bun remains the app dependency, development, build and local-test toolchain, and hosted code runs in workerd. Prefer Void where it fits the jobs; an install command using Bun does not prove that a CLI runs under Bun. Record the actual host runtime in each receipt.
- **Clerk identity location.** The user accepts minimal US-hosted Clerk identity profiles without region selection. Case documents, extracted text, notes and case assignments stay outside Clerk. This is separate from the EU fallback for case storage.
- **Internal identity.** The Global Admin/operator console uses its own Clerk application, separate from every client application. Staff still need explicitly granted, audited access to case content; an internal login does not grant it.
- **Enrollment.** Alpha is invite-only. Global Admin invites staff and initial firm admins; firm admins invite users into their own client instance. Case assignments remain explicit and independent of membership.
- **Storage architecture.** D1 structured data and R2 files are the planned alpha architecture, conditional on real-hosted performance, integrity, backup/restore and complete-export proofs before onboarding. Resolve the physical layout during design. Additional services need a demonstrated reason, and a failed proof can reject the architecture before release. This supersedes the earlier research-only provisional status; no provider resource is provisioned by the decision.
- **MFA.** Keep MFA behind a feature flag, initially off. The user will enable it later when usage warrants it. Mandatory MFA for alpha is not approved; no paid-plan purchase or numeric activation threshold is selected. Enabling the flag must use the provider's actual MFA capability rather than a UI-only claim.
- **Preferred tooling candidates.** Give Void and Cloudflare's new `cf` CLI priority for capable agent jobs, with Wrangler available for actual gaps or failed proofs. The completed [cf/Void research](https://linear.app/vaper/issue/GRS-102/assess-cf-and-void-for-the-alpha-agent-tooling-jobs) distinguishes automatic SvelteKit setup from configured/prebuilt and Void paths. It identifies a source-level Kit 3/native-D1 route, not a runtime PASS. No wholesale Void SDK, Platform, ORM or auth-provider adoption is implied.

## Required proof and execution boundaries

Use a compatible Node 24 LTS helper, revalidating exact patch pins at implementation. First-party Clerk libraries are the initial integration proof target; the browser/session/CSP path and sibling-domain isolation need real hosted checks. Do not freeze an unsupported community wrapper into the plan.

The [hosted design owner](https://linear.app/vaper/issue/GRS-26/prove-the-hosted-architecture-and-cloudflare-deployment) aggregates the software/Clerk checks, storage research P1-P8 and tooling P1-P10. The delivery plan of 16 October splits them into bounded owners: the runtime, deployment, identity, storage, recovery and notification proofs are GRS-106 to GRS-111 under GRS-26, and the framework migration is GRS-112 under the hosted foundation GRS-36. Every proof is UNRUN. Preserve verify-on-load/fail-closed original integrity. The manual processing queue does not automatically select Cloudflare Queues or Durable Objects.

Build app code without cloud account credentials. Account-scoped API tokens are not a per-client control-plane boundary: validate the intended client's resource manifest and use trusted deployment config/prebuilt output. Void deploy can apply remote D1 migrations, so it also needs explicitly granted migration permissions and a prior bookmark; its credentialed parent loads config from the reviewed revision. Shared agent pools receive no account credentials. Test these boundaries before use.

## What this supersedes, for the hosted app only

Two standing assumptions no longer hold for the hosted app. Both still hold for the local V1 pilot, which keeps `bun run --bun start`, its SQLite stores and its case folder ([ADR-0004](0004-local-rescan-backup-and-case-import.md)).

- **Bun in production.** The workspace instructions require the production entry point to run as `bun build/index.js` with SQLite verified under Bun, and the [product brief](../product-brief.md#proposed-implementation-and-handoff-format) says the same. In the hosted app, Workers is the runtime. Bun evidence covers the build there, not the running app, and Node or Bun evidence is not Workers evidence.
- **A durable local filesystem.** The hosted app cannot rely on a local case folder or local SQLite files for persistent storage. Cloudflare's Node.js compatibility provides a virtual filesystem, but it is not the POC's durable disk. Local file, SQLite and process dependencies need a hosted-compatible design before they can serve hosted requests. The brief already asks for case rendering and validation to stay independent of filesystem and cloud storage access.

## Trade-off

Workers is the preferred deployment for the low-idle, bursty workload. Suitability and actual cost still need proof. The hosted app must replace local persistence assumptions, meet Workers runtime and bundle limits, and account for Cloudflare-specific integrations. SvelteKit's adapter documents limitations for custom Durable Object and Workflow classes; these services may need separate Worker entry points and their own test setup. A hosted Bun process is a fallback whose storage, lifecycle and cost also need investigation.

[Workers Builds' build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/) includes Bun and selects its version through `BUN_VERSION`. On 14 October its documented default was 1.2.15, older than this project's `bun@1.4.2`, so a hosted build would have to pin `BUN_VERSION`. No Workers build or deployment of ClearCase has been made or tested.

## Dependency audit criteria

Each major dependency gets one verdict: **retain**, **upgrade**, **replace** or **remove**. Judge it on five criteria, against its supported stable release:

1. **Maintenance.** Recent releases, an active maintainer and a supported release line.
2. **Security.** Open advisories and how quickly they are fixed.
3. **License.** Acceptable for how ClearCase is hosted and distributed.
4. **Compatibility.** App code builds with Bun and runs in Workers if it reaches hosted server code, or in the browser if it is client-only. Vendor CLI and Workers test-host tooling may use supported Node, with the actual runtime recorded.
5. **Usefulness.** It earns its place over the platform or the standard library.

Initial notes on the direct dependencies in `package.json`, not yet verdicts:

| Dependency | Note |
| --- | --- |
| `@sveltejs/kit`, `svelte`, `@sveltejs/vite-plugin-svelte`, `vite` | SvelteKit is retained by decision; check each against its supported release. |
| `@sveltejs/adapter-node` | Serves the local pilot. The hosted build needs `@sveltejs/adapter-cloudflare` alongside or instead. |
| `typebox`, `@cfworker/json-schema` | Validation at import. Confirm they run in Workers. |
| `pdfjs-dist` | Check whether it reaches the server bundle, given Workers' size limits. |
| `typescript`, `svelte-check`, `vitest`, `@types/node` | Build and test tools; they do not ship to Workers. |
| Local SQLite storage | The local stores require a hosted-compatible persistence design. |

## Not decided here

- Physical D1/R2 layout and proof results; extra services such as Durable Objects are not selected by default.
- Clerk environment configuration and the browser/session/CSP integration proofs; the separate internal Clerk application is selected.
- Actual provisioning locations, with EU accepted for Cloudflare case stores and US Clerk identity hosting accepted separately.
- Final dependency pins and adoption proofs, informed by the completed software inventory and cf/Void comparison.
- Proof that the app runs in Workers, and cost estimates.
- The fair service-target metric and release acceptance; queue and publication behavior are settled in their own decisions.
- The full-plan approval and execution authority; the stack baseline is accepted, but no implementation or cloud execution is authorized by this ADR.
