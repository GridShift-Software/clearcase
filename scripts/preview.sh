#!/usr/bin/env bash
# A per-branch Preview of the staging Worker, bound to staging's D1, R2 and KV (GRS-245). Runbook: docs/sprint/runbooks/02-staging.md.
#
#   scripts/preview.sh [--name <name>]            build HEAD, allow-list the preview origin at both Clerk apps, upload it, print its URL
#   scripts/preview.sh --delete [--name <name>]   delete the Preview and its Clerk allow-list entries
#
# The name defaults to the current branch without `sprint/`, lower-cased, every other character turned into `-`, cut to
# 45 characters so `<name>-clearcase-staging` fits one DNS label. Previews share staging's database: schema changes are
# additive and reach staging first. Needs what scripts/deploy-staging.sh needs, plus the Clerk keys (deploy/staging/clerk.ts).
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
CONFIG=deploy/staging/wrangler.jsonc
HOST_SUFFIX=clearcase-staging.shiny-sunset-211d.workers.dev

say() { printf 'preview: %s\n' "$*" >&2; }
die() { say "FAIL: $*"; exit 1; }
node_bin=$(command -v node) || die 'no node on PATH (Wrangler needs real Node)'
[[ $("$node_bin" -p 'process.versions.bun ?? ""') == '' ]] || die "$node_bin is Bun's node shim; put real Node first on PATH"
wrangler() { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false "$node_bin" node_modules/wrangler/bin/wrangler.js "$@"; }

delete=0 name=
while (($#)); do
	case $1 in
	--delete) delete=1 ;;
	--name) name=${2:?--name needs a value}; shift ;;
	*) die "unknown argument $1" ;;
	esac
	shift
done
if [[ -z $name ]]; then
	branch=$(git branch --show-current)
	[[ -n $branch ]] || die 'detached HEAD: pass --name'
	name=${branch#sprint/}
fi
name=$(tr 'A-Z' 'a-z' <<<"$name" | sed -E 's/[^a-z0-9]+/-/g; s/^-+//' | cut -c1-45 | sed -E 's/-+$//')
[[ -n $name ]] || die 'the preview name is empty after sanitising'
origin="https://$name-$HOST_SUFFIX"

if ((delete)); then
	wrangler preview delete --name "$name" -c "$CONFIG" >&2
	bun deploy/staging/clerk.ts remove "$origin" >&2
	say "deleted $name"
	exit 0
fi

started=$(date +%s)
[[ -z $(git status --porcelain --untracked-files=all) ]] || die 'the worktree is not clean; commit first (the build is stamped with HEAD)'
sha=$(git rev-parse HEAD)
say "building $sha for $origin"
bun run --bun build:hosted >&2
bun deploy/staging/clerk.ts allow "$origin" >&2

# The runtime accepts a CLEARCASE_NATIVE_CONFIG only when its hostname is CLEARCASE_APP_ORIGIN's: re-aim staging's at this preview.
native=$(ORIGIN=$origin bun -e "
const text = (await Bun.file('$CONFIG').text()).replace(/^\s*\/\/.*$/gm, '');
const config = JSON.parse(JSON.parse(text).vars.CLEARCASE_NATIVE_CONFIG);
const host = new URL(process.env.ORIGIN).hostname;
config.deployment.hostname = host;
for (const c of config.manifest.clients) c.hostname = host;
console.log(JSON.stringify(config));")

out=$(wrangler preview -c "$CONFIG" --name "$name" --tag "$sha" --message "preview.sh $sha" --json \
	--var "CLEARCASE_APP_ORIGIN:$origin" --var "CLEARCASE_NATIVE_CONFIG:$native" 2>&1) || { echo "$out" >&2; die 'wrangler preview failed'; }
url=$(grep -oE "https://[a-z0-9-]+-$HOST_SUFFIX" <<<"$out" | head -1)
[[ -n $url ]] || { echo "$out" >&2; die 'no preview URL in the Wrangler output'; }
[[ $url == "$origin" ]] || die "Wrangler gave $url, not $origin: CLEARCASE_APP_ORIGIN and the Clerk allow-list would not match"

code=$(curl -sS -o /dev/null -w '%{http_code}' "$url/health" || echo 000)
case $code in
200) say "GET /health 200" ;;
302) say 'GET /health 302: behind Cloudflare Access, open the URL in a browser to pass the PIN' ;;
*) say "WARN: GET /health is $code (a fresh preview can take a few seconds)" ;;
esac
say "done in $(($(date +%s) - started)) s"
echo "$url"
