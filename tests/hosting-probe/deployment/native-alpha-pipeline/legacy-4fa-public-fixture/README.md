# Legacy 4fa042bd public-build regression fixture

**This is a historical regression input. It is not current acceptance.** It is not proof for the current native module, a deploy, a stage, an upload or any provider. Do not cite a pass against it as such.

## What it is

The unchanged bytes of one complete build from commit `4fa042bd41e878a70aff08b085ad4b5b4cbccc4e` (NATIVE24, built 25 October 2026 07:04 UTC), kept so that `public-asset-provenance-reviewfix.test.ts` runs in a clean clone with no `NATIVE_PUBLIC_REAL_TREE` and no skips or mocks. The tests need a real adapter-cloudflare output, Kit's `output/client` and the Wrangler dry-run bundle, and one of them pins the real browser entry `app.Bmm0BDvz.js`, so a fresh build is not a drop-in replacement.

- `legacy-4fa-public-build.br`: one Brotli stream holding the files below, concatenated in `manifest.json` order. 63 files, 3,780,109 bytes unpacked, 576,335 packed.
- `manifest.json`: the closed inventory (path, size, SHA-256 per file), the archive's size and SHA-256, the source commit, and the golden hashes the tests compare against.
- `extract.ts`: the only reader. `MANIFEST_SHA256` in it pins `manifest.json`; the manifest pins the archive and every file.
- `build-archive.ts`: regenerates both files from a complete read-only build checkout. No test runs it.

Trees, relative to the extracted root: `.svelte-kit/cloudflare` (adapter output), `.svelte-kit/output/client` (Kit browser build input, with its `.vite/manifest.json`) and `.local/native-nodejs-compat-bundle/bundle` (`_worker.js`, `README.md` and `_worker.js.map`; the closed bundle inventory the assembler checks requires all three). Nothing else was taken: no caches, logs, `.wrangler` state, config, home or temporary directories, and no artifact tree. The files are synthetic-app build output and public package code. The source map's `sourceRoot` holds one absolute local build path, unchanged.

The worker is not deployable: the deployment checker refused this entry at the time (a dynamic `import()` not proven to be a runtime built-in). Nothing here is ever executed, staged or deployed.

## How the tests use it

- `NATIVE_PUBLIC_REAL_TREE` set: the tests read that read-only checkout, as review receipts do. Set but empty is an error.
- Unset: the tests call `extractLegacyPublicFixture()`. It checks the manifest pin, archive size and SHA-256, a decompression bound equal to the recorded size, every file's SHA-256 and a closed path set (three trees, plain segments, no `..`, no absolute path, no duplicate or case-colliding name). It writes only regular files with `wx` into a new `mkdtemp` directory under the OS temp directory, checks the result is exactly the inventory, and returns a `cleanup` that removes only that directory. A failed extraction removes its directory before throwing.

## Changing it

Rebuild from a complete read-only checkout with `bun build-archive.ts --source DIR --out EMPTYDIR`, copy the two files here, set `MANIFEST_SHA256` to the printed value, and review the diff. Replacing it with a current build means updating the pinned `app.Bmm0BDvz.js` assertions deliberately, in the same change.
