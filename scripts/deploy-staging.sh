#!/usr/bin/env bash
# Deploy HEAD to the staging Worker clearcase-staging (GRS-245). Runbook: docs/sprint/runbooks/02-staging.md.
#
#   scripts/deploy-staging.sh                   build, bookmark D1, migrate, upload a version tagged with HEAD, deploy, smoke
#   scripts/deploy-staging.sh --rollback [id]   redeploy the newest earlier version with a different SHA tag (or <id>), smoke
#   scripts/deploy-staging.sh --secrets         put the four Clerk secrets on the Worker and the Preview base config
#
# Prints `sha url version` last. Needs a clean worktree, Bun, real Node (Wrangler runs under Node, never Bun) and either
# Wrangler's login or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID. Behind Cloudflare Access, the smoke needs a service
# token in CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET, else it stops at the Access redirect and says so.
# Each deploy appends {sha, version, bookmark} to .local/staging/deploys.jsonl (ignored), for a D1 Time Travel restore.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
CONFIG=deploy/staging/wrangler.jsonc
DB=clearcase-staging-db
BUCKET=clearcase-staging-files
URL=$(bun deploy/staging/origin.ts get)
LOG=.local/staging/deploys.jsonl

say() { printf 'deploy-staging: %s\n' "$*" >&2; }
die() { say "FAIL: $*"; exit 1; }
node_bin=$(command -v node) || die 'no node on PATH (Wrangler needs real Node)'
[[ $("$node_bin" -p 'process.versions.bun ?? ""') == '' ]] || die "$node_bin is Bun's node shim; put real Node first on PATH"
wrangler() { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false WRANGLER_SEND_METRICS=false "$node_bin" node_modules/wrangler/bin/wrangler.js "$@"; }
# Reads one JSON document on stdin and prints the value of a JS expression over it, bound as `j`.
json() { bun -e "const j = JSON.parse(await Bun.stdin.text()); const v = ($1); console.log(typeof v === 'string' ? v : JSON.stringify(v));"; }

# The Access service token never reaches argv or an xtrace line: tracing is off while the variables are read, and curl
# takes the headers from a 0600 file (`-H @file`), so `bash -x` or a process listing shows only the file name.
access_headers=()
{ xtrace=$(set +o | grep xtrace); set +x; } 2>/dev/null
if [[ -n ${CF_ACCESS_CLIENT_ID:-} && -n ${CF_ACCESS_CLIENT_SECRET:-} ]]; then
	access_file=$(umask 077 && mktemp)
	trap 'rm -f "$access_file"' EXIT
	printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET" >"$access_file"
	access_headers=(-H "@$access_file")
fi
eval "$xtrace"
# smoke <base> <sha>: /health 200 at that SHA, /sign-in 200, /cases 401, cf-placement remote-LHR.
smoke() {
	local base=$1 want=$2 hdr body code
	hdr=$(mktemp) body=$(mktemp)
	trap 'rm -f "$hdr" "$body"' RETURN
	for attempt in 1 2 3 4 5 6 7 8 9 10; do
		code=$(curl -sS -o "$body" -D "$hdr" -w '%{http_code}' "${access_headers[@]}" "$base/health" || echo 000)
		if [[ $code =~ ^30[0-9]$ ]] && grep -qi '^location: https://[^/]*cloudflareaccess.com' "$hdr"; then
			say "smoke: $base is behind Cloudflare Access (302 to the team login); set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET to smoke through it"
			return 2
		fi
		[[ $code == 200 && $(json 'j.build?.revision' <"$body") == "$want" ]] && break
		sleep 3
	done
	[[ $code == 200 ]] || die "smoke: GET /health is $code, not 200: $(head -c 400 "$body")"
	local got placement
	got=$(json 'j.build?.revision' <"$body")
	[[ $got == "$want" ]] || die "smoke: /health serves $got, not $want"
	placement=$(grep -i '^cf-placement:' "$hdr" | tr -d '\r' | cut -d' ' -f2-)
	[[ $placement == remote-LHR ]] || die "smoke: cf-placement is '${placement}', not remote-LHR"
	code=$(curl -sS -o /dev/null -w '%{http_code}' "${access_headers[@]}" "$base/sign-in")
	[[ $code == 200 ]] || die "smoke: GET /sign-in is $code, not 200"
	code=$(curl -sS -o /dev/null -w '%{http_code}' "${access_headers[@]}" "$base/cases")
	[[ $code == 401 ]] || die "smoke: GET /cases is $code, not 401"
	say "smoke: PASS /health 200 at $want, /sign-in 200, /cases 401, cf-placement remote-LHR"
}

case ${1:-} in
--secrets)
	bun deploy/staging/clerk.ts put-secrets
	exit 0
	;;
--rollback)
	started=$(date +%s)
	deployments=$(wrangler deployments list --json -c "$CONFIG")
	versions=$(wrangler versions list --json -c "$CONFIG")
	current=$(json 'j.at(-1).versions[0].version_id' <<<"$deployments")
	tag_of() { json "j.find(v => v.id === '$1')?.annotations?.['workers/tag'] ?? ''" <<<"$versions"; }
	current_sha=$(tag_of "$current")
	target=${2:-}
	if [[ -z $target ]]; then
		# Newest earlier deployment of a version this script tagged with another SHA. Untagged versions are secret changes.
		target=$(V=$versions json "[...j].reverse().map(d => d.versions[0].version_id).find(id => { const tag = JSON.parse(process.env.V).find(v => v.id === id)?.annotations?.['workers/tag'] ?? ''; return /^[0-9a-f]{40}\$/.test(tag) && tag !== '$current_sha'; }) ?? ''" <<<"$deployments")
	fi
	[[ -n $target ]] || die "no earlier version with a different SHA than $current_sha to roll back to"
	target_sha=$(tag_of "$target")
	say "rollback: $current ($current_sha) -> $target ($target_sha)"
	# The origin is a var of each version, so a rollback across an origin move serves the target's origin, not the config's.
	target_url=$(wrangler versions view "$target" --json -c "$CONFIG" | json "j.resources.bindings.find(b => b.name === 'CLEARCASE_APP_ORIGIN')?.text ?? ''")
	[[ -n $target_url ]] || die "version $target has no CLEARCASE_APP_ORIGIN"
	[[ $target_url == "$URL" ]] || say "rollback: $target serves $target_url, not the config's $URL"
	wrangler rollback "$target" -y -m "deploy-staging.sh --rollback from $current_sha" -c "$CONFIG" >&2
	smoke "$target_url" "$target_sha" || die "rolled back to $target but could not verify it (smoke exit $?; message above)"
	say "rollback: done in $(($(date +%s) - started)) s; a D1 restore is separate: see .local/staging/deploys.jsonl and the runbook"
	echo "$target_sha $target_url $target"
	exit 0
	;;
'') ;;
*) die "unknown argument $1 (use --rollback [version-id] or --secrets)" ;;
esac

started=$(date +%s)
[[ -z $(git status --porcelain --untracked-files=all) ]] || die 'the worktree is not clean; commit first (the build is stamped with HEAD)'
sha=$(git rev-parse HEAD)
say "building $sha"
bun run --bun build:hosted >&2

bookmark=$(wrangler d1 time-travel info "$DB" --json -c "$CONFIG" | json 'j.bookmark')
say "D1 bookmark before migrations: $bookmark"
CI=1 wrangler d1 migrations apply "$DB" --remote -c "$CONFIG" >&2

# First deploy only. /health needs the runtime sentinels: a D1 row naming the SHA-256 of an R2 object
# (src/lib/server/runtime/hosted/runtime.ts). Every case route needs the storage identity: the D1 row and the R2 object
# identity/client.json both naming CLEARCASE_CLIENT_ID (src/lib/storage/cloud/gate.ts).
state=$(wrangler d1 execute "$DB" --remote --json -c "$CONFIG" --command "SELECT (SELECT value FROM runtime_sentinel WHERE name = 'r2-sha256') AS sentinel, (SELECT client_id FROM rs_storage_identity WHERE singleton = 1) AS client")
case $(json 'j[0].results[0].client ?? ""' <<<"$state") in
staging) ;;
'')
	tmp=$(mktemp)
	printf '{"client_id":"staging"}' >"$tmp"
	wrangler r2 object put "$BUCKET/identity/client.json" --file "$tmp" --content-type application/json --jurisdiction eu --remote -c "$CONFIG" >&2
	wrangler d1 execute "$DB" --remote -c "$CONFIG" --command "INSERT INTO rs_storage_identity (singleton, client_id, layout) VALUES (1, 'staging', 'clearcase.rs/1')" >&2
	rm -f "$tmp"
	say 'storage identity provisioned'
	;;
*) die "the staging D1 names another client in rs_storage_identity: $(json 'j[0].results[0].client' <<<"$state")" ;;
esac
if [[ -z $(json 'j[0].results[0].sentinel ?? ""' <<<"$state") ]]; then
	tmp=$(mktemp)
	printf 'clearcase runtime sentinel staging %s\n' "$(date -u +%Y%m%dT%H%M%SZ)" >"$tmp"
	wrangler r2 object put "$BUCKET/runtime/sentinel" --file "$tmp" --jurisdiction eu --remote -c "$CONFIG" >&2
	wrangler d1 execute "$DB" --remote -c "$CONFIG" --command "INSERT OR REPLACE INTO runtime_sentinel (name, value) VALUES ('r2-sha256', '$(sha256sum "$tmp" | cut -d' ' -f1)')" >&2
	rm -f "$tmp"
	say 'runtime sentinels provisioned'
fi

message="deploy-staging.sh $(git log -1 --format=%s | head -c 80)"
if upload=$(wrangler versions upload -c "$CONFIG" --tag "$sha" --message "$message" 2>&1); then
	version=$(grep -oE 'Worker Version ID: [0-9a-f-]{36}' <<<"$upload" | cut -d' ' -f4)
	[[ -n $version ]] || { echo "$upload" >&2; die 'no Worker Version ID in the upload output'; }
	say "uploaded version $version"
	wrangler versions deploy "$version@100%" -y -c "$CONFIG" --message "deploy-staging.sh $sha" >&2
	# `versions deploy` leaves the workers.dev settings alone; this applies workers_dev and preview_urls from the config.
	wrangler triggers deploy -c "$CONFIG" >&2
elif grep -q 'Worker that does not yet exist' <<<"$upload"; then
	# Only the very first deploy: `versions upload` needs an existing Worker.
	say 'the Worker does not exist yet: creating it with wrangler deploy'
	upload=$(wrangler deploy -c "$CONFIG" --tag "$sha" --message "$message" 2>&1) || { echo "$upload" >&2; die 'wrangler deploy failed'; }
	version=$(grep -oE 'Current Version ID: [0-9a-f-]{36}' <<<"$upload" | cut -d' ' -f4)
	[[ -n $version ]] || { echo "$upload" >&2; die 'no Current Version ID in the deploy output'; }
else
	echo "$upload" >&2
	die 'versions upload failed'
fi

mkdir -p "$(dirname "$LOG")"
printf '{"at":"%s","sha":"%s","version":"%s","bookmark":"%s"}\n' "$(date -u +%FT%TZ)" "$sha" "$version" "$bookmark" >>"$LOG"
smoke "$URL" "$sha" || die "deployed $version but could not verify it (smoke exit $?; message above)"
say "done in $(($(date +%s) - started)) s"
echo "$sha $URL $version"
