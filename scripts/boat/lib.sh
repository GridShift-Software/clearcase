#!/bin/bash
# Shared helpers for build-golden.sh and run-checks.sh: the owner's signed-in `boat` CLI (no API key, no boat CI app).
# Sourced, not run. Exit codes of both scripts: 0 passed, 1 a check failed, 2 infrastructure (boat signed out, no
# snapshot, rate limited, no capacity), so an infrastructure problem is never read as a pass.

infra() { echo "boat: $*" >&2; exit 2; }

# The ids a `boat new --json` run printed (JSON Lines), one per line, in order, without duplicates.
sandbox_ids() {
  python3 -I -c '
import json, sys
seen = []
def walk(v):
    if isinstance(v, dict):
        if v.get("event") == "error": raise SystemExit("boat new failed: " + json.dumps(v))
        for k, x in v.items():
            if k in ("id", "sandboxId") and isinstance(x, str) and x not in seen: seen.append(x)
            else: walk(x)
    elif isinstance(v, list):
        for x in v: walk(x)
for line in sys.stdin:
    line = line.strip()
    if line.startswith("{"): walk(json.loads(line))
print("\n".join(seen))
'
}

# Refuses unless the CLI is signed in and the account may start a sandbox now. Never silently skips.
boat_preflight() {
  command -v boat >/dev/null || infra "the boat CLI is not installed (curl -fsSL https://boat.dev/install | sh)"
  command -v python3 >/dev/null || infra "python3 is required"
  local status limits
  status=$(boat status --no-update 2>&1) || infra "boat status failed: $status"
  python3 -I -c 'import json,sys; sys.exit(0 if json.load(sys.stdin)["account"].get("signedIn") else 1)' <<<"$status" \
    || infra "boat is signed out; run: boat login"
  limits=$(boat limits --json --no-update 2>&1) || infra "boat limits failed: $limits"
  python3 -I -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("canStart") else 1)' <<<"$limits" \
    || infra "boat will not start a sandbox now (boat limits --json: canStart is false)"
}

# Succeeds when a saved snapshot of that name exists.
boat_has_snapshot() {
  boat snapshots --json --no-update | python3 -I -c '
import json, sys
name = sys.argv[1]
doc = json.load(sys.stdin)
sys.exit(0 if any(name in map(str, e.values()) for e in doc.get("named", []) if isinstance(e, dict)) else 1)
' "$1"
}

# A fresh sandbox answers `true` once it is ready; it may answer 409 sandbox_starting for up to a minute.
boat_wait_ready() {
  local id=$1 n
  for n in $(seq 1 24); do
    boat exec "$id" --timeout 30 --no-update -- true >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}
