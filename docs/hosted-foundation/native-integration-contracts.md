# Native alpha: upload authority and submission/import linkage

**Contract preparation only.** The types in `runtime/hosted/alpha-contracts.ts` have no authorizer, grant writer, repository, endpoint or publication implementation. They do not make the native flow ready.

## Client upload authority

- Name: `case.upload-originals`, distinct from read, write-user-work, operate and publish. Client, staff and firm-admin identity alone never implies it.
- Initial grant owner: the trusted **non-request provisioning entrypoint**, with an explicit client/case/principal grant and recorded revocation. No self-grant or request-driven bootstrap. This is a composition contract, **not permission to change held GRS114 policy/source**; that implementation needs separate authorization.
- The real authorizer must check current explicit case access, the distinct upload grant and revocation before intake reads a body, submission or asset. Capture the verified principal/session and deployment client from trusted request services, never form fields.
- Unknown and ungranted cases give the same 403 without metadata. An unconfigured authorizer stays null/503, not an allow-all or borrowed capability. Authentication and infrastructure failures remain uniformly 401/503 as applicable.
- The intake port is structurally compatible. No adapter is wired by this document.

## Immutable import link

Accepted [ADR0009](../adr/0009-manual-queue-and-candidate-import-contract.md) requires the operator package to be linked to the exact client, case and finalized submission. A separate immutable server row pins:
1. deployment clientId and caseId;
2. finalized submission revisionId and SHA-256 of the **exact persisted manifest bytes**;
3. server candidate instance, supplied resultsVersion, exact package manifestSha256 and the **actual package inputRevision.id**;
4. verified, explicitly case-authorized operator and server link time, recorded separately from package provenance.

A reserved revision is not finalized: the reader must check the upload state, not just the existence of a revision row. The submission manifest's current reserve-time timestamp is not proof of final-mark time or an SLA metric.

The converter inputRevision hashes its input HTML, not uploaded PDFs. Preserve all supplied package IDs and source hashes unchanged. The row is manual operator **attribution**, never proof that processing or the human-only recipe ran. No unknown package top-level fields or automatic combining of submissions.

## Original mapping and review

- Initial exact-link policy: every required `kind:file` original maps to a finalized-submission file by path, SHA-256 and size, with verified case/client ownership. Record both literal paths for a canonical, unique case/NFC resolution; preserve its warning. Ref aliases may share the same verified file fact.
- The distinct required file-fact set must equal the submission file-fact set. An unmatched required mapping, ambiguity, subset or extra submitted file leaves the candidate private and **unlinked**. There is no implicit subset permission.
- Canonical `missing` and `embedded` entries remain explicit/unavailable. They gain no invented hash or verified-bytes claim. Existing warning acknowledgement, required-section and publication rules remain in force; this link is not a waiver.
- Corrections require a new candidate instance, immutable link and exact sign-off. Matching a case slug, resultsVersion alone or an old approval cannot establish lineage. Sign-off also pins package manifestSha256 and the submission/link identity.
- Publication, private preview, audit durability, D1 immutability, stored-byte verification and the real authorizer are **unimplemented/unverified here**. Neither import nor creating a link publishes.
