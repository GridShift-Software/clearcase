#!/usr/bin/env bash
# Switch the Clerk instance staging and its previews use (GRS-267). Runbook: docs/sprint/runbooks/09c-clerk-instance.md.
#
#   scripts/clerk-instance.sh --use <development|production> --dry-run   what would change: variable and secret names, no values
#   scripts/clerk-instance.sh --use <development|production>             apply it
#   scripts/clerk-instance.sh --active                                   which profile deploy/staging/wrangler.jsonc matches
#
# Apply, in order: refuse a profile with a PLACEHOLDER or an unsound value; rewrite the Clerk values of wrangler.jsonc from
# deploy/staging/clerk-instances/<mode>.json and commit that one file; put the four Clerk secrets (the JWT keys are
# refreshed from each instance) on the Worker and the Preview base config; allow-list the staging origin at both instances;
# deploy HEAD with scripts/deploy-staging.sh. Options: --skip-allow-list, --no-deploy. Needs what deploy-staging.sh needs and a
# clean worktree. The commit must reach the sprint branch (a PR), or the next staging deploy puts the other instance back.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
say() { printf 'clerk-instance: %s\n' "$*" >&2; }
die() { say "FAIL: $*"; exit 1; }
STAGING_ORIGIN=$(bun deploy/staging/origin.ts get)
# The attribution trailer of the commit this script makes; COMMIT_TRAILER overrides it.
COMMIT_TRAILER=${COMMIT_TRAILER:-'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'}

mode= dry=0 allow=1 deploy=1 active=0
while (($#)); do
	case $1 in
	--use) mode=${2:?--use needs development or production}; shift ;;
	--dry-run) dry=1 ;;
	--skip-allow-list) allow=0 ;;
	--no-deploy) deploy=0 ;;
	--active) active=1 ;;
	*) die "unknown argument $1" ;;
	esac
	shift
done
if ((active)); then
	bun deploy/staging/instance.ts active
	exit 0
fi
case $mode in
development | production) ;;
*) die 'usage: scripts/clerk-instance.sh --use <development|production> [--dry-run] [--skip-allow-list] [--no-deploy]' ;;
esac

bun deploy/staging/instance.ts plan "$mode" >&2 || die "the $mode profile cannot be applied"
if ((dry)); then
	say 'dry run: nothing was changed. Applying commits wrangler.jsonc, puts the secrets, allow-lists the staging origin (unless --skip-allow-list) and deploys staging (unless --no-deploy)'
	exit 0
fi

[[ -z $(git status --porcelain --untracked-files=all) ]] || die 'the worktree is not clean; commit first (the build is stamped with HEAD)'
bun deploy/staging/instance.ts write "$mode"
if [[ -n $(git status --porcelain deploy/staging/wrangler.jsonc) ]]; then
	git add deploy/staging/wrangler.jsonc
	git commit -q -m "staging: use the $mode Clerk instance (scripts/clerk-instance.sh)" -m "$COMMIT_TRAILER"
	say "committed the wrangler.jsonc change at $(git rev-parse --short HEAD): push it through a PR into the sprint branch"
fi
scripts/deploy-staging.sh --secrets
((allow)) && bun deploy/staging/clerk.ts allow "$STAGING_ORIGIN"
if ((deploy)); then
	scripts/deploy-staging.sh
else
	say 'secrets are set; the vars reach staging with the next deploy (scripts/deploy-staging.sh)'
fi
say "staging uses the $mode Clerk instance: run the sign-in check in docs/sprint/runbooks/09c-clerk-instance.md"
