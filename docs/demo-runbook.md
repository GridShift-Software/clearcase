# Demo runbook (14 October 2026)

What the audience sees: a case already loaded, a second case imported live by clicking, and every view of both. Nothing here needs a network.

## Safe build for the demo

The rehearsed build is tag `v0.0.1-rc.4` (commit 8410f4d); the tag `demo-safe` is the same code with this runbook. To get back to it from any later state:

```sh
git fetch --tags origin
git checkout demo-safe
bun install --frozen-lockfile
bun run --bun build
bun run --bun start
```

The data directory is not touched by a checkout, so imported cases stay. A case imported by a newer build may carry a results version the safe build cannot read; if a case shows a recovery banner after switching back, import its pack again.

## Before the demo (10 minutes)

1. Build and start, from the checkout, with Bun 1.4.2 or newer:

   ```sh
   bun install --frozen-lockfile
   bun run --bun build
   CLEARCASE_DATA_DIR=~/clearcase-demo bun run --bun start
   ```

   Use a fresh data directory so the Cases page starts empty. Open http://127.0.0.1:41101 in Chrome.
2. Preload the SA Centres case. Choose **Import a case**. Step 1: type `SA Centres` as the **Case name**. Step 2: choose **Add documents** and click the SA Centres zip (or, if it was extracted, open the folder that holds `SA_Centres_Workspace.html` and choose **Use this folder**). Step 3: leave the store folder as it is, or **Change** it to any folder outside the case. Step 4: choose **Open case**. Extracting, converting and validating takes about 30 seconds from the zip, or ten from a folder. On the report, tick the acknowledgement and choose **Activate this version**.
3. Open **Cases** and confirm one Active case. Keep the ESS zip (`ESS_DCS_Lawyer_Pack_v5-002.zip`) in a folder the picker can reach, with at least 4 GB free beside it.
4. Restart the server once (`Ctrl-C`, then `start` again) and confirm the case is still there. This is what the demo machine will do after a reboot.

## The demo (about ten minutes)

1. **Cases.** The list shows SA Centres as Active with its document count. Open it, walk the Overview tiles, Chronology, Documents, a document page and its original, Matter & Strategy, Contradiction Tracker, Risk Matrix.
2. **Import live.** Choose **Import a case**. Step 1: type `ESS v DCS` as the **Case name**. Step 2: choose **Add documents** and click the ESS zip. Step 3: keep or change the store folder. Step 4: choose **Open case**. The progress line runs through extracting, finding the workspace HTML, converting, writing and validating; a 3.2 GB zip takes 10 to 30 seconds on an SSD.
3. **Validation report.** Point out the verdict, the warning counts and that nothing is active until the acknowledgement is ticked. Tick it and choose **Activate this version**.
4. **ESS v DCS.** Overview with Quantum tiles, Chronology, Documents, Invoice Ledger, Quantum & Interest, Enforcement Roadmap, Court Bundle. Open an original PDF.
5. **Switch back.** **Cases** at the top of any page lists both cases; Open either one.

## If something goes wrong

- An import refuses a destination: the message says why (not enough space, inside the case folder, inside the data directory). Choose another folder.
- A page shows a recovery banner: the stored results failed their check; import the same pack again.
- The server will not start: another ClearCase holds the data directory. Stop it with `bun run --bun start --stop` in that checkout, or use another `CLEARCASE_DATA_DIR`.

## Known gaps to say out loud

- Quantum, Invoice Ledger, Prescription, Interest, Payments and Settlement are empty for SA Centres: its pack carries no quantum data.
- The Carroll pack is a different product's export and is not importable yet.
- Emails, WhatsApp, organogram, KYC, billing, audit log and the Outlook integration are production-only or arrive with the newer export (see GRS-64).

## Importing the newer ESS pack

The newer export of the ESS case, `ESS_DCS_Lawyer_Pack-001.zip` (3.8 GB; 2,131 documents, 8 bundles, built 22 September 2026; the one production shows), imports the same way as the v5 zip: **Import a case**, type the case name, **Add documents**, click the zip, **Open case**. Extracting and converting takes under a minute from an SSD. The report's verdict is REPORT, warnings only; one of them, `V5_DATASET_SHAPE_UNMAPPED`, says the export's prescription summary is empty and was kept aside. Tick the acknowledgement and **Activate this version**. Every view opens. Overview, Chronology, Documents, Matter & Strategy, Quantum & Interest, Invoice Ledger, Contracts, Filings & Affidavits, Court Bundle, CaseLines, Discovery Schedule, Interest Recalculator, Settlement / BATNA, People and Entities show the newer data, with production's figures (R284.1 m owing at 31 May 2026, 241 invoices, 122 people, 12 entities). Views that stay empty because the export carries no rows for them: Timeline, Contradiction Tracker, Risk Matrix, Defence & Rebuttal, Info Required, Witnesses, Enforcement Roadmap, Legality & SIU Risk, Prescription, Cause of Action, Authorities and Cross-Exam Prep. Emails, WhatsApp, organogram, anchors and transcripts arrive as residual datasets with no view yet.

## What differs from production (checked 14 October against the hosted app)

Production shows the ESS case from the newer 2,131-document export. With the v5 pack loaded, the local app shows the older export of 1,689 documents and counts differ for that reason alone (with the September pack loaded, the headline figures match production, but the analysis views are empty; see above): documents 1,689 vs 2,131; bundles 5 vs 8; amount due R280.7 m at 31 March vs R284.1 m at 31 May; invoices 307 vs 241; contradiction flags 33 vs 19; people 42 vs 122; entities 22 vs 12; risks 6 vs 14. The same ref can name a different document in the two exports (OD-603 is an SLA locally and a litigation document in production), so do not compare by ref on stage.

Production pages the local app does not have: Emails, Email silences, Organogram, Anchor Documents, WhatsApp, and the Legal / Court Filings split (all arrive with the newer export); KYC/FICA, Billing and fee notes, Audit log, Outlook integration, Email draft and templates, Privilege suggestions, sign-in, Team and the case-home rounds (all hosted-only).

Local features production does not have: the offline pack import with its validation report, candidate preview and explicit activation; Rescan & Update; Backup / Restore; editable enforcement statuses, authorities and cross-exam entries; direct court-bundle and index exports.

Same page, different shape: search and diff work on 500-character excerpts (production indexes 4,000); Chronology filters by text status rather than year and lists undated rows first; the document page shows metadata first and opens the original in its own viewer rather than inline; Interest is a single-capital calculator rather than per-invoice; Discovery has two schedules rather than three; the registers lack the timer, VAT and tag fields.

## Letting visitors click around (read-only tour)

`scripts/demo/tour-proxy.ts` is a password-protected, read-only front door for the running app, meant to sit behind a Cloudflare quick tunnel. Visitors can open every case view; the import page, the folder browser, the system views and every form submission are refused, and the app itself refuses foreign-origin form posts as a second fence. Originals do not open through the tour: their links point at the originals site on this machine.

```sh
TOUR_PASSWORD='choose-one' bun scripts/demo/tour-proxy.ts          # listens on 127.0.0.1:41190, forwards to 41101
~/bin/cloudflared tunnel --url http://127.0.0.1:41190 --protocol http2   # prints the https://….trycloudflare.com link
```

Share the link with the user name `tour` and the password. The name takes up to a minute to resolve. To end the tour, `Ctrl-C` the cloudflared process and the proxy; the link stops working at once. `--protocol http2` is needed where UDP is blocked.
