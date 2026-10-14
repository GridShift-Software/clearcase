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
2. Preload the Sample Matter case. Choose **Import a case**. Step 1: type `Sample Matter` as the **Case name**. Step 2: choose **Add documents** and click the Sample Matter zip (or, if it was extracted, open the folder that holds `Sample_Matter_Workspace.html` and choose **Use this folder**). Step 3: leave the store folder as it is, or **Change** it to any folder outside the case. Step 4: choose **Open case**. Extracting, converting and validating takes about 30 seconds from the zip, or ten from a folder. On the report, tick the acknowledgement and choose **Activate this version**.
3. Open **Cases** and confirm one Active case. Keep the Matter A zip (`CASE_Lawyer_Pack_v5-002.zip`) in a folder the picker can reach, with plenty of free space beside it.
4. Restart the server once (`Ctrl-C`, then `start` again) and confirm the case is still there. This is what the demo machine will do after a reboot.

## The demo (about ten minutes)

1. **Cases.** The list shows Sample Matter as Active with its document count. Open it, walk the Overview tiles, Chronology, Documents, a document page and its original, Matter & Strategy, Contradiction Tracker, Risk Matrix.
2. **Import live.** Choose **Import a case**. Step 1: type `Example Matter` as the **Case name**. Step 2: choose **Add documents** and click the Matter A zip. Step 3: keep or change the store folder. Step 4: choose **Open case**. The progress line runs through extracting, finding the workspace HTML, converting, writing and validating; a large zip takes 10 to 30 seconds on an SSD.
3. **Validation report.** Point out the verdict, the warning counts and that nothing is active until the acknowledgement is ticked. Tick it and choose **Activate this version**.
4. **Example Matter.** Overview with Quantum tiles, Chronology, Documents, Invoice Ledger, Quantum & Interest, Enforcement Roadmap, Court Bundle. Open an original PDF.
5. **Switch back.** **Cases** at the top of any page lists both cases; Open either one.

## If something goes wrong

- An import refuses a destination: the message says why (not enough space, inside the case folder, inside the data directory). Choose another folder.
- A page shows a recovery banner: the stored results failed their check; import the same pack again.
- The server will not start: another ClearCase holds the data directory. Stop it with `bun run --bun start --stop` in that checkout, or use another `CLEARCASE_DATA_DIR`.

## Known gaps to say out loud

- Quantum, Invoice Ledger, Prescription, Interest, Payments and Settlement are empty for Sample Matter: its pack carries no quantum data.
- The Third-Party pack is a different product's export and is not importable yet.
- Emails, WhatsApp, organogram, KYC, billing, audit log and the Outlook integration are production-only or arrive with the newer export (see GRS-64).

## Importing a newer export

The newer export imports the same way as the v5 zip: **Import a case**, type the case name, **Add documents**, click the zip, **Open case**. Read the validation report, tick the acknowledgement and **Activate this version**. Check every view opens before the demo, and note which views stay empty because the export carries no rows for them.

## What differs from production (checked against the hosted app)

The older and newer exports differ in document, bundle, invoice, people and entity counts, and in the headline figures, so local numbers are not expected to match production exactly. The same ref can name a different document in the two exports, so do not compare by ref on stage.

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

For originals (the PDF viewer) to open for visitors, give the originals site a tunnel of its own and tell the app to write that origin into its links:

```sh
~/bin/cloudflared tunnel --url http://127.0.0.1:41102 --http-host-header clearcase-originals.localhost:41102 --protocol http2
ORIGINALS_PUBLIC_ORIGIN=https://<the second link> bun run --bun start      # restart the app with this set
```

The originals tunnel has no password: each link carries its own capability token, and the token is only shown to signed-in tour visitors. While the variable is set, your own browser also opens originals through the tunnel; start the app without it afterwards.
