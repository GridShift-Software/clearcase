---
status: accepted
date: 2026-10-14
---

# Manual processing queue and candidate import contract

The alpha uses manual processing first, with a stable results-import contract that later automation will reuse. The user confirmed this in [Define the manual processing queue and results handoff](https://linear.app/vaper/issue/GRS-87/define-the-manual-processing-queue-and-results-handoff) on 14 October.

Clients finish uploading and submit a fixed submission for processing. Later files form a new submission rather than changing one already being processed. The user describes the roughly 24–36-hour turnaround as an SLA, while explicitly leaving the fixed, fair metric to be established from actual processing times. Record submission, ready/re-entry, processing, client-wait and publication timestamps; exact clock and late-job rules are not yet defined.

The service team has a shared queue across clients, normally ordered FIFO, and a dashboard to visualize it. Global Admin may reprioritize urgent jobs with a recorded reason. One operator claims each job; reassignment, retries and failure reasons remain visible. The queue holds coordination metadata. Viewing or downloading case contents requires the explicitly granted, audited operator access agreed for client instances.

A job missing required files or passwords waits for client action. Once the missing information arrives, it rejoins the back of the eligible queue to preserve fairness to complete submissions. Record its new ready/re-entry time alongside the original submission time. Previous published results remain available. How these waiting periods affect the SLA remains open.

Clients can see their own submission and processing status. Emphasize when they submitted and notify them when results are published. Notify them when action is required; frequent intermediate emails and precise completion estimates are not initial requirements.

An operator downloads the complete submission with a manifest, processes it locally, and uploads a versioned results package linked to the exact client, case and submission. The new results-import API validates the package and creates a private candidate for preview and approval. Client intake upload is a separate contract. Neither the import API nor later automation publishes results.

The user confirmed the reuse requirement: "So later when we automate, it will hit the same upload endpoint we set up now for manual uploads to get pushed into the preview and approval env". Preserving one candidate-import contract avoids a separate automation path that could bypass package validation or human publication approval.

This chooses a manual workflow with automation-ready boundaries rather than implementing processing automation before the rest of the hosted app works. The existing production operator endpoint remains unverified; this record specifies the new endpoint and does not establish parity with that unknown contract.

## Hosted Rescan & Update, 16 October

The user confirmed that hosted Rescan & Update uses this same path. A case editor's additional or replacement files form a new submission that goes through upload, the processing queue, private review and exact-version publication. There is no server-folder scan and no way around review or publication. The current publication and all user work stay in place until a new version is published. For the hosted app this replaces the local folder rescan of [ADR-0004](0004-local-rescan-backup-and-case-import.md), which still governs the local pilot.

## Resolved since 14 October and still open

[ADR-0010](0010-exact-version-signoff-and-publication.md) settles the review and publication authority, and keeps a service-team processing mistake at its original priority instead of sending it to the back. Private review inside the client instance is the leading topology, with its isolation proof UNRUN. Exact SLA measurement and implementation details remain open. The overall planning gate ([GRS-69](https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha)) remains open.
