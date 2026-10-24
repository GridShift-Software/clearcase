# Canonical DEV105 readers

These six literal input assets are byte- and mode-identical to `scripts/agent-tools/` at `105c4fa8ccf9e5850d082a502ef2705a85d70301`. They are historical comparison inputs, **not current judging policy**. Keeping them here lets the unchanged 70 real-CLI controls run in a shallow checkout without fetching history.

`manifest.json` records the source commit, original paths, Git blob IDs, SHA256 hashes and Git modes. `materialize.ts` pins the manifest's SHA256 and verifies every regular input file's bytes, Git blob and mode before writing any reader. It rejects missing/substituted inputs, symlinks, changed pins and nonempty output directories. It never fetches Git objects or falls back to the current reader. The synthetic repositories still resolve the tested checkout's installed dependencies as before.

Updating the baseline requires an explicit reviewed fixture change: preserve canonical source provenance and regenerate/review the byte/mode pins and manifest hash together. Do not edit the historical reader logic or use these files as admission authority for the current branch.
