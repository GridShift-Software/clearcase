# Original: open an original file

From a case, the user opens one of its original files. The assets double reads the object whole from local R2, checks its recorded size and SHA-256, writes the audit event to local D1 first, and only then answers 200 with the bytes as an attachment. The browser downloads it; there is no in-app viewer yet (GRS-120), so this skill claims no viewer render.

## Sub-features

- `original-link` on the case page: `a[data-action=open-original][data-asset-id]` with the case-scoped href `/cases/<caseId>/originals/<assetId>`.
- `original-download`: 200, `application/pdf`, `content-disposition: attachment`, `x-content-type-options: nosniff`, the whole file.
- `original-range`: a `Range` request answers 416 with no bytes until GRS-118.
- `original-audit`: a `succeeded` `asset.read-original` row in local D1; *covered by `test:hosted`'s `denials` leg*.

## How to get to it (user POV)

- Open a case, then click the file name under "Originals".

## Driving it with verify-clearcase-hosted

Preconditions:

- `case-open` passed: the page is `/cases/case-a1`.

- **Open.** Click `a[data-action=open-original][data-asset-id=a1-letter]`. Step `open-original`. Chromium begins and completes a download of `/cases/case-a1/originals/a1-letter`; the file's size and SHA-256 equal the fixture's (`tests/hosted-foundation/runtime/gate-fixture.ts`); a second in-page GET answers 200 with the same SHA-256 and the headers above; a `Range: bytes=0-63` GET answers 416 with no body; the page stays on the case.
- **Proof.** `downloads/a1-letter.pdf` and the screenshot `original-downloaded`.

## Gotchas

- The download lands in the run's Chromium profile under scratch; the step copies it into the evidence before cleanup removes scratch.
- The originals are synthetic one-page PDFs invented by the fixture; never point the fixture at case material.
