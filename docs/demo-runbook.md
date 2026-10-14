# Demo runbook (14 October 2026)

What the audience sees: a case already loaded, a second case imported live by clicking, and every view of both. Nothing here needs a network.

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
