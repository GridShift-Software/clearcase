# Document detail and originals viewer

A document page shows one register row's fields, its date basis, attachments, related and child documents, an excerpt, and the user's notes. Its original is served only by the separate originals site: a PDF opens in a new tab in the isolated ClearCase viewer (a wrapper page plus a sandboxed pdf.js frame that never runs PDF scripts), images and text open inline there, and anything else is a download.

## Sub-features

- `doc-fields` shows the row's fields, filename and attachment-of link.
- `doc-original` shows the verified original's path, media type, size and digest, or an explicit missing, parent-route or unavailable state.
- `doc-viewer` opens a PDF in the originals-site viewer in a new tab without opener or referrer; `?page=N` opens at a page.
- `doc-download` downloads the verified original.
- `doc-notes` adds and deletes notes on the document; notes survive re-imports by the original's fingerprint.

## How to get to it (user POV)

- Choose a citation in the overview narrative, a ref in the chronology, or a related, child or attachment link on another document.
- Open `/v/<rv>/doc/<ref>` directly.
- On the document page, choose `Open` (`#open-original`) or `Download` (`#download-original`) in the Original section.

## Driving it with verify-clearcase

Preconditions:

- `citation` passed: the page is `/v/<rv>/doc/OD-001`, whose original is a one-page synthetic PDF.

- **Original state.** Step `viewer`. `section.original` has `data-original-state=present` and `data-presentation=viewer`. `#open-original` has `target=_blank`, a `rel` with `noopener` and `noreferrer`, and an `href` on `http://clearcase-originals.localhost:<originals port>/view/`.
- **Open the PDF.** Choose `#open-original`. Step `viewer`. A new tab opens on the originals origin with `window.opener === null`. The wrapper sets `body[data-ready=1]` (`error` fails the step). Inside the sandboxed frame (`/frame.html`), `window.__viewer` reports `numPages >= 1` and `rendered >= 1`, and the text layer reads `Synthetic agreement OD-001`.
- **Download.** *Not yet driven.* Choose `#download-original`. The download has the original's name and its sha256 matches the document's `#original-state` digest.
- **Notes.** *Not yet driven.* Type into `#note-body` and choose `#note-add`. `#notes li[data-note]` lists the note; reload and it persists.
- **Proof.** `screens/08-document-OD-001.png` and `screens/09-viewer-OD-001.png`, with the wrapper and frame values in `inner.json`.

## Gotchas

- The viewer opens in a new browsing context. Find it with `x.openTab('#open-original', origin + '/view/')` and read it through `x.tab(sid)`; the main tab's session cannot see it.
- The pdf.js frame is cross-origin (opaque, sandboxed). Read it with `x.frame(sid, /\/frame\.html/)`, never through the wrapper's DOM.
- Links carry an HMAC capability `k`; a link built by hand without it gets a constant 403, which is the app working.
- The originals site logs a 404 for `/favicon.ico`; that console entry is expected.
