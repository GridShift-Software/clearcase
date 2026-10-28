#!/usr/bin/env bash
# GRS-250: loads the originals that scripts/originals/manifest.ts listed into a deployment's R2 bucket and D1 database.
#   scripts/originals/load.sh upload   rclone copy of the staged originals, rclone check, then the ETags
#   scripts/originals/load.sh d1       rewrites the SQL with those ETags and runs it, one wrangler call per batch
#   scripts/originals/load.sh all      upload, then d1
# Re-running transfers nothing that is already stored (the key is the content hash, so size decides) and the SQL is
# idempotent. Nothing here prints a credential: rclone reads its remote from its own config.
# Environment (defaults suit staging): OUT, PACKAGE, CASE_FOLDER, CASE_ID, CASE_LABEL, REMOTE, D1_DB, WRANGLER_CONFIG.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${OUT:-$ROOT/.local/originals-v5}"
PACKAGE="${PACKAGE:-$ROOT/.local/originals-v5-pkg}"
CASE_ID="${CASE_ID:-v5-demo}"
REMOTE="${REMOTE:-cc-staging:clearcase-staging-files}"
D1_DB="${D1_DB:-clearcase-staging-db}"
WRANGLER_CONFIG="${WRANGLER_CONFIG:-$ROOT/deploy/staging/wrangler.jsonc}"
: "${CASE_FOLDER:?set CASE_FOLDER to the case folder the package was converted against}"

manifest() {
  bun "$ROOT/scripts/originals/manifest.ts" --package "$PACKAGE" --case-folder "$CASE_FOLDER" --case-id "$CASE_ID" --out "$OUT" \
    ${CASE_LABEL:+--case-label "$CASE_LABEL"} "$@"
}

upload() {
  manifest
  local flags=(--files-from "$OUT/files-from.txt" --copy-links)
  rclone copy "$OUT/orig-stage" "$REMOTE/orig" "${flags[@]}" \
    --s3-chunk-size 64M --s3-upload-cutoff 200M --s3-no-check-bucket --transfers 16 --size-only --stats 30s --stats-one-line -v
  rclone check "$OUT/orig-stage" "$REMOTE/orig" "${flags[@]}" --one-way --size-only
  # rclone's listing has no composite ETag for multipart objects, so the ETags come from the S3 listing itself.
  bun "$ROOT/scripts/originals/etags.ts" --remote "${REMOTE%%:*}" --bucket "${REMOTE#*:}" --out "$OUT/remote-etags.json"
  echo "upload: copied and checked $(wc -l < "$OUT/files-from.txt") originals"
}

d1() {
  [[ -s "$OUT/remote-etags.json" ]] || { echo "d1: run '$0 upload' first (no $OUT/remote-etags.json)" >&2; exit 1; }
  manifest --etags "$OUT/remote-etags.json"
  local f n=0
  for f in "$OUT"/sql/*.sql; do
    bunx wrangler d1 execute "$D1_DB" --remote --config "$WRANGLER_CONFIG" --file "$f" >/dev/null
    n=$((n + 1))
  done
  echo "d1: $n batches applied to $D1_DB"
}

case "${1:-}" in
  upload) upload ;;
  d1) d1 ;;
  all) upload; d1 ;;
  *) echo "usage: $0 upload|d1|all" >&2; exit 2 ;;
esac
