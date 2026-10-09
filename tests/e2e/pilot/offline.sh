#!/usr/bin/env bash
# Run a command with networking disabled, as the calling user:
#   unshare -rn env OUTER_UID="$(id -u)" OUTER_GID="$(id -g)" tests/e2e/pilot/offline.sh <cmd...>
# Inside the new network namespace (as its root) only lo is brought up; the script checks that no other interface
# exists and no route leaves the box. A network namespace does not cover filesystem sockets, so the host's resolver
# (systemd-resolved over /run/systemd/resolve, or D-Bus) would still resolve and query names for us: a private mount
# namespace hides those sockets, leaving /etc/resolv.conf's 127.0.0.53, which nothing answers in the namespace. Then
# the script remaps to the caller's uid/gid in a nested user namespace and execs the command. Any missing tool or
# isolation failure exits nonzero: there is no online fallback.
set -euo pipefail
die() { echo "offline.sh: $*" >&2; exit 2; }
if [[ "${CLEARCASE_OFFLINE_STAGE:-}" == mount ]]; then
	# private mount namespace, still namespace root: hide every local socket that resolves names over the host network
	mount --make-rprivate / 2>/dev/null || true
	for d in /run/systemd/resolve /run/systemd/machine /run/dbus /var/run/dbus /run/nscd /var/run/nscd; do
		if [[ -d "$d" && ! -L "$d" ]]; then mount -t tmpfs -o mode=0755,size=64k none "$d" || die "cannot hide $d"; fi
	done
	unset CLEARCASE_OFFLINE_STAGE
	export CLEARCASE_OFFLINE=1
	exec unshare -U --map-user="$OUTER_UID" --map-group="$OUTER_GID" "$0" "$@"
fi
if [[ -z "${CLEARCASE_OFFLINE:-}" ]]; then
	[[ "$(id -u)" == 0 && -n "${OUTER_UID:-}" && -n "${OUTER_GID:-}" ]] || die 'run me as: unshare -rn env OUTER_UID="$(id -u)" OUTER_GID="$(id -g)" tests/e2e/pilot/offline.sh <cmd...>'
	command -v ip >/dev/null || die 'ip (iproute2) is missing'
	command -v unshare >/dev/null || die 'unshare (util-linux) is missing'
	ip link set lo up
	links="$(ip -o link show | awk -F': ' '{print $2}' | cut -d@ -f1 | tr '\n' ' ')"
	[[ "$links" == "lo " ]] || die "unexpected interfaces in the namespace: $links"
	[[ -z "$(ip -4 route show table all | grep -v '^local \|^broadcast \|127\.' || true)" ]] || die 'an IPv4 route leaves loopback'
	[[ -z "$(ip -6 route show table all 2>/dev/null | grep -v '^local \|^multicast \|^::1\|^fe80\|^anycast' || true)" ]] || die 'an IPv6 route leaves loopback'
	export CLEARCASE_OFFLINE_NETNS="$(readlink /proc/self/ns/net)" CLEARCASE_OFFLINE_STAGE=mount
	exec unshare -m "$0" "$@"
fi
[[ "$(id -u)" == "${OUTER_UID:-x}" ]] || die "expected uid ${OUTER_UID:-?} after remapping, got $(id -u)"
[[ "$(readlink /proc/self/ns/net)" == "$CLEARCASE_OFFLINE_NETNS" ]] || die 'the command would run outside the isolated network namespace'
exec "$@"
