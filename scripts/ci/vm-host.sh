#!/bin/bash
# Runs on pc1 as root, streamed over SSH by scripts/ci/pc1-vm (docs/ci-runner.md). It owns /var/lib/clearcase-ci, the
# clearcase-ci system user, clearcase-ci-vm.service, /etc/clearcase-ci-vm.nft and the nftables table inet
# clearcase_ci_vm that the service loads. Apart from installing packages at setup it touches nothing else on the host.
#   setup PUBKEY  create and start a fresh VM that lets PUBKEY in as ciadmin
#   unit          rewrite the service unit with pc1's current networks and restart the VM (disk and runner stay)
#   destroy       stop the VM and delete everything setup created (the packages stay)
set -euo pipefail
dir=/var/lib/clearcase-ci
unit=/etc/systemd/system/clearcase-ci-vm.service
image=noble-server-cloudimg-amd64.img
image_url=https://cloud-images.ubuntu.com/noble/current

nft_rules=/etc/clearcase-ci-vm.nft

# QEMU's user-mode network connects out from the QEMU process, so the unit keeps the guest off everything on the host
# but the internet: private ranges, the tailnet, pc1's own networks (read now, so refresh after they change) and
# loopback. IPAddressAllow= is per address, not per port, and guest root can send QEMU frames for any address, so the
# unit also loads an nftables table that drops everything QEMU's user sends to pc1 itself (anything routed through lo)
# except DNS to the resolver 127.0.0.53, where QEMU forwards the guest's DNS, and replies on connections that came in
# to the SSH forward 127.0.0.57:2257. Multicast and broadcast leave through the LAN interface, not lo, and wildcard
# listeners on pc1 (mDNS, LLMNR) receive them by multicast loopback, so the table drops that user's multicast and
# broadcast whatever the interface. The table matches only that user and is created and deleted with the service.
write_unit() {
  cat >"$nft_rules" <<'NFT'
#!/usr/sbin/nft -f
# Loaded and deleted by clearcase-ci-vm.service (GRS-57, docs/ci-runner.md).
table inet clearcase_ci_vm
delete table inet clearcase_ci_vm
table inet clearcase_ci_vm {
	chain output {
		type filter hook output priority filter; policy accept;
		meta skuid "clearcase-ci" ip daddr { 224.0.0.0/4, 255.255.255.255 } counter drop
		meta skuid "clearcase-ci" ip6 daddr ff00::/8 counter drop
		oifname "lo" meta skuid "clearcase-ci" jump qemu_to_host
	}
	chain qemu_to_host {
		ip daddr 127.0.0.53 meta l4proto { tcp, udp } th dport 53 accept
		ip saddr 127.0.0.57 tcp sport 2257 ct direction reply ct state established accept
		counter drop
	}
}
NFT
  chmod 0644 "$nft_rules"

  local deny="10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 127.0.0.0/8 ::1/128 fc00::/7 fe80::/10 fec0::/10 224.0.0.0/4 ff00::/8 255.255.255.255"
  deny+=" $(ip -o addr show scope global | awk '{print $4}' | python3 -c 'import ipaddress, sys
print(" ".join(sorted({str(ipaddress.ip_interface(a).network) for a in sys.stdin.read().split()})))')"
  cat >"$unit" <<UNIT
[Unit]
Description=ClearCase CI runner VM (GRS-57, docs/ci-runner.md)
Wants=network-online.target
After=network-online.target nftables.service

[Service]
User=clearcase-ci
Group=clearcase-ci
SupplementaryGroups=kvm
RuntimeDirectory=clearcase-ci
RuntimeDirectoryMode=0700
ExecStartPre=+/usr/bin/nft -f $nft_rules
ExecStart=/usr/bin/qemu-system-x86_64 -name clearcase-ci-vm -machine q35,accel=kvm -cpu host -smp 4 -m 8G \\
  -display none -serial file:$dir/console.log -qmp unix:/run/clearcase-ci/qmp.sock,server=on,wait=off \\
  -drive file=$dir/disk.qcow2,if=virtio,format=qcow2,cache=none,discard=unmap \\
  -drive file=$dir/seed.iso,if=virtio,format=raw,readonly=on \\
  -netdev user,id=net0,hostfwd=tcp:127.0.0.57:2257-:22 -device virtio-net-pci,netdev=net0 \\
  -device virtio-rng-pci
ExecStop=$dir/powerdown \$MAINPID
ExecStopPost=-+/usr/bin/nft delete table inet clearcase_ci_vm
TimeoutStopSec=120
Restart=always
RestartSec=10
MemoryMax=11G
IPAddressDeny=$deny
IPAddressAllow=127.0.0.57 127.0.0.53
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=$dir
DevicePolicy=closed
DeviceAllow=/dev/kvm rw
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictNamespaces=yes
RestrictSUIDSGID=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
UNIT
}

case ${1:-} in
setup)
  pubkey=${2:-}
  [[ $pubkey =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9._@-]+)?$ ]] || { echo "setup: expected an ssh-ed25519 public key" >&2; exit 2; }
  [[ ! -e $dir/disk.qcow2 ]] || { echo "setup: $dir/disk.qcow2 exists; run destroy first" >&2; exit 1; }
  # No -y: installing without a sync never partially upgrades the host.
  pacman -S --needed --noconfirm qemu-system-x86 qemu-img libisoburn nftables socat
  id clearcase-ci &>/dev/null || useradd --system --home-dir "$dir" --shell /usr/bin/nologin --groups kvm clearcase-ci
  install -d -o clearcase-ci -g clearcase-ci -m 0750 "$dir"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl -fsSLo "$work/SHA256SUMS" "$image_url/SHA256SUMS"
  curl -fsSLo "$work/$image" "$image_url/$image"
  (cd "$work" && grep " \*$image\$" SHA256SUMS | sha256sum -c -)
  install -o clearcase-ci -g clearcase-ci -m 0600 "$work/$image" "$dir/disk.qcow2"
  runuser -u clearcase-ci -- qemu-img resize -q "$dir/disk.qcow2" 40G

  mkdir "$work/seed"
  printf 'instance-id: clearcase-ci-%s\nlocal-hostname: clearcase-pc1-vm\n' "$(date -u +%Y%m%dT%H%M%SZ)" >"$work/seed/meta-data"
  cat >"$work/seed/user-data" <<USERDATA
#cloud-config
users:
  - name: ciadmin
    shell: /bin/bash
    sudo: "ALL=(ALL) NOPASSWD:ALL"
    lock_passwd: true
    ssh_authorized_keys: ["$pubkey"]
ssh_pwauth: false
disable_root: true
USERDATA
  xorriso -as mkisofs -quiet -V cidata -J -r -o "$work/seed.iso" "$work/seed"
  install -o clearcase-ci -g clearcase-ci -m 0600 "$work/seed.iso" "$dir/seed.iso"

  # systemd waits for ExecStop, then kills what is left, so this asks the guest to power off and waits for QEMU.
  install -o root -g root -m 0755 /dev/stdin "$dir/powerdown" <<'POWERDOWN'
#!/usr/bin/python3
import json, os, socket, sys, time
try:
    s = socket.socket(socket.AF_UNIX)
    s.connect("/run/clearcase-ci/qmp.sock")
    f = s.makefile("rw")
    f.readline()
    for command in ("qmp_capabilities", "system_powerdown"):
        f.write(json.dumps({"execute": command}) + "\n")
        f.flush()
        f.readline()
except OSError:
    pass
for _ in range(100):
    try:
        os.kill(int(sys.argv[1]), 0)
    except ProcessLookupError:
        break
    time.sleep(1)
POWERDOWN

  write_unit
  systemctl daemon-reload
  systemctl enable --now clearcase-ci-vm.service
  ;;
unit)
  [[ -f $dir/disk.qcow2 ]] || { echo "unit: no VM in $dir; run setup" >&2; exit 1; }
  write_unit
  systemctl daemon-reload
  systemctl restart clearcase-ci-vm.service
  ;;
destroy)
  systemctl disable --now clearcase-ci-vm.service 2>/dev/null || true
  rm -f "$unit" "$nft_rules"
  systemctl daemon-reload
  nft delete table inet clearcase_ci_vm 2>/dev/null || true
  systemctl reset-failed clearcase-ci-vm.service 2>/dev/null || true
  rm -rf /var/lib/clearcase-ci
  ! id clearcase-ci &>/dev/null || userdel clearcase-ci
  ;;
*)
  echo "usage: vm-host.sh setup PUBKEY | unit | destroy" >&2
  exit 2
  ;;
esac
