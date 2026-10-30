# Security and integrity retrospective

Review date: 22 October 2026. Replacement reviewer for the failed security task only. No implementation, test, configuration, skill, branch, commit, deployment or external-service changes were made. The only authored artifact is this report.

## Revision and evidence boundary

- Current dev baseline and inspected checkout: `225b7e00578319d16383678a8d1ae6efb362a0ba`, branch `audit/retrospective-2026-10-22`.
- Incoming proofs: `a3f80d1305294a8c685a87351281eef7928c7d9c`, PR 114, inspected with `git show`; its merge base with dev is the pinned dev revision.
- Incoming guard followups: `99cf56bba6afc0bf30d0dc914816ad97d1a750ae`. Its merge base with dev is **`e44e12b397561e7d7ad229e8fad00753db9f00bc`**, not current dev. Its three-dot diff contains no changes under `src` or `deploy`. A two-dot comparison misleadingly shows older CSV defenses, converter mappings and UI behavior; those are not proposed reversions by this branch. None is counted as a new incoming security defect.
- Reviewer doctor was attempted through Git Bash. It refused: `agent-tools: unsupported OS 'msys'. Supported: Linux (Arch, CachyOS) with bash >= 4.4. See docs/agent-tooling.md.` No gate or acceptance receipt is claimed. Installed Bun is `1.3.10`, below the repository pin `1.4.2`; nothing was installed or upgraded.
- Small, in-memory synthetic reproductions used Node `v22.17.1` with its experimental TypeScript stripping. They exercised selected source functions or explicitly simulated I/O; they are **not acceptance evidence**, a Bun compatibility result, or a production exploit demonstration. No PDF, archive, original, credential or case-data file was written or read for these probes.
- Read instructions and relevant development, package, glossary, tooling, bundle and recovery contracts. Invoked skill: `cloudflare` (`C:/Users/dianb/.codex/skills/cloudflare/SKILL.md`). No other skill or subagent was invoked.
- Linear connector reads worked for GRS-113, GRS-115, GRS-118 and GRS-128; all were Backlog at read time. Searches were used as supplementary context, not an exhaustive proof that no ticket exists. No Linear writes or PR monitoring were performed.

**Assessment:** four actionable local-code findings and one incoming storage-proof finding. The strongest integrity risk is the incoming multipart completion race. I found no demonstrated app-origin XSS, SQL injection or hosted cross-client disclosure in the inspected production graph. This is not a certification of their absence: browser, crash, filesystem-race and native workerd acceptance were unavailable.

## Findings

### SI-01 — High / P1: incoming multipart completion can overwrite an acknowledged original

**Scope:** incoming proof only, at `a3f80d1305294a8c685a87351281eef7928c7d9c`. `tests/hosting-probe/storage/src/worker.ts:1136-1146`, especially the `head` at 1141 and `complete` at 1145; finalization starts at 268. Owner context: GRS-109; carry the correction into GRS-115's storage contract. **Not a vulnerability in the current hosted product**, whose protected production services remain unavailable.

**Trigger:** two multipart uploads target the same absent `orig/<sha256>` key. Both completion requests pass `head(key) === null`. Completion A stores the correct original, and a separate finalize request hashes it and commits its D1 identity. Completion B, delayed after its earlier `head`, then completes different bytes into the same key. The completion API does not verify the expected SHA-256. B need not successfully finalize to destroy A's acknowledged bytes.

**Impact:** loss of the live original for every case referencing that digest. Later verified reads detect the mismatch and refuse, which prevents silent delivery of wrong bytes but does not preserve the acknowledged original. An ordinary retry with identical bytes is less harmful; the damaging case is a malformed or hostile concurrent multipart upload. This requires access to the upload path in the probe, not a hash collision or an R2 administrator.

**Evidence:** the actual completion block was extracted from the incoming Git object and run with a simulated R2 adapter. Both `head` calls were held until both had observed absence; B's completion was held until A returned. Result:

```json
{"emptyHeadReads":2,"acknowledgedBytes":"correct original","finalBytes":"different bytes","overwritten":true}
```

The acknowledgement in that reproduction is a marker between completions, not a real D1 finalize. The real `finalize` function's hash-then-batch path can occupy that interval by source inspection. Native workerd/R2 reproduction is still required. Cloudflare documents parallel operations on multipart uploads and exposes `complete(uploadedParts)` without a conditional-write argument; a prior `head` does not make completion conditional. [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2multipartupload-definition)

**Current mitigation and why the existing proof is insufficient:** `head` rejects a key that already exists when checked, and finalize checks the full digest. The incoming `write-once` evidence (`docs/acceptance/hosting/storage.md:69`) covers a key appearing before the completing request's check. It does not cover two requests passing that check. This is a narrower new race beyond the already-fixed overwrite case.

**Smallest reliable fix:** complete each upload into an upload-specific immutable object key, verify that object's bytes, then atomically bind the logical original identity to that exact object in D1. A losing upload must never write the winning object's key. Alternatively, serialize all writers of a logical key through a durable coordinator with recovery-safe ownership; an isolate-local mutex or another `head` is insufficient. Preserve large-file support when choosing the approach.

**Validation:** a native-workerd test must pause two completions after their absence checks, finish and finalize A, then release B with different bytes. Assert A remains byte-identical, B is rejected or remains isolated, and restart/retry cannot publish B over A. Include the single-PUT versus multipart race and two simultaneous completions. **Confidence: high in the code-level race; native platform exercise pending.**

### SI-02 — Medium / P2: short writes can certify a corrupt large-original snapshot

**Scope:** current dev `225b7e00578319d16383678a8d1ae6efb362a0ba`. `src/lib/local-case/fsafe.server.ts:74-87`; consumer `src/lib/local-case/originals.server.ts:189-209`. Related owner: local pilot CC-03/GRS-12, with GRS-115 owning the later original-serving migration. No dedicated short-write issue was established by this review.

`snapshotVerified` hashes each input chunk, calls `out.write(...)` once, ignores `bytesWritten`, and advances the position by the requested chunk length. Its success digest covers the input, not what reached the snapshot. A successful partial write can therefore leave a hole or short tail while `snapshotVerified` returns true. The serving path trusts that return and streams the snapshot without a destination size/hash check.

**Trigger/impact:** a short write while preparing an original larger than the default 32 MiB buffering threshold. If an early chunk is short and later positional writes succeed, the snapshot can have the expected total length with zero-filled gaps, so Content-Length does not necessarily expose corruption. The actual case-folder original is not modified, but ClearCase can release bytes that do not match its recorded identity. This is an I/O-fault integrity defect, not a claimed remotely induced filesystem failure.

**Evidence:** source-derived `snapshotVerified` with in-memory input and a destination returning `bytesWritten: 7` for a 17-byte chunk produced:

```json
{"verified":true,"inputBytes":17,"snapshotBytes":7,"snapshotMatches":false}
```

The test replaced filesystem calls and is explicitly fault injection, not an acceptance-boundary PASS/FAIL. Node's API returns the count actually written; the caller must account for it. [FileHandle write documentation](https://nodejs.org/api/fs.html#filehandlewritebuffer-offset-length-position)

**Smallest fix:** loop until the entire chunk is written, advance offsets by `bytesWritten`, and fail on zero progress; retain cleanup on any failure. A destination size check is useful defense in depth but does not replace the loop.

**Validation:** force an early short write followed by successful later writes, a final short write, zero progress and ENOSPC; the only allowed outcomes are exact bytes or refusal with snapshot cleanup. Run the actual large-original HTTP path under supported Bun/Linux before closing. **Confidence: high.** Neither incoming branch's relevant change set fixes this function.

### SI-03 — Medium / P2: generated PDF bundles retain source page-open JavaScript

**Scope:** current dev. `src/lib/bundles/pdf/assemble.ts:402-405`, `src/lib/bundles/pdf/writer.ts:130-153`; reachable from `src/lib/views/bundles/Builder.svelte:33,79-82`. Bundle owner: CC-09/GRS-19; future durable-bundle owner GRS-128. This active-content issue is distinct from GRS-128's already-planned persistence of browser-only inputs and outputs.

**Trigger:** add a PDF whose page dictionary has `/AA << /O << /S /JavaScript /JS (...) >> >>`, then create and download the bundle. Assembly removes annotations and several structural keys, but copies all other page keys. `/AA` and its JavaScript object survive the deep copy into the new PDF.

**Impact:** an apparently newly generated ClearCase bundle carries attacker-authored executable PDF behavior into recipients' readers. Page-open JavaScript can run in readers/settings that support it. This review did **not** demonstrate execution in Chromium, an app-origin privilege escape, code execution on the operating system, or exfiltration. The protected original viewer's scripting restrictions do not sanitize downloaded generated bundles. Adobe documents JavaScript actions triggered by page opening. [PDF actions in Acrobat](https://helpx.adobe.com/ae_en/acrobat/desktop/edit-documents/apply-pdf-actions/pdf-actions.html)

**Evidence:** an in-memory one-page PDF with inert script `void(0)` was serialized, opened by the production parser, assembled, and reopened. Output inspection returned:

```json
{"pages":1,"pageOpenAction":"JavaScript","script":"void(0)"}
```

No script was executed. Originals must stay byte-exact; a generated derivative has a separate active-content policy.

**Smallest fix:** omit page additional actions (`AA`) from generated bundles and explicitly define which page keys may be copied. Audit the recursively copied graph for other action/embedded-file carriers rather than claiming that dropping `Annots` sanitizes the document. Keep the untouched original available under its normal controls.

**Validation:** direct and indirect `/AA` action dictionaries disappear from generated output; benign visual content, page selection, numbering and index links remain correct. Include `/Next` action chains and ensure rejected/removed active content cannot reappear through copied references. **Confidence: high for preservation; reader-dependent execution impact.** No relevant incoming fix identified.

### SI-04 — Medium / P2: PDF decompression is unbounded in the interactive bundle builder

**Scope:** current dev. `src/lib/bundles/pdf/doc.ts:16-24,284-298`; `src/lib/views/bundles/Builder.svelte:23-38`; decoding is also reached during `assemble.ts` content/resource processing. Same bundle ownership as SI-03.

**Trigger:** select a small PDF with a highly compressed Flate object stream, xref stream or page/resource stream. `inflate` pipes through `DecompressionStream` and collects the entire output with `Response.arrayBuffer()`. There is no decoded-byte budget, cumulative-document budget or cancellation check in this path; the file picker also reads each whole source without a size check. Archive-import bounds do not protect this independent PDF parser.

**Impact:** a hostile source can exhaust the browser process's memory or make the bundle workspace unresponsive. The process holds selected PDFs and unsaved bundle state; a tab crash can lose that unsaved work. This is a browser-local availability issue requiring file selection, not server takeover or loss of acknowledged database work.

**Evidence:** a bounded reproduction passed a 1,040-byte synthetic Flate stream through the actual `Doc.decode` and obtained 1,048,576 bytes. The source has no larger-size refusal. This demonstrates the expansion path, not an OOM event; no large bomb was run.

**Smallest fix:** consume decoded chunks under a per-stream and aggregate byte budget before buffering them, abort on excess, validate predictor allocation dimensions, and expose a recoverable refusal. Move parsing/assembly into a cancellable worker if a time budget is needed; moving it alone does not bound memory.

**Validation:** small synthetic fixtures crossing a deliberately small test budget, nested filter chains and oversized predictor dimensions must refuse without killing the page or discarding existing builder work. Preserve ordinary compressed PDFs. **Confidence: high for the missing limit; no browser crash reproduced.** No dedicated fix identified in the inspected incoming changes.

### SI-05 — Medium / P2: workspace HTML is fully allocated before any source-size bound

**Scope:** current dev. `src/lib/local-case/case-pack.server.ts:95,221-230`; `src/lib/case-package/v5/extract.ts:25-36`; `src/lib/case-package/v5/adapter.ts:100-106`. Owner context: case-pack import and converter, GRS-12/GRS-22. This is not the unverified hosted results-import endpoint.

**Trigger:** choose a case folder containing one extremely large main `.html` file, or import a case ZIP containing it. `prepareCasePack` uses unrestricted `readFile(html)`, then `extractV5` decodes the entire buffer and splits it into lines. It has no HTML byte/line cap. Directory input avoids archive bounds entirely; case-pack ZIP limits intentionally allow nearly 4 GiB per member and a very large aggregate, while the free-space check concerns disk rather than process memory.

**Impact:** a supplied case pack can exhaust or heavily stall the pilot process before useful validation/cancellation is available. The strict JSON depth/string/value limits are applied later and do not protect the initial buffer, string or line-array allocations. Synchronous decoding and scanning also delay the server's handling of cancellation and other requests. Existing durable database transactions reduce corruption risk; loss of committed user work is not established.

**Evidence:** static call-path inspection; no memory-exhaustion attempt. This is separate from normal large original files, which can be fingerprinted/served without decoding them into one JavaScript string.

**Smallest fix:** add a workspace-HTML source limit shared by the library and UI; open/fstat a regular source descriptor and read at most limit+1 bytes before conversion. Thread cancellation through the bounded read and long processing stages. Size checks must protect the read itself, not run after `readFile`. Preserve the supported v5 and newer fixtures within a documented ceiling.

**Validation:** a synthetic file just over a small configured limit must be refused before full allocation, with the active version and saved user work unchanged. Cover both directory and ZIP case-pack paths, and cancellation during bounded reads. **Confidence: high for the unbounded path; runtime OOM behavior not measured.** No relevant incoming fix identified.

## Controls that held up under source review

- **Untrusted HTML and XSS:** v5 extraction parses literals rather than executing source code. Strict JSON rejects duplicate keys and malformed encodings and bounds nested values. The one `{@html}` component (`src/lib/components/Narrative.svelte:7`) goes through the escaping/citation renderer in `src/lib/case-package/render.ts`; citation hrefs are constrained to safe app-relative paths. App CSP in `vite.config.ts` disallows arbitrary inline scripts and framing by other origins. No working XSS payload was found in these paths.
- **Original isolation and immutability:** `fsafe.server.ts:21-38` checks the already-open descriptor through `/proc/self/fd`, verifies containment and regular-file type, and rejects hard links. `originals.server.ts` checks the case-root device/inode, size and SHA-256 before serving. The viewer is on a separate site with sandbox/CSP controls; scripting is disabled in `viewer/viewer.mjs:5`. SI-02 concerns the derived temporary copy, not writes to the case-folder originals.
- **Traversal/archive handling:** `case-package/paths.ts` rejects absolute paths, traversal, encoded separators and invalid segments. ZIP parsing rejects symlink/special members, duplicate/colliding names and excessive declared expansion; actual inflate output is constrained to the declared size. Extraction uses exclusive output creation in a temporary directory. No archive-member-only path traversal was demonstrated. Concurrent mutation of parent directories by another local process was not exercised; path checks and O_NOFOLLOW on a final component alone should not be advertised as proof against every such race.
- **Local request boundary:** `src/hooks.server.ts:26-42` enforces loopback addresses, exact Host, Fetch Metadata checks on APIs and JSON write content types. The supported launcher applies Host checks before static assets; app forms retain framework Origin checking. This is a local single-operator trust boundary, not hosted identity or separation between processes running as the same OS user.
- **SQL and restored state:** reviewed value writes use bound parameters. Generic table definitions validate identifiers and quote them; import planning rejects activation/import tables, checks scope and handles cross-case key collisions (`user-work.server.ts:321-338,531-556`). I found no SQL injection in those paths. A backup checksum detects alteration/corruption but is not a signature establishing who authored a backup.
- **Atomic activation:** `service.server.ts:338-375` serializes activation and revalidates candidate bytes and originals. `store.server.ts:159-171` commits the active pointer and activation log in one `work` transaction. `db.server.ts` uses FULL synchronous mode and rolls back failed writes. The presence of WAL for the separate results database is not, by itself, evidence that this pointer/log operation spans a non-atomic pair of databases.
- **Backup/restore:** `backup/backup.server.ts:101-131` requires a pre-restore copy before import. Generic replacement runs in a transaction and refuses protected state. `store.server.ts:174-188` fsyncs and renames the new work backup before pruning older ones. This is strong local durability structure; it does not prove a disaster recovery objective or hosted completeness.
- **Hosted fail-closed boundary:** production `runtime/hosted/services.ts:15` returns `ready:false`; protected requests stop before routes. `handle.ts:31` checks Origin on unsafe methods. Gate identity/assets code is explicitly a test profile: it rechecks grants, verifies bytes and records successful delivery before releasing it. Its sign-in selector is not a deployed authentication bypass. The route for originals delegates case/asset authorization to the assets service rather than trusting a client-supplied object path.

## Incoming proofs and already-tracked work

The incoming proofs support design evaluation, not an integrated production readiness claim. Inspection of the identity, storage, recovery and notification implementations found meaningful safeguards: issuer/party/session checks, explicit case grants, bound SQL/guarded batches, digest-checked object delivery, deletion records reapplied during recovery, and generic notification templates that exclude case details. None was rerun here.

Do not convert the following existing limitations into duplicate new defects:

- **Staff deactivation and operator grant revocation:** incoming `docs/acceptance/hosting/identity.md:88-89` explicitly records the missing grant-revoke route and that removal from staff D1 does not reach client grants. `access.js`'s operator-grant branch relies on the grant/session, not the remote staff roster. This is a serious **tracked product obligation for GRS-113**, not a newly discovered silent bypass. Verify deactivation propagates to every client before production acceptance.
- **Local backup path and global scope:** current `views/system/backup.server.ts:51-66` accepts operator-entered server paths; `backup/backup.server.ts:35-39` includes store-scoped rows. [GRS-118](https://linear.app/vaper/issue/GRS-118/implement-complete-case-export-backup-recovery-and-approved-deletion) explicitly requires replacing absolute-path restore and unfiltered store-scope assumptions and denying cross-case/global tables. These local assumptions must not be copied into a hosted route.
- **Durable bundle bytes:** the current builder saves metadata while PDF blobs and input documents remain in browser state. [GRS-128](https://linear.app/vaper/issue/GRS-128/persist-pdf-bundles-with-pinned-inputs-and-protected-version-history) expressly owns persistent inputs, exact version pins and retained outputs. This is planned work; SI-03 and SI-04 are distinct active-content/resource issues.
- **Hosted production adapters:** [GRS-113](https://linear.app/vaper/issue/GRS-113/implement-clerk-invitations-sessions-and-hosted-access-checks), [GRS-115](https://linear.app/vaper/issue/GRS-115/implement-hosted-d1-results-storage-and-protected-r2-assets), GRS-117 and GRS-118 remain the implementation boundary. Client original upload proofs do not validate the product's processed-results import endpoint.
- **Partial restore under concurrent activation:** incoming `docs/acceptance/hosting/storage.md:176` discloses the residual where the user-work batch commits, activation races before the final flip, and the restore refuses while replaced work remains. The pre-restore copy exists, but this is not all-or-nothing whole-case recovery. Keep this known residual on the design/production handoff, alongside unproven export-step races and actual D1 recovery/placement evidence.
- **Already-fixed incoming overwrite case:** the storage proof now refuses a wrong-size finalize without deleting the shared original, and refuses multipart completion when the key is already present at its check. Those fixes are present at `a3f80d1`; SI-01 addresses the remaining check-to-completion concurrency window.
- **Privacy/logging:** local error handlers can log raw errors and filesystem paths; hosted `handle.ts:45` also logs raw unexpected errors. No actual disclosure was demonstrated. Before adapters handle real case data, structured redacted operational logging and failure-case canaries should verify that text, tokens and source paths cannot reach hosted logs. The notification proof's fixed templates and error-code-only recording are useful patterns, not proof that every product log follows them.

## Reproduction ledger and limits

All successful snippets below were in memory on the pinned dev checkout. They read only source/Git objects. No real case data or remote service was involved. The I/O substitutes deliberately expose logic paths and **must not be cited as acceptance-boundary test results**.

| Probe | Source | Result | Practical limit |
| --- | --- | --- | --- |
| PDF page action | Actual `Out`, `open`, `assemble`, then `open` again | A one-page derivative retained `/AA /O /JavaScript` with `void(0)` | Did not open in a browser or execute JavaScript |
| PDF inflation | Actual `Doc.decode`, 1 MiB of compressed synthetic spaces | 1,040 input bytes became 1,048,576 bytes | Bounded demonstration, not an OOM test |
| Original snapshot | Source-derived `snapshotVerified`, filesystem calls substituted | `true` for a 7-byte destination from 17-byte verified input | Fault injection, not actual short writes under Bun/Linux |
| Multipart completion | Actual incoming completion block, simulated asynchronous R2 | Two absent heads allowed B to replace A | No native R2 or D1; real finalize interleaving inferred from source |

The first two can be reproduced without writing any artifacts by passing this module on stdin to `node --experimental-strip-types --input-type=module` from the repository root:

```js
import { Out, str } from './src/lib/bundles/pdf/writer.ts';
import { nm, PRef, PStream, enc } from './src/lib/bundles/pdf/objects.ts';
import { Doc, open } from './src/lib/bundles/pdf/doc.ts';
import { assemble } from './src/lib/bundles/pdf/assemble.ts';
import { deflateSync } from 'node:zlib';
const out = new Out();
const cat = out.alloc(), tree = out.alloc();
const action = new Map([['S', nm('JavaScript')], ['JS', str('void(0)')]]);
const page = out.add(new Map([
  ['Type', nm('Page')], ['Parent', new PRef(tree)],
  ['MediaBox', [0, 0, 100, 100]], ['AA', new Map([['O', action]])],
  ['Contents', out.add(new PStream(new Map(), enc('q Q')))]
]));
out.put(tree, new Map([['Type', nm('Pages')], ['Kids', [page]], ['Count', 1]]));
out.put(cat, new Map([['Type', nm('Catalog')], ['Pages', new PRef(tree)]]));
const doc = await open(out.bytes([['Root', new PRef(cat)]]));
const built = await assemble([{ doc, from: 1, to: 1 }]);
const reopened = await open(built.bytes);
console.log(reopened.pages()[0].dict.get('AA').get('O'));
const compressed = deflateSync(Buffer.alloc(1024 * 1024, 32));
const expanded = await new Doc(new Uint8Array()).decode(
  new PStream(new Map([['Filter', nm('FlateDecode')]]), compressed)
);
console.log({ compressedBytes: compressed.length, decodedBytes: expanded.length });
```

The short-write reproduction reads `fsafe.server.ts`, strips TypeScript/import/export syntax, and evaluates `snapshotVerified` with an original descriptor exposing 17 bytes and matching stat identity; its synthetic output descriptor copies only seven bytes and returns `{bytesWritten:7}`, while `sync` succeeds. The ignored count is sufficient to return `true`. The multipart reproduction extracts only the completion block at incoming lines 1136-1146 and supplies a two-caller barrier for `head` and a delayed second `complete`; no production file was patched.

This audit inspected the principal security/data-integrity code paths and scanned rendering, filesystem, SQL and process-use sinks. It did not read every source line, audit dependency binaries, exercise the 42 views, establish browser-specific PDF execution, validate filesystem races, test crash recovery, or run against Cloudflare/Clerk. Claimed evidence in committed reports remains the prior authors' evidence at their stated revisions, not a fresh PASS from this reviewer.

## Top priorities for the parent

1. Resolve **SI-01** before treating the incoming storage design as a write-once foundation. Require the native concurrent-completion test and preserve its distinction from the unavailable hosted product.
2. Fix **SI-02** in the local serving path and prove exact large-original bytes under short-write/failure injection on supported Bun/Linux.
3. Address **SI-03/SI-04** together at the PDF bundle boundary: explicit active-content removal for derivatives and bounded decoding, while preserving original bytes.
4. Bound workspace HTML before allocation (**SI-05**). Keep the already-tracked hosted revocation, recovery, store-scope and persistence obligations attached to their owners rather than declaring those foundations complete from separate probes.

Report: `docs/reviews/retrospective-2026-10-22/security-and-integrity.md`.
