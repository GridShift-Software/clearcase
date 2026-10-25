# Hosted PDF.js static asset preparation

Status: **PREPARED; runtime and deployment unverified.** This is a build-time helper, not evidence of browser rendering, CSP, identity, storage or provider success. Viewer behaviour and remaining integration belong to [native-viewer.md](../native-viewer.md).

## API and output

`scripts/hosted-pdf-assets.ts` exports:

```ts
prepareHostedPdfAssets({ root: string, publicRoot: string }): PdfAssetInventory
parsePdfAssetArgs(argv: string[]): { root: string; publicRoot: string } | null
```

`root` is the checkout containing the frozen dependency install and reviewed reader. `publicRoot` must already exist. The helper creates **only** its new `pdfjs/` child; an existing child (including a symlink) is refused without modification. Imports have no filesystem side effects. Inputs are all validated before output creation; a copy failure removes the helper's new child. Use a trusted, quiescent checkout, not concurrently mutable inputs/output directories. The helper is synchronous and starts no subprocess or network request.

Explicit CLI (exit 0 success, 1 input/copy refusal, 2 usage):

```sh
bun scripts/hosted-pdf-assets.ts --root "$CHECKOUT" --public-root "$GENERATED_STATIC_ROOT" > "$PRIVATE_INVENTORY"
```

The returned object / stdout JSON has schema `clearcase.hosted-pdf-assets/1`, `pdfjsVersion`, `packageDigest`, `readerDigest`, and `files: { path, bytes, sha256 }[]`. Paths are relative to `publicRoot` with `/` separators; SHA-256 values have the `sha256:` prefix. Entries are sorted by ordinal path. No timestamp, absolute input path, runtime data or public manifest is emitted.

The exact 191-file tree is:

- `/pdfjs/pdf.min.mjs` and `/pdfjs/pdf.worker.min.mjs` from installed `pdfjs-dist/build/`;
- `/pdfjs/LICENSE`, plus the exact flat `standard_fonts/`, `cmaps/`, `iccs/` resources and their licenses (190 installed package files total);
- `/pdfjs/pdf-reader.mjs` from `src/lib/viewer/hosted/static/pdf-reader.mjs`.

The reviewed reader imports `./pdf.min.mjs`, constructs the worker URL `./pdf.worker.min.mjs`, and loads those three resource directories relative to itself. It disables wasm, scripting, XFA and eval. No web viewer, sandbox, wasm, maps, server/private module or arbitrary package file is copied. Unexpected resource entries cause refusal. Selected inputs and every ancestor must be real files/directories, never symlinks. Selected files must be regular files.

## Trust binding

The declared exact devDependency and installed package name/version must be `pdfjs-dist@6.4.299`. An embedded digest binds **every selected package path, size and byte hash**, not merely the version string or a self-authored manifest. A separate embedded SHA-256 binds the reviewed reader. These constants were captured from the frozen install at `c6f0d9536e381dc8eebbf2035f49834409434761`. Missing, renamed, added or byte-mismatched selected inputs fail before copying. Package/reader upgrades require review of new inputs and constants; never derive trusted constants from the candidate input at runtime.

## Required parent hooks (not implemented here)

1. Invoke the helper before the hosted Vite/Kit build, targeting an isolated generated static input root that Kit copies through `.svelte-kit/output/client` and the adapter output. Preserve other existing static assets through the parent's configuration. Manage stale generated output explicitly outside this helper. Do not write into the tracked static tree, patch only the final adapter directory, or bypass Kit provenance.
2. Keep the exact emitted inventory privately with build evidence. Use its path+byte bindings when integrating the existing positive static provenance checks. It does **not** itself authorize public files or exempt them from final manifest/browser-graph, descriptor-read, or client-input byte checks. The parent must validate the combined build at its exact SHA.
3. In the parent-owned `scripts/ci/source-check.ts`, narrowly register the built import target `src/lib/viewer/hosted/static/pdf.min.mjs`, naming this helper as its producer. Preserve syntax/import checks for the reader and all other modules; do not add a directory-wide exemption or put PDF.js in the Worker import allowlist.
4. Wire the hosted viewer CSP (`worker-src`, same-origin script/resource loading), build invocation and cleanup in parent-owned files. Check browser rendering and real service composition separately. This unit changes none of those files.

## Emitted-artifact scope

`scripts/ci/hosted-artifact.ts` refuses every use of the `process` or `Bun` global in the emitted modules. `scripts/ci/hosted-artifact-scope.ts` resolves each name by scope with the TypeScript parser and binder. A module-scoped object, a parameter, a catch, import or hoisted binding named `process`, and the text of comments and strings are not uses. That covers the SDK JSDoc link `https://nodejs.org/api/process.html` that reaches `hooks.server.js` from `@cloudflare/puppeteer` `common/FileChooser.js`. An alias (`const p = process`), a destructure, a shorthand property, `process["env"]`, `globalThis.process.x`, `self.process.x` and `globalThis.Bun.x` are uses. The allowed probes are unchanged: `typeof process`, `process.versions…` and optional chaining. A module the parser cannot read is refused.

`pdfjs/pdf.min.mjs` and `pdfjs/pdf.worker.min.mjs` feature-detect Node (`process+""`, `process.type`), and `pdf.min.mjs` keeps six `process.getBuiltinModule` calls behind that branch. Their uses are accepted only when all of these hold:

- the path is exactly `.svelte-kit/cloudflare/pdfjs/<file>`;
- the size and SHA-256 equal that file's entry in the inventory whose digest is `HOSTED_PDF_PACKAGE_DIGEST` (the scoped tests rebuild the inventory from the frozen install and compare);
- Kit's `.svelte-kit/output/server/manifest.js` lists `pdfjs/<file>` in `assets`;
- the uses equal the reviewed list exactly.

The same bytes anywhere else, any changed byte (a newline, CRLF, one character), an extra import and grafted code all fail. The Worker entry or any server module importing a pinned file also fails. The import, test-double and hosted-gate checks run on every file, the pinned ones included. Gap carried over from the regex scanner: an optional-chained `globalThis.process?.getBuiltinModule?.(...)` is a probe and is not refused, because Kit emits that form and workerd defines no `process` without `nodejs_compat`.

## Lightweight verification

After frozen install and Kit sync, run only the private replacement-include suite and its scoped TypeScript check:

```sh
scripts/agent-tools/receipt --name pdf-static-tests -- bun run --bun test --config tests/hosted-smoke/pdf-static-assets/vitest.config.ts
scripts/agent-tools/receipt --name pdf-static-tsc -- bun run --bun tsc -p tests/hosted-smoke/pdf-static-assets/tsconfig.json
```

The suite uses one worker and disposable directories. It checks exact copied bytes/inventory, deterministic repetition, required reader references, excluded decoys, missing/tampered/renamed/extra inputs, version identity, input/output ancestor symlinks, output ownership and CLI argument strictness. It does not run a full build, browser, workerd, provider call or full suite.

The emitted-artifact scope has its own scoped suite (one worker, synthetic artifacts plus the real pinned bytes from the frozen install):

```sh
scripts/agent-tools/receipt --name artifact-scope-tests -- bun run --bun vitest run --config tests/hosted-foundation/artifact-scope/vitest.config.ts
scripts/agent-tools/receipt --name artifact-scope-tsc -- bun run --bun tsc -p tests/hosted-foundation/artifact-scope/tsconfig.json
```
