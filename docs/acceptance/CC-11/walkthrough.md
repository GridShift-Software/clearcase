# CC-11 walkthrough for the visual review

A 30–60 second walkthrough of the local release, for the user's visual review at the merge-ready revision. It follows the path that the acceptance suite automates (`tests/e2e/acceptance/suite.mjs`, AC1–AC7).

Use the real v5 sample for the review. Its screenshots stay on this computer, under `.local/GRS-21/`; this page cites them by path and sha256 only. The screenshot index below lists them.

## Script

Start with a fresh data folder and the app running (`bun run --bun start`; see the [user guide](../../user-guide.md)). Record the screen at 1280 px wide.

| Time | Do | Look for |
| --- | --- | --- |
| 0–8 s | Import the v5 case folder and package, then read the report. Accept the warnings, then activate. | The report lists its warnings before anything is shown. The overview opens with 1,689 documents and the freshness card. |
| 8–18 s | Open **Chronology**, filter by a bundle, open a document, then choose **Open**. | The original opens in the viewer in a new tab. The document page names the date basis. |
| 18–28 s | Open **Deadlines** and add a deadline. Open **Annotations** and add a note, then go Back. | Each row is saved and listed. Back returns to the page, and focus is on its heading. |
| 28–38 s | Open **Discovery Schedule**: tick a file, then mark it Copy. Open **Court Bundle** and type a court name in the header. | The marks and the header are kept when you leave the page and come back. |
| 38–48 s | Open **Backup / Restore** and choose **Export all state**. | One JSON file downloads. The page says that binaries are not included. |
| 48–60 s | Narrow the window to about 390 px. Open **Risk Matrix**, then **Court Bundle**. | No page scrolls sideways, and wide tables scroll in their own box. |

Then check the [differences register](../../reference/parity/README.md): every difference that the parity run shows is an entry with its reason. Product-visible entries keep `approvedBy: null` until you approve them in a PR.

## Screenshot index

All screenshots were taken at `4a6b9a581a47` by `scripts/verify/layout.mjs --shots`. Each is one viewport: 800 px high below 800 px wide, and 900 px high above that. The first table covers the real v5 sample; these screenshots are case material and stay on this computer. The second table covers the synthetic case. Both tables list 390 px and 1280 px only. Each run's `layout.json` lists every screenshot (`shots`), at all four widths, with its sha256.

**v5 sample** (168 screenshots; `.local/GRS-21/layout-v5/layout.json`):

| View | Width | File | sha256 |
| --- | --: | --- | --- |
| `overview` | 390 | `.local/GRS-21/layout-v5/shots/overview@390.png` | `8f3c5b78fe38a0566a05066d6a16495898309392da60d0fe3b73b99b76b35c89` |
| `overview` | 1280 | `.local/GRS-21/layout-v5/shots/overview@1280.png` | `5b19c9f33b12833feec1a7ed1a8bf004635da359e7e4da8a562157fa4a26721e` |
| `chronology` | 390 | `.local/GRS-21/layout-v5/shots/chronology@390.png` | `bc8d67783e94551b734364cdb6b6baca855b7690822f429b10cc84f8f047b9dc` |
| `chronology` | 1280 | `.local/GRS-21/layout-v5/shots/chronology@1280.png` | `b9f69f4685bd10fc6e3402b854b34e5c33e269a908ab7f3c9d60af31108e56ab` |
| `documents` | 390 | `.local/GRS-21/layout-v5/shots/documents@390.png` | `55822ddf14e909e295633dcbabf9fea3457e54d2e0bbfb1b312ef8b93057f9e7` |
| `documents` | 1280 | `.local/GRS-21/layout-v5/shots/documents@1280.png` | `8c39704c8f29ae129a617d822470351b27fc106b66abe94ce0c28b893d053660` |
| `search` | 390 | `.local/GRS-21/layout-v5/shots/search@390.png` | `12c54468a96eead9a5d328c4410c6ae777497a4e8831d1173b6eb460541ae942` |
| `search` | 1280 | `.local/GRS-21/layout-v5/shots/search@1280.png` | `48bbc904a16d55caadfcfa6e633702b6a7ac2e068d04e634e5cfbed4582c264d` |
| `quantum_tab` | 390 | `.local/GRS-21/layout-v5/shots/quantum_tab@390.png` | `18f15601d4802b21c41d3d30173973788d3f49d7a7499762e01b730b8d288141` |
| `quantum_tab` | 1280 | `.local/GRS-21/layout-v5/shots/quantum_tab@1280.png` | `8abad0360727435d42a34551ceb0553753c06ea3def78f81a3084db707dd1284` |
| `risk_matrix_tab` | 390 | `.local/GRS-21/layout-v5/shots/risk_matrix_tab@390.png` | `16816d2f1718acac2bffad12fbe568989a1a5ae91e51ae44c2f934a52db87214` |
| `risk_matrix_tab` | 1280 | `.local/GRS-21/layout-v5/shots/risk_matrix_tab@1280.png` | `0a54e73ccff600514cf49ef4cf12c0d9f0c11715ae255822d63388c1f190dcf4` |
| `discovery_tab` | 390 | `.local/GRS-21/layout-v5/shots/discovery_tab@390.png` | `a4317bbda89c0c634241724e859f46acd1524c4d6f9438edeeb4cafa39fe417a` |
| `discovery_tab` | 1280 | `.local/GRS-21/layout-v5/shots/discovery_tab@1280.png` | `81d7679203ec4eb7b855404a0abc863b814e8ea7d08a60676bafa45693ae8607` |
| `court_bundle_tab` | 390 | `.local/GRS-21/layout-v5/shots/court_bundle_tab@390.png` | `84b8e5f0a90c51a1cf05cdbc264cb4c9ca02341c6eb6fbca27a44e2b719854e2` |
| `court_bundle_tab` | 1280 | `.local/GRS-21/layout-v5/shots/court_bundle_tab@1280.png` | `9af4717d08537afdbb0e9360d07317d6a30029db139e81e9bd217d7723362bdf` |
| `deadlines_tab` | 390 | `.local/GRS-21/layout-v5/shots/deadlines_tab@390.png` | `cb6f0c5c67162e178ac5db56753ab97c4a8a69653261f4dd08adacdea30002d5` |
| `deadlines_tab` | 1280 | `.local/GRS-21/layout-v5/shots/deadlines_tab@1280.png` | `9ebd2a1b292f39d95193ac3a00b6cb7789df5817ee8fe2852c589fb055f395cc` |
| `backup_tab` | 390 | `.local/GRS-21/layout-v5/shots/backup_tab@390.png` | `d11dd3519d2ccb0149b1fc17503c6c03312995a72ab0803cafe531cd3a7d95f7` |
| `backup_tab` | 1280 | `.local/GRS-21/layout-v5/shots/backup_tab@1280.png` | `559a2f9c0b788788f01470805d44128c4a408e13a7bf27bf98f58ecbe9b3e5aa` |

**Synthetic case** (168 screenshots; `.local/GRS-21/layout-synthetic/layout.json`):

| View | Width | File | sha256 |
| --- | --: | --- | --- |
| `overview` | 390 | `.local/GRS-21/layout-synthetic/shots/overview@390.png` | `e28a2329c5e4b53ea48f5fe3916cfbfc6089a5a13199a8b3169eca1cb47612cf` |
| `overview` | 1280 | `.local/GRS-21/layout-synthetic/shots/overview@1280.png` | `159c7f13e4ad54d1117ee80a88d46d2972e0710a2f149c878da79a5e459778f6` |
| `chronology` | 390 | `.local/GRS-21/layout-synthetic/shots/chronology@390.png` | `6071e61117e9147de0b20a51827424315b3f4adddf5d31b21c42c47399494391` |
| `chronology` | 1280 | `.local/GRS-21/layout-synthetic/shots/chronology@1280.png` | `c0303cd892a4bcba7b69090e5c83e5e6611accad1721e369b0c13ad2e4df66e0` |
| `documents` | 390 | `.local/GRS-21/layout-synthetic/shots/documents@390.png` | `ac15a1de934296ad095228ae3f9da0934c5ce74546b03f0136cd75e9a8921e2c` |
| `documents` | 1280 | `.local/GRS-21/layout-synthetic/shots/documents@1280.png` | `d0c9b591ee7c6c16e1b184fdb23e8728c21b08553001c83fd6c9eee3f40b1b5f` |
| `search` | 390 | `.local/GRS-21/layout-synthetic/shots/search@390.png` | `60a37655940b3a219b72e0cfcff15f634472f9d69ced9a752757087239dc34d1` |
| `search` | 1280 | `.local/GRS-21/layout-synthetic/shots/search@1280.png` | `07cde6868d71e181452c958c73ac457ec779b797f2cd9f026baf23615b8ad80d` |
| `quantum_tab` | 390 | `.local/GRS-21/layout-synthetic/shots/quantum_tab@390.png` | `36a2b6b73144a5a51dc90985c2227436a72d8b6631e0e733613ff80b23965d22` |
| `quantum_tab` | 1280 | `.local/GRS-21/layout-synthetic/shots/quantum_tab@1280.png` | `c49bb785c73f8d6d6165a9a1db0a12542594da8b9b4444ae6971720a83e9af61` |
| `risk_matrix_tab` | 390 | `.local/GRS-21/layout-synthetic/shots/risk_matrix_tab@390.png` | `def1fd2d89c82b78449826c933bdce5d919c49a3d1fb38caf834188995db6fb3` |
| `risk_matrix_tab` | 1280 | `.local/GRS-21/layout-synthetic/shots/risk_matrix_tab@1280.png` | `fb7bb46af17338b5301be534c86c909cfd217249537d7cec80352603f518f514` |
| `discovery_tab` | 390 | `.local/GRS-21/layout-synthetic/shots/discovery_tab@390.png` | `4672065690146eb1d24724654170916adcc4f37abd2a14f59790244806849d0e` |
| `discovery_tab` | 1280 | `.local/GRS-21/layout-synthetic/shots/discovery_tab@1280.png` | `0bd4a58d9368f184bb31a13261d1a1f82a553017d0cbb28519a6dc7a8628a3bb` |
| `court_bundle_tab` | 390 | `.local/GRS-21/layout-synthetic/shots/court_bundle_tab@390.png` | `284c4b0945ae2e624c92f793ef9464d0265557d0c2ff92ee70c92fde4418cc4b` |
| `court_bundle_tab` | 1280 | `.local/GRS-21/layout-synthetic/shots/court_bundle_tab@1280.png` | `33be291996bece7e9ce60565a9d7c6f7d711f1b52899babd81c7a629c34922a6` |
| `deadlines_tab` | 390 | `.local/GRS-21/layout-synthetic/shots/deadlines_tab@390.png` | `a626837be9ff9fcb50ad8f5a2f3ec2d7068d73a8fe477b001ce04ae7d5e321ba` |
| `deadlines_tab` | 1280 | `.local/GRS-21/layout-synthetic/shots/deadlines_tab@1280.png` | `b686669ee256b6a6270c694edaa7df32731a0c6ea0ed06a7ec8229bdbd49bcbc` |
| `backup_tab` | 390 | `.local/GRS-21/layout-synthetic/shots/backup_tab@390.png` | `74a7d1c55afc4646a29ccd794c0cc4f4b9a2e229af3649920fe052f84df491d4` |
| `backup_tab` | 1280 | `.local/GRS-21/layout-synthetic/shots/backup_tab@1280.png` | `795b811779ecdc4a6f0a94628d88bbffea3891d6ed844f23e947abf3c85fa734` |

