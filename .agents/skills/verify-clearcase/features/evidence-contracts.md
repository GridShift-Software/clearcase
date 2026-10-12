# Contracts (evidence)

Contracts shows the imported contract groups (header, item count, table of ref, date, title and note, a Signed marker read from the title and note as words, text status and a link to the document), the contract count and, when the package carries them, the case wording v5 hard-coded (two key figures and a closing note) from the `view-content` dataset. A disclosure says the groups and the Signed marker are unverified.

## Sub-features

- `contracts-groups` lists each contract group with its items and the Signed marker (`—` when the wording is negated or uncertain).
- `contracts-doc` opens a contract's document page with its original.
- `contracts-export` downloads the export, named by the package's view-content (else `contracts.csv` with a note beside the button).

## How to get to it (user POV)

- Choose `Contracts` (`#nav-contracts_tab`), or open `/v/<rv>/evidence/contracts_tab`.

## Driving it with verify-clearcase

- **Open.** Choose `#nav-contracts_tab`. `main[data-ready=contracts_tab]`, title `Contracts · <case> · ClearCase`, heading focused, `#classification-status[data-verification=unverified]`.
- **Citation.** Choose the `a.doc` link of `tr[data-ref=<ref>]`. The document page `main[data-ready="doc:<ref>"]` shows `section.original` with its Open link.
- **Export.** Choose `#export-contracts`: the download (`contracts.csv` when the package names none) has `group,ref,date,title,note,text_status,url`.

## Gotchas

- Without a `view-content` dataset the two narrative figures and the closing note are absent; the count figure always shows.
