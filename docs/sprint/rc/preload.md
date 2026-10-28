# RC preload

Synthetic user work loaded on staging through the UI on 28 October 2026, so the notes, deadlines and bundle screens aren't empty at the gate and the demo. It was loaded at 4732083c with the editor user, and each item was checked after a reload. The text is synthetic; which documents the notes sit on is kept out of Git.

| Screen | Item | Saved in | Checked after reload |
|---|---|---|---|
| Document notes | "Demo note 1: follow up with the client on this letter." on one document | 1,310 ms | shown on the document and in the case notes list |
| Document notes | "Demo note 2: check this against the payment schedule." on a second document | 1,319 ms | shown on the document and in the case notes list |
| Deadlines | "Demo: file replying affidavit", due 14 days after the preload, note "Synthetic demo: prepare the filing checklist." | 1,410 ms | listed in the register; counted on the overview |
| Deadlines | "Demo: pre-trial conference", due 30 days after the preload, note "Synthetic demo: prepare the conference agenda." | 1,372 ms | listed in the register; counted on the overview |
| Bundles | "Demo bundle": two synthetic PDFs, built the way J9 builds its inputs | assembled in 257 ms, saved in 2,408 ms | listed; the assembled PDF (index plus two pages) downloads byte-identical before and after the reload |

The save times are from 4732083c, before the RC latency fixes; at d25a66ab the same saves take about 1.3 s.

The overview counts the two open deadlines. Journeys J7 to J10 create and delete their own entries, prefixed so they can't be confused with these; a run must leave these five items in place.

To reload the preload after a staging reset, add the same five items through the UI with the editor user.
