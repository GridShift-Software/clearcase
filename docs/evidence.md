# ClearCase scope evidence

Observed on 8 October 2026. This note distinguishes the supplied product reference from the current hosted implementation.

## Local reference

The original archives remain under `/home/vaper/Work/Active/MX-two/ClearCase/RAWS/`. The initial product reference is `ESS_DCS_Lawyer_Pack_v5-002.zip`, main `ESS_DCS_Workspace.html`. Its `META` declares `docCount: 1689` and `builtAt: 2026-08-12 19:30`. Its `NAV` contains 42 entries. The older manual describes 1,562 documents and is not authoritative for current counts.

The later `ESS_DCS_all_data.json` has 2,131 chronology rows. Earlier inspection reconstructed its final `DATA` exactly from the corresponding September HTML's embedded `DATA` and analysis merge. That establishes the offline export relationship. It does not establish the hosted upload API or prove that the hosted backend performs no further transformation.

Detailed local research remains available in ignored local storage:

- [Producer and transformation findings](/home/vaper/Work/Active/MX-two/ClearCase/worktrees/local-v1/.local/research/clearcase-transform/producer/REPORT.md)
- [Dataset to view mapping](/home/vaper/Work/Active/MX-two/ClearCase/worktrees/local-v1/.local/research/clearcase-transform/render/transform_map.md)
- [Observed field inventory](/home/vaper/Work/Active/MX-two/ClearCase/worktrees/local-v1/.local/research/clearcase-raw-review/schema/field_inventory.json)
- [Offline merge verification](/home/vaper/Work/Active/MX-two/ClearCase/worktrees/local-v1/.local/research/clearcase-transform/merge-verification.json)

These persisted paths are machine-local research aids, not portable project dependencies. Do not commit the case material as application fixtures. The implementation should generate a local fixture inventory from the designated archive.

## Existing operator route

The authenticated firm-admin view exposes Cases, Team and case-result views. It does not expose an operator results-upload link. Earlier navigation to `/admin` redirected to `/cases`; that is a role/access observation, not proof that the endpoint does not exist.

The inspected client upload chunk contains `/api/uploads/manifest`, `/api/uploads/sessions`, `/api/uploads/multipart`, `/api/uploads/state` and `/api/submissions/{id}/submit`. These implement client intake. They must not be described as the results-import API.

In the follow-up check, 15 JavaScript resources referenced by the loaded risk page were fetched successfully. The route scan found authentication and firm-billing API paths, but no admin/operator/results-import route. A fresh navigation failed with `ERR_NAME_NOT_RESOLVED`; the existing page and its resources remained inspectable. No route enumeration, role changes or uploads were attempted.

A Gmail search for recent ClearCase correspondence returned the previously reviewed comments and prompts emails, plus the user's forward. The reviewed comments email, Gmail, 8 October 2026, not linked, contains no operator URL. The current results-import path and schema remain unverified. Confirm them from operator access or application source when available.

## External technical references

- [Knap](https://knap.md/) documents data-to-Markdown templating. Markdown-to-results conversion requires separate parsing and validation.
- SvelteKit documents deployment to [Node](https://svelte.dev/docs/kit/adapter-node) and [Cloudflare](https://svelte.dev/docs/kit/adapter-cloudflare). Sharing the viewer across those targets is a proposed design.
- [Cloudflare Container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/) describes Worker and Durable Object routing and container start/stop behavior. Per-client instances still require explicit durable storage and authorization.
