#!/usr/bin/env bash
# =============================================================================
# AuxiNux Virtua Control — Installation Script
# Target: Debian 13 (Trixie) ultra minimal, x86_64 architecture
# Port  : 8441
# =============================================================================
set -euo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

# ── Live provisioning progress ────────────────────────────────────────────────
# Each step() writes a machine-readable snapshot to PROGRESS_FILE so an external
# viewer (the Rust `virtuaos setup` TUI) can draw a live progress bar. This is
# best-effort: a failure to write must NEVER abort the install.
PROGRESS_FILE="${AUXINUX_PROGRESS_FILE:-/run/auxinux-virtua-setup.progress}"
PROGRESS_STEP=0
PROGRESS_TOTAL="${AUXINUX_PROGRESS_TOTAL:-24}"
PROGRESS_START_TS="$(date +%s 2>/dev/null || echo 0)"

write_progress() {
    # $1 = status (running|done|failed)   $2 = current step label
    local status="$1" label="${2:-}" pct=0
    if [[ "${PROGRESS_TOTAL}" -gt 0 ]]; then
        pct=$(( PROGRESS_STEP * 100 / PROGRESS_TOTAL ))
        (( pct > 100 )) && pct=100
    fi
    {
        echo "step=${PROGRESS_STEP}"
        echo "total=${PROGRESS_TOTAL}"
        echo "pct=${pct}"
        echo "status=${status}"
        echo "mode=${MODE:-}"
        echo "started=${PROGRESS_START_TS}"
        echo "ts=$(date +%s 2>/dev/null || echo 0)"
        echo "label=${label}"
    } > "${PROGRESS_FILE}.tmp" 2>/dev/null \
        && mv -f "${PROGRESS_FILE}.tmp" "${PROGRESS_FILE}" 2>/dev/null || true
}

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; write_progress failed "$*"; exit 1; }
step()    {
    PROGRESS_STEP=$(( PROGRESS_STEP + 1 ))
    echo -e "\n${BOLD}${BLUE}══ [${PROGRESS_STEP}/${PROGRESS_TOTAL}] $*${NC}"
    write_progress running "$*"
}

AUXINUX_PORT=8441
AUXINUX_DATA_DIR="/var/lib/auxinuxvirtual"
AUXINUX_RUNNER_SOCK="/run/auxinuxvirtual.sock"
NODE_MAJOR=22
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="auxinuxvirtual"
DOCKER_KEYRING="/etc/apt/keyrings/docker.gpg"
NODESOURCE_LIST="/etc/apt/sources.list.d/nodesource.list"
DOCKER_LIST="/etc/apt/sources.list.d/docker.list"
PROJECT_VERSION="unknown"
REQUIRED_RELEASE_FILES=(
    "apps/ui/src/pages/NodeOverviewPage.tsx"
    "apps/ui/src/pages/CreateWizardPage.tsx"
    "apps/ui/src/components/Layout/TopBar.tsx"
    "apps/ui/src/components/Layout/Sidebar.tsx"
    "apps/api/src/server.ts"
    "apps/api/src/db.ts"
    "apps/cli/src/cli.ts"
    "apps/vdm/src/server.ts"
    "apps/vdm-ui/src/App.tsx"
    "INSTALL/vdm-install.sh"
    "INSTALL/vdm-ha-agent"
    "lang/FR.json"
    "lang/EN.json"
)

export DEBIAN_FRONTEND=noninteractive
# DPkg::Lock::Timeout lets apt WAIT for the dpkg lock instead of failing — this
# matters when install.sh is invoked right after an apt transaction (e.g. by the
# auxinux-virtua .deb setup service), where the lock may still be briefly held.
APT_GET=(apt-get -y -qq -o Dpkg::Use-Pty=0 -o DPkg::Lock::Timeout=600)
APT_LOCK_OPT=(-o DPkg::Lock::Timeout=600)
MODE=""

show_help() {
    cat <<'EOF'
AuxiNux Virtua Control installer

Usage:
  ./install.sh            Install or refresh the panel without deleting data
  ./install.sh -update    Force an application update while preserving data/config
  ./install.sh -repair    Reinstall panel runtime/build artifacts while preserving data/config
  ./install.sh -reset     Reset portal data and reinstall the panel from a clean state
  ./install.sh -clean     Full wipe (no prompt): erase every AuxiNux trace then fresh install
  ./install.sh -h         Show this help

Mode behavior:
  install  Default mode. Ensures dependencies are present, rebuilds the panel, preserves data.
  update   Safe update mode for the panel, preserving data and configuration.
  repair   Removes panel runtime artifacts (node_modules/dist/socket) before reinstalling.
  reset    Removes AuxiNux portal data/config/runtime artifacts, then reinstalls the panel.
  clean    Like reset but goes further: removes node_modules, dist/, build artifacts,
           systemd units, .bak backup files, and iptables rules — then reinstalls fresh.

Automatic recovery:
  On startup, install.sh detects residue from a previously aborted run (systemd
  units present without the completion marker) and runs a safe clean-up before
  proceeding. This avoids the "invalid ELF header" / stale-config issues that
  occur when a half-built install is rerun.

Notes:
  - reset/clean do NOT remove the Debian OS itself.
  - reset/clean do NOT delete existing QEMU VM disks, LXC containers, or Docker containers.
  - reset/clean DO remove AuxiNux portal data under /var/lib/auxinuxvirtual and panel runtime files.
EOF
}

set_mode() {
    local new_mode="$1"
    if [[ -n "$MODE" && "$MODE" != "$new_mode" ]]; then
        error "Only one mode can be used at a time"
    fi
    MODE="$new_mode"
}

parse_args() {
    local arg
    for arg in "$@"; do
        case "$arg" in
            -h|--help|help)
                show_help
                exit 0
                ;;
            -update|--update)
                set_mode "update"
                ;;
            -repair|--repair)
                set_mode "repair"
                ;;
            -reset|--reset)
                set_mode "reset"
                ;;
            -clean|--clean|-fresh|--fresh)
                set_mode "clean"
                ;;
            "")
                ;;
            *)
                error "Unknown argument: $arg. Use -h for help."
                ;;
        esac
    done

    MODE="${MODE:-install}"
}

# ── Install completion marker ────────────────────────────────────────────────
# Written at the very end of a successful run. Its absence (combined with the
# presence of half-installed systemd units) is how we know a previous install
# was aborted mid-way.
INSTALL_COMPLETION_MARKER="${AUXINUX_DATA_DIR}/.install-completed"

cleanup_tmp() {
    rm -f /tmp/auxinux-install.err /tmp/auxinux-install.out 2>/dev/null || true
}
trap cleanup_tmp EXIT

detect_project_version() {
    local version_file="$INSTALL_DIR/.auxinux-release-version"
    if [[ -f "$version_file" ]]; then
        PROJECT_VERSION="$(head -n1 "$version_file" | tr -d '[:space:]')"
    elif [[ -f "$INSTALL_DIR/package.json" ]]; then
        PROJECT_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$INSTALL_DIR/package.json" | head -n1)"
    fi
    PROJECT_VERSION="${PROJECT_VERSION:-unknown}"
}

validate_release_sources() {
    step "Validate extracted release contents"
    local file missing=0

    for file in "${REQUIRED_RELEASE_FILES[@]}"; do
        if [[ ! -f "$INSTALL_DIR/$file" ]]; then
            warn "Missing expected file in extracted project: $file"
            missing=1
        fi
    done

    if [[ "$missing" -ne 0 ]]; then
        error "Extracted project is incomplete. Recreate the archive with INSTALL/release.sh, reupload it, and rerun install.sh."
    fi

    info "Detected Virtua version: ${PROJECT_VERSION}"
    success "Release content validation passed"
}

backup_file_if_exists() {
    local file="$1"
    if [[ -f "$file" ]]; then
        cp -a "$file" "${file}.bak"
        info "Backup created: $file -> ${file}.bak"
    fi
}

get_primary_uplink_interface() {
    ip route show default 2>/dev/null | awk '/default/ {for (i=1; i<=NF; i++) if ($i == "dev") { print $(i+1); exit }}'
}

# Detect which subsystem actually manages the host's networking. Writing an
# ifupdown bridge config on a systemd-networkd/cloud-init host makes BOTH stacks
# fight over the NIC on reboot → wrong/unreachable IP. We MUST know this before
# touching anything. Echoes one of: ifupdown | systemd-networkd | netplan |
# networkmanager | cloud-init | unknown
detect_network_manager() {
    # cloud-init owning the network is the most dangerous (it rewrites config on boot)
    if [[ -d /etc/cloud ]] && ! grep -rqs "network:\s*{*\s*config:\s*disabled" /etc/cloud/cloud.cfg /etc/cloud/cloud.cfg.d 2>/dev/null; then
        if [[ -f /etc/cloud/cloud.cfg ]] && command -v cloud-init >/dev/null 2>&1; then
            echo "cloud-init"; return 0
        fi
    fi
    if systemctl is-enabled systemd-networkd.service >/dev/null 2>&1 || systemctl is-active systemd-networkd.service >/dev/null 2>&1; then
        # Only count it if it actually has config managing interfaces.
        if ls /etc/systemd/network/*.network /run/systemd/network/*.network >/dev/null 2>&1; then
            echo "systemd-networkd"; return 0
        fi
    fi
    if [[ -d /etc/netplan ]] && ls /etc/netplan/*.y*ml >/dev/null 2>&1; then
        echo "netplan"; return 0
    fi
    if systemctl is-active NetworkManager.service >/dev/null 2>&1; then
        echo "networkmanager"; return 0
    fi
    # ifupdown: real stanzas in /etc/network/interfaces(.d)
    if grep -rqsE '^\s*(auto|iface|allow-hotplug)\s' /etc/network/interfaces /etc/network/interfaces.d 2>/dev/null; then
        echo "ifupdown"; return 0
    fi
    echo "unknown"
}

# True when the interface's primary IPv4 came from DHCP (kernel marks it
# "dynamic"). Freezing such an address as a static bridge IP is what made the
# public IP go stale after a reboot.
primary_ip_is_dhcp() {
    local iface="$1"
    ip -4 -o addr show dev "$iface" scope global 2>/dev/null | grep -q ' dynamic'
}

get_interface_ipv4_cidr() {
    local iface="$1"
    ip -4 -o addr show dev "$iface" scope global 2>/dev/null | awk '{print $4; exit}'
}

get_interface_gateway() {
    local iface="$1"
    ip route show default dev "$iface" 2>/dev/null | awk '/default/ {for (i=1; i<=NF; i++) if ($i == "via") { print $(i+1); exit }}'
}

get_interface_mac() {
    local iface="$1"
    cat "/sys/class/net/${iface}/address" 2>/dev/null
}

write_vmbr0_bridge_config() {
    local uplink="$1"
    local host_ip_cidr="$2"
    local gateway="$3"
    local ip_mode="${4:-static}"   # static | dhcp
    local uplink_mac cfg
    uplink_mac="$(get_interface_mac "$uplink")"
    cfg=/etc/network/interfaces.d/auxinuxvirtual-bridge-vmbr0.cfg

    mkdir -p /etc/network/interfaces.d
    backup_file_if_exists "$cfg"
    backup_file_if_exists /etc/network/interfaces.d/auxinuxvirtual-uplink-"${uplink}".cfg

    cat > /etc/network/interfaces.d/auxinuxvirtual-uplink-"${uplink}".cfg <<EOF
# Managed by AuxiNux Virtua
allow-hotplug ${uplink}
iface ${uplink} inet manual
EOF

    # hwaddress pins the bridge MAC to the physical NIC's MAC. Without this the
    # bridge gets a random MAC on reboot and cloud switch port security blackholes
    # the host (the classic "server offline after reboot" footgun).
    if [[ "$ip_mode" == "dhcp" ]]; then
        # DHCP bridge: NEVER freeze the lease as static — the upstream DHCP
        # reservation (tied to the pinned MAC) keeps delivering the same IP.
        cat > "$cfg" <<EOF
# Managed by AuxiNux Virtua
# AUXINUX_HOST_IP_MODE=dhcp
auto vmbr0
iface vmbr0 inet dhcp
    bridge_ports ${uplink}
    bridge_stp off
    bridge_fd 0
EOF
    else
        cat > "$cfg" <<EOF
# Managed by AuxiNux Virtua
# AUXINUX_HOST_IP_MODE=copy
auto vmbr0
iface vmbr0 inet static
    address ${host_ip_cidr}
    gateway ${gateway}
    bridge_ports ${uplink}
    bridge_stp off
    bridge_fd 0
EOF
    fi
    if [[ -n "$uplink_mac" ]]; then
        echo "    hwaddress ether ${uplink_mac}" >> "$cfg"
    fi
}

disable_prepared_vmbr0_bridge_config() {
    local stamp file
    stamp="$(date +%Y%m%d%H%M%S)"
    for file in /etc/network/interfaces.d/auxinuxvirtual-bridge-vmbr0.cfg /etc/network/interfaces.d/auxinuxvirtual-uplink-*.cfg; do
        [[ -f "$file" ]] || continue
        if grep -q "Managed by AuxiNux Virtua" "$file" 2>/dev/null; then
            mv "$file" "${file}.disabled-${stamp}" || warn "Unable to disable stale network config: $file"
            warn "Disabled stale Virtua network config that could break remote access after reboot: $file"
        fi
    done
}

# Primary IPv4/CIDR = the address the kernel uses to reach the gateway. On OVH
# this is the main /24; failover /32s are NOT primary and are left for guests.
get_primary_ipv4_cidr() {
    local iface="$1" gateway="$2" primary_ip
    primary_ip="$(ip -4 route get "$gateway" 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -1)"
    [[ -z "$primary_ip" ]] && return 1
    ip -4 -o addr show dev "$iface" scope global 2>/dev/null \
        | awk -v ip="$primary_ip" '$4 ~ "^"ip"/" {print $4; exit}'
}

# Connectivity probe tuned for OVH/cloud: ARP (L2, works even when ICMP is
# filtered) → ping gateway → ping public anycast. Any success = reachable.
bridge_host_reachable() {
    local gateway="$1" dev="$2" i
    sleep 2
    for i in 1 2 3 4; do
        if [[ -n "$gateway" ]] && command -v arping >/dev/null 2>&1 \
            && arping -f -c 2 -w 3 -I "$dev" "$gateway" >/dev/null 2>&1; then return 0; fi
        if [[ -n "$gateway" ]] && ping -c 1 -W 2 "$gateway" >/dev/null 2>&1; then return 0; fi
        if ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1; then return 0; fi
        if ping -c 1 -W 2 9.9.9.9 >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    return 1
}

BRIDGE_OK_SENTINEL="/run/auxinux-bridge-ok"
BRIDGE_WATCHDOG_SCRIPT="/run/auxinux-bridge-watchdog.sh"

# Arm a DETACHED watchdog that restores the uplink networking unless the
# sentinel file appears within the timeout. This is the anti-lockout insurance
# for remote/SSH installs: even if SSH drops mid-migration and kills install.sh,
# the watchdog (running under setsid, immune to SIGHUP) puts the network back.
arm_bridge_watchdog() {
    local uplink="$1" gateway="$2"; shift 2
    local cidr
    {
        echo '#!/bin/bash'
        echo "for i in \$(seq 1 120); do [[ -f '$BRIDGE_OK_SENTINEL' ]] && exit 0; sleep 1; done"
        echo "logger -t auxinux-bridge-watchdog 'timeout reached — restoring ${uplink} networking' 2>/dev/null || true"
        echo "ip link set dev '$uplink' nomaster 2>/dev/null || true"
        echo "ip link delete vmbr0 type bridge 2>/dev/null || true"
        echo "ip link set dev '$uplink' up 2>/dev/null || true"
        for cidr in "$@"; do echo "ip addr add '$cidr' dev '$uplink' 2>/dev/null || true"; done
        [[ -n "$gateway" ]] && echo "ip route replace default via '$gateway' dev '$uplink' 2>/dev/null || true"
        [[ $# -gt 0 ]] && echo "command -v arping >/dev/null 2>&1 && arping -U -c 3 -w 2 -I '$uplink' '${1%%/*}' 2>/dev/null || true"
    } > "$BRIDGE_WATCHDOG_SCRIPT"
    chmod +x "$BRIDGE_WATCHDOG_SCRIPT"
    rm -f "$BRIDGE_OK_SENTINEL"
    setsid bash "$BRIDGE_WATCHDOG_SCRIPT" </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
    info "Anti-lockout watchdog armed (auto-restores network in 120s if not confirmed)"
}

# Cancel the watchdog (call once we KNOW the host is still reachable, or right
# after a manual rollback, so the watchdog doesn't fire a second time).
disarm_bridge_watchdog() {
    touch "$BRIDGE_OK_SENTINEL" 2>/dev/null || true
}

# Undo a failed vmbr0 migration: detach, delete bridge, restore ALL original IPs
# on the uplink, re-add the default route, and announce via gratuitous ARP.
rollback_vmbr0() {
    local uplink="$1" gateway="$2"; shift 2
    local original_cidrs=("$@") cidr
    ip link set dev "$uplink" nomaster 2>/dev/null || true
    ip link delete vmbr0 type bridge 2>/dev/null || true
    ip link set dev "$uplink" up 2>/dev/null || true
    for cidr in "${original_cidrs[@]}"; do
        ip addr add "$cidr" dev "$uplink" 2>/dev/null || true
    done
    [[ -n "$gateway" ]] && ip route replace default via "$gateway" dev "$uplink" 2>/dev/null || true
    if command -v arping >/dev/null 2>&1 && [[ ${#original_cidrs[@]} -gt 0 ]]; then
        arping -U -c 3 -w 2 -I "$uplink" "${original_cidrs[0]%%/*}" 2>/dev/null || true
    fi
}

# Reboot-time safety net. The install-time watchdog only protects the LIVE
# migration; this protects the NEXT BOOT. It runs ~45s after every boot, checks
# the host still has connectivity, and if NOT, tears down the persistent vmbr0
# config and brings the uplink back on DHCP so the box self-heals instead of
# staying unreachable (the failure that previously forced a full reinstall).
install_netguard_service() {
    local uplink="$1" gateway="$2"
    local guard=/usr/local/sbin/auxinuxvirtual-netguard

    cat > "$guard" <<GUARD
#!/bin/bash
# AuxiNux Virtua network self-heal — auto-generated by install.sh
UPLINK="${uplink}"
GW="${gateway}"
BRIDGE_CFG=/etc/network/interfaces.d/auxinuxvirtual-bridge-vmbr0.cfg
UPLINK_CFG=/etc/network/interfaces.d/auxinuxvirtual-uplink-\${UPLINK}.cfg

reachable() {
  command -v arping >/dev/null 2>&1 && arping -f -c 2 -w 3 -I vmbr0 "\$GW" >/dev/null 2>&1 && return 0
  [ -n "\$GW" ] && ping -c 1 -W 2 "\$GW" >/dev/null 2>&1 && return 0
  ping -c 1 -W 2 1.1.1.1 >/dev/null 2>&1 && return 0
  ping -c 1 -W 2 9.9.9.9 >/dev/null 2>&1 && return 0
  return 1
}

# Let the network settle, then probe a few times.
sleep 45
for i in 1 2 3 4 5; do reachable && exit 0; sleep 10; done

# The bridge is fully assembled (a port is enslaved) and carries an IPv4 → the
# outage is UPSTREAM (WAN down / gateway silent). Reverting would destroy the
# guests' networking without restoring anything: leave the bridge alone.
if ls /sys/class/net/vmbr0/brif/ 2>/dev/null | grep -q . \
   && ip -4 -o addr show dev vmbr0 scope global 2>/dev/null | grep -q .; then
  logger -t auxinuxvirtual-netguard "gateway unreachable but vmbr0 is assembled with an IP — upstream outage, NOT reverting"
  exit 0
fi

# Give the bridge self-heal a chance before the nuclear revert.
if [ -x /usr/local/sbin/virtua-bridge-heal ]; then
  /usr/local/sbin/virtua-bridge-heal vmbr0 || true
  sleep 5
  reachable && exit 0
fi

logger -t auxinuxvirtual-netguard "Host unreachable after boot — reverting vmbr0 to restore connectivity"
ts=\$(date +%Y%m%d%H%M%S)
[ -f "\$BRIDGE_CFG" ] && mv "\$BRIDGE_CFG" "\${BRIDGE_CFG}.netguard-disabled-\${ts}"
[ -f "\$UPLINK_CFG" ] && mv "\$UPLINK_CFG" "\${UPLINK_CFG}.netguard-disabled-\${ts}"
ip link set vmbr0 down 2>/dev/null || true
ip link delete vmbr0 type bridge 2>/dev/null || true
ip link set dev "\$UPLINK" up 2>/dev/null || true
# Restore connectivity via DHCP on the bare uplink.
if command -v dhclient >/dev/null 2>&1; then
  dhclient -4 -nw "\$UPLINK" 2>/dev/null || true
fi
systemctl restart networking 2>/dev/null || true
logger -t auxinuxvirtual-netguard "vmbr0 reverted; uplink \$UPLINK brought back (DHCP)."
exit 0
GUARD
    chmod 0755 "$guard"

    cat > /etc/systemd/system/auxinuxvirtual-netguard.service <<'UNIT'
[Unit]
Description=AuxiNux Virtua network self-heal (revert vmbr0 if host is unreachable)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/auxinuxvirtual-netguard
StandardOutput=journal
StandardError=journal
SyslogIdentifier=auxinuxvirtual-netguard

[Install]
WantedBy=multi-user.target
UNIT

    systemctl daemon-reload 2>/dev/null || true
    systemctl enable auxinuxvirtual-netguard.service >/dev/null 2>&1 || true
    info "Reboot self-heal armed (auxinuxvirtual-netguard): reverts vmbr0 if the host is unreachable after a reboot"
}

# Regenerate an already-deployed netguard with the current (hardened) logic:
# it is a file GENERATED at bridge-creation time, not shipped by the package,
# so without this an update would leave the old — bridge-destroying — version
# in place forever.
refresh_netguard_service() {
    local guard=/usr/local/sbin/auxinuxvirtual-netguard
    [[ -f "$guard" ]] || return 0
    local uplink gw
    uplink=$(sed -n 's/^UPLINK="\(.*\)"$/\1/p' "$guard" | head -1)
    gw=$(sed -n 's/^GW="\(.*\)"$/\1/p' "$guard" | head -1)
    [[ -z "$uplink" ]] && return 0
    install_netguard_service "$uplink" "$gw"
}

# Boot-time + post-update bridge self-heal. A host update or reboot must never
# leave a managed bridge without its uplink: that exact failure took down a
# production DNS (bridge existed, port gone → every guest offline).
install_bridge_heal_service() {
    step "Install bridge self-heal (virtua-bridge-heal)"
    local src="${INSTALL_DIR}/INSTALL/virtua-bridge-heal.sh"
    if [[ ! -f "$src" ]]; then
        warn "virtua-bridge-heal.sh not found in ${INSTALL_DIR}/INSTALL — bridge self-heal not installed"
        return 0
    fi
    install -m 0755 "$src" /usr/local/sbin/virtua-bridge-heal

    cat > /etc/systemd/system/virtua-bridge-heal.service <<'UNIT'
[Unit]
Description=AuxiNux Virtua bridge self-heal (reassemble managed bridges after boot)
After=network-online.target networking.service systemd-networkd.service NetworkManager.service
Wants=network-online.target

[Service]
Type=oneshot
# Give slow NICs/switches/DHCP a moment before judging the bridges.
ExecStartPre=/bin/sleep 15
ExecStart=/usr/local/sbin/virtua-bridge-heal
StandardOutput=journal
StandardError=journal
SyslogIdentifier=virtua-bridge-heal

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload 2>/dev/null || true
    systemctl enable virtua-bridge-heal.service >/dev/null 2>&1 || true

    # Heal RIGHT NOW too: if this very update (or a previous one) left a bridge
    # broken, installing the update is what repairs it — no manual step.
    if ! /usr/local/sbin/virtua-bridge-heal; then
        warn "bridge self-heal could not repair a bridge (journalctl -t virtua-bridge-heal)"
    fi
    success "Bridge self-heal armed (every boot + after each update)"
}

ensure_vmbr0_bridge() {
    step "Configure public bridge vmbr0"

    if ip link show vmbr0 >/dev/null 2>&1; then
        info "vmbr0 already exists — leaving it untouched"
        return 0
    fi

    # ── SAFETY: do NOT auto-migrate the host network by default ────────────────
    # Auto-creating vmbr0 by migrating the host's primary NIC on a REMOTE box is
    # dangerous: if the host uses systemd-networkd/cloud-init (common on OVH and
    # Debian 13 cloud images), writing an ifupdown bridge makes both stacks fight
    # on reboot and the public IP goes stale → server unreachable. This bricked a
    # production host once. So it is now OPT-IN and only proceeds on an ifupdown
    # host. Recommended path: create vmbr0 from the UI (Network → Cloud bridged)
    # during a maintenance window where you can watch it and the auto-rollback.
    if [[ "${AUXINUX_SETUP_VMBR0:-0}" != "1" ]]; then
        info "Automatic vmbr0 creation is disabled by default (safe)."
        info "  • To create it from the UI: Network → Create Bridge → Cloud bridged"
        info "  • To let the installer do it on an ifupdown host: rerun with AUXINUX_SETUP_VMBR0=1"
        return 0
    fi

    local netmgr
    netmgr="$(detect_network_manager)"
    if [[ "$netmgr" != "ifupdown" ]]; then
        warn "Host network is managed by '${netmgr}', not ifupdown."
        warn "Refusing to write an ifupdown vmbr0 config — it would conflict with ${netmgr} on reboot"
        warn "and can make the public IP unreachable (this is the failure that bricked a host before)."
        warn "Create the bridge natively for ${netmgr}, or convert the host to ifupdown first."
        return 0
    fi

    local uplink primary_cidr gateway uplink_mac
    uplink="$(get_primary_uplink_interface)"
    if [[ -z "$uplink" ]]; then
        warn "Unable to detect the primary uplink interface; vmbr0 was not created"
        return 0
    fi
    gateway="$(get_interface_gateway "$uplink")"
    if [[ -z "$gateway" ]]; then
        warn "No default gateway on $uplink; vmbr0 was not created (nothing to migrate safely)"
        return 0
    fi
    primary_cidr="$(get_primary_ipv4_cidr "$uplink" "$gateway")"
    if [[ -z "$primary_cidr" ]]; then
        warn "Could not determine the primary IPv4 of $uplink; vmbr0 was not created"
        return 0
    fi
    uplink_mac="$(get_interface_mac "$uplink")"

    # If the primary IP is a DHCP lease, the persistent bridge must use DHCP too
    # (never freeze a lease as static — that is what made the IP go stale).
    local bridge_ip_mode="static"
    if primary_ip_is_dhcp "$uplink"; then
        bridge_ip_mode="dhcp"
        info "Primary IPv4 on $uplink is DHCP → vmbr0 will keep DHCP (not frozen static)"
    fi

    # Capture ALL current global IPv4 addresses so a rollback can restore them.
    local original_cidrs=()
    mapfile -t original_cidrs < <(ip -4 -o addr show dev "$uplink" scope global 2>/dev/null | awk '{print $4}')

    info "Uplink interface : $uplink (MAC ${uplink_mac:-unknown})"
    info "Primary IPv4     : $primary_cidr  → migrated onto vmbr0"
    info "Gateway          : $gateway"
    local freed_count=$(( ${#original_cidrs[@]} - 1 ))
    [[ $freed_count -gt 0 ]] && info "Failover IP(s)   : ${freed_count} address(es) left FREE for VM/LXC/Docker guests"

    # Arm the anti-lockout watchdog BEFORE we touch the live network.
    arm_bridge_watchdog "$uplink" "$gateway" "${original_cidrs[@]}"

    # ── Live migration (atomic-ish): bridge up → enslave → move primary IP ──────
    ip link add vmbr0 type bridge stp_state 0 2>/dev/null || { warn "Unable to create vmbr0"; disarm_bridge_watchdog; return 0; }
    [[ -n "$uplink_mac" ]] && ip link set dev vmbr0 address "$uplink_mac" 2>/dev/null || true
    if ! ip link set dev vmbr0 up 2>/dev/null; then
        warn "Unable to bring vmbr0 up"; ip link delete vmbr0 type bridge 2>/dev/null || true; disarm_bridge_watchdog; return 0
    fi

    ip addr flush dev "$uplink" 2>/dev/null || true
    if ! ip link set dev "$uplink" master vmbr0 2>/dev/null; then
        warn "Unable to enslave $uplink into vmbr0 — rolling back"
        rollback_vmbr0 "$uplink" "$gateway" "${original_cidrs[@]}"
        disarm_bridge_watchdog
        return 0
    fi
    ip link set dev "$uplink" up 2>/dev/null || true
    [[ -n "$uplink_mac" ]] && ip link set dev vmbr0 address "$uplink_mac" 2>/dev/null || true
    # Move ONLY the primary IP onto the bridge (failover /32s stay free for guests).
    ip addr add "$primary_cidr" dev vmbr0 2>/dev/null || true
    ip route replace default via "$gateway" dev vmbr0 2>/dev/null || true

    # Tell the upstream switch/gateway about the move immediately.
    if command -v arping >/dev/null 2>&1; then
        arping -U -c 3 -w 2 -I vmbr0 "${primary_cidr%%/*}" 2>/dev/null || true
    fi

    # ── Verify; roll back if the host lost connectivity ─────────────────────────
    if [[ "${AUXINUX_SKIP_BRIDGE_VERIFY:-0}" != "1" ]] && ! bridge_host_reachable "$gateway" vmbr0; then
        warn "Host lost connectivity after migrating $uplink → rolling back vmbr0"
        rollback_vmbr0 "$uplink" "$gateway" "${original_cidrs[@]}"
        disarm_bridge_watchdog
        disable_prepared_vmbr0_bridge_config
        warn "vmbr0 was NOT created. The host network was restored. Create it later from the UI (Network → OVH bridged) during a maintenance window."
        return 0
    fi

    # Reachable → cancel the watchdog and persist the config (MAC pinned).
    disarm_bridge_watchdog
    write_vmbr0_bridge_config "$uplink" "$primary_cidr" "$gateway" "$bridge_ip_mode"
    remove_legacy_uplink_stanza_from_interfaces "$uplink"
    install_netguard_service "$uplink" "$gateway"

    success "Public bridge vmbr0 is UP on $uplink (host IP $primary_cidr, MAC pinned ${uplink_mac:-auto})"
    [[ $freed_count -gt 0 ]] && success "Failover IP(s) freed — assign them to guests with their OVH vMAC"
}

ensure_network_interfaces_include() {
    local main_file="/etc/network/interfaces"
    local include_line="source /etc/network/interfaces.d/*.cfg"
    mkdir -p /etc/network/interfaces.d
    if [[ ! -f "$main_file" ]]; then
        cat > "$main_file" <<'EOF'
# Managed by AuxiNux Virtua
auto lo
iface lo inet loopback

source /etc/network/interfaces.d/*.cfg
EOF
        info "Created /etc/network/interfaces with interfaces.d include"
        return 0
    fi
    if grep -Eq '^[[:space:]]*(source|source-directory)[[:space:]]+/etc/network/interfaces\.d' "$main_file"; then
        return 0
    fi
    backup_file_if_exists "$main_file"
    printf '\n# Added by AuxiNux Virtua for persistent bridge definitions\n%s\n' "$include_line" >> "$main_file"
    info "Enabled /etc/network/interfaces.d bridge include"
}

remove_legacy_uplink_stanza_from_interfaces() {
    local uplink="$1"
    local main_file="/etc/network/interfaces"
    local tmp_file

    [[ -n "$uplink" && -f "$main_file" ]] || return 0

    tmp_file="$(mktemp)"
    awk -v uplink="$uplink" '
        function stop_skip() {
            skip = 0
        }

        /^[[:space:]]*(auto|allow-hotplug)[[:space:]]+/ {
            split($0, parts, /[[:space:]]+/)
            if (parts[2] == uplink) {
                skip = 1
                next
            }
            stop_skip()
        }

        /^[[:space:]]*iface[[:space:]]+/ {
            split($0, parts, /[[:space:]]+/)
            if (parts[2] == uplink) {
                skip = 1
                next
            }
            stop_skip()
        }

        /^[[:space:]]*(source|source-directory)[[:space:]]+/ {
            stop_skip()
        }

        {
            if (!skip) {
                print
            }
        }
    ' "$main_file" > "$tmp_file"

    if ! cmp -s "$main_file" "$tmp_file"; then
        backup_file_if_exists "$main_file"
        mv "$tmp_file" "$main_file"
        info "Removed legacy ${uplink} stanza from /etc/network/interfaces"
    else
        rm -f "$tmp_file"
    fi
}

remove_path_if_exists() {
    local target="$1"
    if [[ -e "$target" || -L "$target" ]]; then
        rm -rf "$target"
        info "Removed: $target"
    fi
}

read_env_value() {
    local file="$1"
    local key="$2"
    [[ -f "$file" ]] || return 0
    grep -E "^${key}=" "$file" | tail -1 | cut -d= -f2- || true
}

require_root() {
    [[ $EUID -eq 0 ]] || error "This script must be run as root"
}

ensure_command() {
    local cmd="$1"
    local pkg="$2"
    command -v "$cmd" >/dev/null 2>&1 || {
        info "Missing command detected: $cmd -> installing $pkg"
        "${APT_GET[@]}" install "$pkg" >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err \
            || error "Unable to install $pkg"
    }
}

pkg_installed() {
    dpkg -s "$1" >/dev/null 2>&1
}

pkg_available() {
    apt-cache show "$1" >/dev/null 2>&1
}

repair_apt_state() {
    local reason="${1:-unknown}"
    warn "APT/DPKG state needs repair (${reason})"

    if dpkg --configure -a >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
        info "dpkg --configure -a completed"
    else
        cat /tmp/auxinux-install.err >&2 || true
        error "Unable to repair interrupted dpkg state"
    fi

    if "${APT_GET[@]}" install -f >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
        info "apt-get install -f completed"
    else
        cat /tmp/auxinux-install.err >&2 || true
        error "Unable to repair broken APT dependencies"
    fi
}

ensure_apt_state_healthy() {
    local audit_output=""
    audit_output="$(dpkg --audit 2>/dev/null || true)"
    if [[ -n "${audit_output//[[:space:]]/}" ]]; then
        repair_apt_state "dpkg audit reported unfinished package work"
        return
    fi

    if [[ -d /var/lib/dpkg/updates ]] && find /var/lib/dpkg/updates -mindepth 1 -maxdepth 1 -type f | grep -q .; then
        repair_apt_state "pending dpkg update fragments detected"
    fi
}

should_attempt_apt_repair() {
    local err_file="/tmp/auxinux-install.err"
    [[ -f "$err_file" ]] || return 1
    grep -Eqi \
        "dpkg was interrupted|run 'dpkg --configure -a'|unmet dependencies|fix-broken install|package database is locked|could not get lock|is another process using it" \
        "$err_file"
}

install_packages() {
    ensure_apt_state_healthy
    local missing=()
    local pkg
    for pkg in "$@"; do
        pkg_installed "$pkg" || missing+=("$pkg")
    done

    if ((${#missing[@]} == 0)); then
        success "Packages already present: $*"
        return
    fi

    info "Installing missing packages: ${missing[*]}"
    if "${APT_GET[@]}" install "${missing[@]}" >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
        return
    fi

    if should_attempt_apt_repair; then
        repair_apt_state "bulk package installation failed"
        if "${APT_GET[@]}" install "${missing[@]}" >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
            return
        fi
    fi

    warn "Bulk installation failed, retrying package by package"
    cat /tmp/auxinux-install.err >&2 || true

    local failed=()
    for pkg in "${missing[@]}"; do
        if pkg_installed "$pkg"; then
            continue
        fi
        if "${APT_GET[@]}" install "$pkg" >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
            info "Package installed: $pkg"
        else
            warn "Package unavailable or not installable: $pkg"
            failed+=("$pkg")
        fi
    done

    if ((${#failed[@]} > 0)); then
        error "Failed to install critical packages: ${failed[*]}"
    fi
}

install_optional_packages() {
    ensure_apt_state_healthy
    local pkg
    for pkg in "$@"; do
        if pkg_installed "$pkg"; then
            info "Optional package already present: $pkg"
            continue
        fi
        if ! apt-cache show "$pkg" >/dev/null 2>&1; then
            warn "Optional package not found in APT: $pkg"
            continue
        fi
        if "${APT_GET[@]}" install "$pkg" >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
            info "Optional package installed: $pkg"
        else
            warn "Optional package unavailable or not installed: $pkg"
        fi
    done
}

install_or_upgrade_packages() {
    ensure_apt_state_healthy
    local requested=()
    local pkg
    for pkg in "$@"; do
        if pkg_available "$pkg"; then
            requested+=("$pkg")
        else
            warn "Critical package not found in APT: $pkg"
        fi
    done

    if ((${#requested[@]} == 0)); then
        error "No installable critical packages were found"
    fi

    info "Installing/updating packages: ${requested[*]}"
    if "${APT_GET[@]}" install "${requested[@]}" >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
        return
    fi

    if should_attempt_apt_repair; then
        repair_apt_state "bulk package synchronization failed"
        if "${APT_GET[@]}" install "${requested[@]}" >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
            return
        fi
    fi

    warn "Bulk install/update failed, retrying package by package"
    cat /tmp/auxinux-install.err >&2 || true

    local failed=()
    for pkg in "${requested[@]}"; do
        if "${APT_GET[@]}" install "$pkg" >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
            info "Package synchronized: $pkg"
        else
            warn "Critical package could not be synchronized: $pkg"
            failed+=("$pkg")
        fi
    done

    if ((${#failed[@]} > 0)); then
        error "Failed to synchronize critical packages: ${failed[*]}"
    fi
}

enable_service_if_present() {
    local service
    for service in "$@"; do
        if systemctl list-unit-files "$service" >/dev/null 2>&1; then
            if [[ "$service" == "networking.service" ]]; then
                systemctl enable "$service" >/dev/null 2>&1 || warn "Unable to enable $service"
                info "Service enabled for next boot: $service"
            else
                systemctl enable --now "$service" >/dev/null 2>&1 || warn "Unable to enable $service"
                info "Service active: $service"
            fi
        fi
    done
}

stop_auxinux_services_if_present() {
    step "Stop AuxiNux services before update"
    local services=(auxinuxvirtual-api auxinuxvirtual-runner)
    local service

    for service in "${services[@]}"; do
        if systemctl list-unit-files "${service}.service" >/dev/null 2>&1; then
            if systemctl is-active --quiet "$service"; then
                systemctl stop "$service" || warn "Unable to stop $service"
                info "Service stopped: $service"
            else
                info "Service already stopped: $service"
            fi
        fi
    done
}

prepare_runtime_reinstall() {
    step "Prepare runtime artifacts for reinstall"
    remove_path_if_exists "$AUXINUX_RUNNER_SOCK"
    remove_path_if_exists "$INSTALL_DIR/node_modules"
    remove_path_if_exists "$INSTALL_DIR/apps/api/node_modules"
    remove_path_if_exists "$INSTALL_DIR/apps/runner/node_modules"
    remove_path_if_exists "$INSTALL_DIR/apps/ui/node_modules"
    remove_path_if_exists "$INSTALL_DIR/packages/shared/node_modules"
    remove_path_if_exists "$INSTALL_DIR/apps/api/dist"
    remove_path_if_exists "$INSTALL_DIR/apps/runner/dist"
    remove_path_if_exists "$INSTALL_DIR/apps/ui/dist"
    remove_path_if_exists "$INSTALL_DIR/packages/shared/dist"
}

confirm_reset_mode() {
    if [[ "${AUXINUX_ASSUME_YES:-0}" == "1" ]]; then
        warn "Reset confirmation bypassed because AUXINUX_ASSUME_YES=1"
        return
    fi

    if [[ ! -t 0 ]]; then
        error "Reset mode requires confirmation on a TTY, or set AUXINUX_ASSUME_YES=1"
    fi

    warn "Reset mode will erase AuxiNux portal data and configuration, then reinstall it."
    warn "This does not remove the Debian OS, QEMU VM disks, LXC containers, or Docker containers."
    printf "Type RESET to continue: "
    local answer
    read -r answer
    [[ "$answer" == "RESET" ]] || error "Reset cancelled"
}

reset_portal_state() {
    step "Reset portal state"
    stop_auxinux_services_if_present
    backup_file_if_exists "$INSTALL_DIR/apps/api/.env"
    backup_file_if_exists /etc/systemd/system/auxinuxvirtual-runner.service
    backup_file_if_exists /etc/systemd/system/auxinuxvirtual-api.service

    remove_path_if_exists "$AUXINUX_DATA_DIR"
    remove_path_if_exists "$INSTALL_DIR/apps/api/.env"
    remove_path_if_exists /etc/systemd/system/auxinuxvirtual-runner.service
    remove_path_if_exists /etc/systemd/system/auxinuxvirtual-api.service
    prepare_runtime_reinstall
    systemctl daemon-reload
}

# Aggressive full-wipe used by `-clean` and by the automatic recovery path when
# we detect an incomplete previous install. Strictly more thorough than
# `reset_portal_state`: also drops .bak backup files, the API .env, iptables
# rules opened by the previous run, the systemd restart-failure counter, and
# any stale runner socket.
clean_full_wipe() {
    step "Clean full wipe"

    # Make sure no service is holding files / sockets we're about to delete.
    stop_auxinux_services_if_present
    systemctl reset-failed auxinuxvirtual-api 2>/dev/null || true
    systemctl reset-failed auxinuxvirtual-runner 2>/dev/null || true

    # Portal data, env, systemd units.
    remove_path_if_exists "$AUXINUX_DATA_DIR"
    remove_path_if_exists "$INSTALL_DIR/apps/api/.env"
    remove_path_if_exists /etc/systemd/system/auxinuxvirtual-runner.service
    remove_path_if_exists /etc/systemd/system/auxinuxvirtual-api.service
    remove_path_if_exists /etc/systemd/system/auxinuxvirtual-runner.service.bak
    remove_path_if_exists /etc/systemd/system/auxinuxvirtual-api.service.bak

    # Runtime artifacts (node_modules + dist trees).
    prepare_runtime_reinstall

    # CLI symlink dropped by install_cli_binary().
    remove_path_if_exists /usr/bin/virtua
    remove_path_if_exists /usr/local/bin/virtua

    # Runner socket if leftover.
    remove_path_if_exists "$AUXINUX_RUNNER_SOCK"

    # Clean iptables rules previously opened on port 8441 (others are kept;
    # 22/80/443 may belong to other services on the host).
    if command -v iptables >/dev/null 2>&1; then
        while iptables -C INPUT -p tcp --dport "$AUXINUX_PORT" -j ACCEPT 2>/dev/null; do
            iptables -D INPUT -p tcp --dport "$AUXINUX_PORT" -j ACCEPT 2>/dev/null || break
        done
    fi

    # Stale install-time backups scattered in the workspace.
    find "$INSTALL_DIR" -maxdepth 4 -type f -name '*.bak' \
        \( -path '*apps/api/.env.bak' -o -path '*apps/api/*.env*.bak' \) \
        -delete 2>/dev/null || true

    systemctl daemon-reload
    success "Full wipe done — fresh install will follow"
}

# Detect residue from a previously aborted install. Triggers when:
#   - systemd unit files exist (so something tried to install), AND
#   - the completion marker is missing (so the previous run never reached
#     the end), AND
#   - we are NOT in update/repair/reset/clean (those modes know what they
#     want and shouldn't be second-guessed).
# When triggered, run clean_full_wipe automatically to avoid the "invalid
# ELF header" / stale .env class of bugs reported in the field.
auto_recover_from_failed_install() {
    [[ "$MODE" != "install" ]] && return 0

    local has_unit=0
    [[ -f /etc/systemd/system/auxinuxvirtual-api.service ]] && has_unit=1
    [[ -f /etc/systemd/system/auxinuxvirtual-runner.service ]] && has_unit=1
    [[ "$has_unit" -eq 0 ]] && return 0

    [[ -f "$INSTALL_COMPLETION_MARKER" ]] && return 0

    step "Detected incomplete previous install — auto-recovery"
    warn "Found AuxiNux systemd units but no completion marker at ${INSTALL_COMPLETION_MARKER}."
    warn "Running a full wipe to remove stale binaries / .env / units before reinstalling."
    warn "Existing /var/lib/auxinuxvirtual data will be erased (VMs/containers themselves are untouched)."
    clean_full_wipe
}

# Called at the very end of main(), once everything else succeeded.
write_install_completion_marker() {
    mkdir -p "$AUXINUX_DATA_DIR"
    date -u +"%Y-%m-%dT%H:%M:%SZ version=${PROJECT_VERSION:-unknown}" > "$INSTALL_COMPLETION_MARKER"
    chmod 0644 "$INSTALL_COMPLETION_MARKER"
}

apply_mode_preflight() {
    step "Execution mode"
    info "Selected mode: $MODE"

    case "$MODE" in
        install)
            # If the previous run died mid-install (no completion marker but
            # systemd units present), automatically clean residue before
            # proceeding so we don't drag stale binaries / .env / cgroup
            # state into the new install.
            auto_recover_from_failed_install
            ;;
        update)
            ;;
        repair)
            stop_auxinux_services_if_present
            prepare_runtime_reinstall
            ;;
        reset)
            confirm_reset_mode
            reset_portal_state
            ;;
        clean)
            # `-clean` is non-interactive on purpose: it's the "kill it and
            # try again" path for CI and frustrated humans. Document the
            # destructive intent loudly but don't gate on a TTY prompt.
            warn "CLEAN mode: about to erase ALL AuxiNux portal state and reinstall fresh."
            clean_full_wipe
            ;;
        *)
            error "Unsupported mode: $MODE"
            ;;
    esac
}

ensure_apt_prereqs() {
    step "Bootstrap APT and minimum tools"
    ensure_apt_state_healthy
    apt-get update -qq "${APT_LOCK_OPT[@]}"
    install_packages apt ca-certificates curl wget gnupg lsb-release
    install_optional_packages gpg apt-transport-https software-properties-common
    install_packages bash coreutils sed grep gawk findutils util-linux procps systemd systemd-sysv kmod
    install_packages tar gzip xz-utils unzip zip rsync jq sudo acl dbus dbus-user-session openssl adduser passwd
    # Backup compression: zstd (preferred — fast, high ratio) + pigz (parallel gzip)
    # pv: real backup progress (bytes processed) streamed to the UI
    # dialog: ncurses UI for the `virtua gui` terminal interface
    install_packages zstd pigz pv dialog
    # Needed for console (noVNC/SPICE/RDP bridge) + monitoring + diagnostics
    # iputils-arping: gratuitous ARP after bridge IP migration (OVH/cloud reliability)
    install_packages lsof net-tools iputils-ping iputils-arping traceroute dnsutils
    install_optional_packages websockify python3-websockify novnc xrdp htop iotop nmap strace ltrace
    success "Minimum system base is ready"
}

validate_platform() {
    step "Validation checks"
    [[ "$(uname -m)" == "x86_64" ]] || error "This script requires an x86_64 host"
    [[ -d /run/systemd/system ]] || error "Systemd is required on the target host"

    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        [[ "$ID" == "debian" ]] || warn "Detected system: $ID $VERSION_ID. Script is optimized for Debian."
        if [[ "${VERSION_ID:-}" != "13" ]]; then
            warn "Detected version: ${VERSION_ID:-unknown}. Recommended target: Debian 13."
        fi
    fi

    info "Install directory         : $INSTALL_DIR"
    info "API port                  : $AUXINUX_PORT"
    info "Data directory            : $AUXINUX_DATA_DIR"

    ensure_host_dns_resolution
}

# Public name resolution is mandatory for AuxiNux: Docker pulls images from
# Docker Hub, lxc-create downloads templates from images.linuxcontainers.org,
# the installer fetches the NodeSource + Docker GPG keys, etc. Debian 13's
# minimal install often leaves /etc/resolv.conf pointing only at the
# systemd-resolved stub at 127.0.0.53 with no upstream configured — which
# makes every external resolution fail silently with "Temporary failure in
# name resolution". Detect that situation here and configure 1.1.1.1 / 8.8.8.8
# as upstream so the rest of the install (and the running panel) can resolve.
ensure_host_dns_resolution() {
    local probe_host="${AUXINUX_DNS_PROBE_HOST:-deb.debian.org}"
    if getent hosts "$probe_host" >/dev/null 2>&1; then
        return 0
    fi

    warn "Host cannot resolve ${probe_host} via the default resolver."
    warn "Installing a fallback DNS configuration (Cloudflare + Google) so package + image downloads can proceed."

    if systemctl is-enabled systemd-resolved >/dev/null 2>&1 || systemctl is-active systemd-resolved >/dev/null 2>&1; then
        install -d -m 0755 /etc/systemd/resolved.conf.d
        backup_file_if_exists /etc/systemd/resolved.conf.d/auxinux-dns.conf
        cat > /etc/systemd/resolved.conf.d/auxinux-dns.conf <<'EOF'
[Resolve]
DNS=1.1.1.1 8.8.8.8
FallbackDNS=9.9.9.9 1.0.0.1
DNSStubListener=yes
EOF
        systemctl restart systemd-resolved
    else
        backup_file_if_exists /etc/resolv.conf
        cat > /etc/resolv.conf <<'EOF'
# Written by AuxiNux installer because no resolver was configured.
nameserver 1.1.1.1
nameserver 8.8.8.8
EOF
    fi

    # Re-test. If it still fails, the issue is outbound network (firewall, no
    # internet, …) and the rest of the install would fail too — fail loud.
    if ! getent hosts "$probe_host" >/dev/null 2>&1; then
        error "DNS resolution still fails for ${probe_host}. Check that the host has outbound network access (try: ping -c 2 1.1.1.1)."
    fi
    info "DNS resolution working again — using 1.1.1.1 / 8.8.8.8"
}

configure_docker_repo() {
    install -m 0755 -d /etc/apt/keyrings
    if [[ ! -f "$DOCKER_KEYRING" ]]; then
        curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o "$DOCKER_KEYRING"
        chmod a+r "$DOCKER_KEYRING"
    fi

    cat > "$DOCKER_LIST" <<EOF
deb [arch=amd64 signed-by=${DOCKER_KEYRING}] https://download.docker.com/linux/debian $(lsb_release -cs) stable
EOF
}

configure_nodesource_repo() {
    if command -v node >/dev/null 2>&1; then
        local current_major
        current_major="$(node -p 'process.versions.node.split(".")[0]')"
        if [[ "$current_major" -ge "$NODE_MAJOR" ]]; then
            info "Node.js already meets the required version: $(node --version)"
            return
        fi
    fi

    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
}

install_system_packages() {
    step "Install virtualization system packages"

    ensure_command adduser adduser
    ensure_command useradd passwd

    local base_pkgs=(
        build-essential python3 python3-venv make g++ pkg-config git ifupdown
        bridge-utils iproute2 iptables nftables dnsmasq-base ebtables netcat-openbsd socat nfs-common cifs-utils isc-dhcp-client
        mdadm parted gdisk psmisc file pciutils usbutils dmidecode
        apparmor apparmor-utils uidmap debootstrap
        cpu-checker ovmf ovmf-ia32 seabios genisoimage qemu-block-extra qemu-system-x86 qemu-utils qemu-kvm
        qemu-system-common qemu-system-data qemu-system-gui qemu-efi-aarch64
        libvirt-daemon libvirt-daemon-system libvirt-clients libvirt-daemon-driver-qemu
        libvirt-daemon-driver-lxc virtinst libnss-libvirt
        lxc lxc-templates
        swtpm swtpm-tools
        libvirglrenderer1 mesa-utils libgl1 libegl1 libgles2 libgbm1 libdrm2 libepoxy0
        spice-vdagent
    )

    install_or_upgrade_packages "${base_pkgs[@]}"
    install_optional_packages \
        libvirt-daemon-driver-network \
        libvirt-daemon-driver-interface \
        libvirt-daemon-driver-nwfilter \
        libvirt-daemon-driver-secret \
        libvirt-daemon-driver-storage-core \
        libvirt-daemon-driver-storage-rbd \
        libvirt-daemon-driver-storage-iscsi \
        libvirt-daemon-driver-storage-gluster \
        libvirt-daemon-driver-storage-zfs \
        libvirt-daemon-driver-storage-lvm \
        lxcfs lxc-utils lxc-net virt-top guestfs-tools \
        virtiofsd \
        qemu-system-modules-spice qemu-system-modules-opengl \
        libspice-server1 libspice-client-glib-2.0-8 \
        spice-client-glib-usb-acl-helper \
        libvirt-daemon-config-nwfilter \
        cloud-image-utils
    success "Virtualization packages installed (KVM/QEMU, VirtIO, SPICE, VirGL, swTPM, VirtIO-FS)"
}

install_docker_stack() {
    step "Install recent Docker CE"
    configure_docker_repo
    apt-get update -qq "${APT_LOCK_OPT[@]}"

    if ! "${APT_GET[@]}" install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
        warn "Docker CE is unavailable on this mirror/release, using docker.io as a temporary fallback"
        install_or_upgrade_packages docker.io
        if ! pkg_installed docker-compose-plugin; then
            if ! "${APT_GET[@]}" install docker-compose-plugin >/tmp/auxinux-install.out 2>/tmp/auxinux-install.err; then
                install_optional_packages docker-compose
            fi
        fi
    fi

    command -v docker >/dev/null 2>&1 || error "Docker was not installed"
    docker --version >/dev/null 2>&1 || error "Docker is present but not functional"
    success "Docker available: $(docker --version)"
}

install_node_stack() {
    step "Install Node.js ${NODE_MAJOR}.x"
    configure_nodesource_repo
    install_or_upgrade_packages nodejs

    command -v node >/dev/null 2>&1 || error "Node.js is missing after installation"
    command -v npm >/dev/null 2>&1 || error "npm is missing after installation"

    npm install -g npm@latest --quiet || warn "npm update skipped"
    success "Node.js $(node --version)"
    success "npm $(npm --version)"
}

configure_kernel_and_runtime() {
    step "Enable kernel modules and runtime configuration"

    # Build modules-load.d config — detect CPU vendor to avoid spurious boot warnings
    # (kvm_intel and kvm_amd are mutually exclusive; loading the wrong one is harmless but noisy)
    local kvm_vendor_mod="kvm_intel"
    if grep -q 'svm' /proc/cpuinfo 2>/dev/null && ! grep -q 'vmx' /proc/cpuinfo 2>/dev/null; then
        kvm_vendor_mod="kvm_amd"
    fi

    backup_file_if_exists /etc/modules-load.d/auxinuxvirtual.conf
    cat > /etc/modules-load.d/auxinuxvirtual.conf <<EOF
# Core KVM / virtualization
kvm
${kvm_vendor_mod}
vhost_net
vhost_vsock
vhost_scsi
# Bridging / namespaces
br_netfilter
tun
macvtap
# VirtIO guest-side (loaded on the host for passthrough/nested support)
virtio
virtio_pci
virtio_net
virtio_blk
virtio_scsi
virtio_balloon
virtio_console
virtio_rng
virtio_input
virtio_gpu
# VFIO (PCIe passthrough, GPUs, USB controllers, etc.)
# Note: vfio_virqfd was merged into vfio.ko in kernel 6.0+ (Debian 13 ships 6.x)
vfio
vfio_iommu_type1
vfio_pci
EOF

    # KVM
    modprobe kvm 2>/dev/null || true
    modprobe "${kvm_vendor_mod}" 2>/dev/null || true
    # Core networking
    modprobe vhost_net 2>/dev/null || true
    modprobe vhost_vsock 2>/dev/null || true
    modprobe br_netfilter 2>/dev/null || true
    modprobe tun 2>/dev/null || true
    modprobe macvtap 2>/dev/null || true
    # VirtIO
    for mod in virtio virtio_pci virtio_net virtio_blk virtio_scsi virtio_balloon virtio_console virtio_rng virtio_input virtio_gpu; do
        modprobe "$mod" 2>/dev/null || true
    done
    # VFIO (will only load if hardware supports it; silent failure is fine)
    for mod in vfio vfio_iommu_type1 vfio_pci; do
        modprobe "$mod" 2>/dev/null || true
    done

    backup_file_if_exists /etc/sysctl.d/99-auxinuxvirtual.conf
    cat > /etc/sysctl.d/99-auxinuxvirtual.conf <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
EOF
    sysctl --system >/dev/null 2>&1 || warn "sysctl changes were only partially applied"

    install -d -m 0755 /etc/docker
    backup_file_if_exists /etc/docker/daemon.json
    # "dns" is set explicitly because on Debian 13 /etc/resolv.conf typically
    # only contains the systemd-resolved stub resolver at 127.0.0.53. Docker
    # strips loopback addresses from inherited resolvers (they can't reach
    # the host's resolver from inside a container netns) and would otherwise
    # leave containers with NO usable nameserver — producing:
    #   "lookup registry-1.docker.io: Temporary failure in name resolution"
    # at first `docker pull`. The Cloudflare + Google pair is broadly
    # reachable; deployments that need internal DNS should override this in
    # /etc/docker/daemon.json after installation.
    cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "5"
  },
  "exec-opts": ["native.cgroupdriver=systemd"],
  "storage-driver": "overlay2",
  "iptables": true,
  "ip-forward": true,
  "ip-masq": true,
  "live-restore": true,
  "dns": ["1.1.1.1", "8.8.8.8"],
  "features": {
    "buildkit": true
  }
}
EOF

    ensure_network_interfaces_include
}

configure_lxc_networking() {
    step "Configure LXC bridge networking"

    if systemctl list-unit-files lxc-net.service >/dev/null 2>&1; then
        backup_file_if_exists /etc/default/lxc-net
        cat > /etc/default/lxc-net <<'EOF'
USE_LXC_BRIDGE="true"
LXC_BRIDGE="lxcbr0"
LXC_ADDR="10.0.3.1"
LXC_NETMASK="255.255.255.0"
LXC_NETWORK="10.0.3.0/24"
LXC_DHCP_RANGE="10.0.3.100,10.0.3.200"
LXC_DHCP_MAX="101"
EOF
        info "Configured lxc-net defaults for lxcbr0"
    else
        warn "lxc-net.service is unavailable; lxcbr0 DHCP bridge may need manual setup"
    fi
}

configure_virtualization_networking() {
    step "Configure libvirt and Docker networking"

    if command -v virsh >/dev/null 2>&1; then
        local default_net_xml="/tmp/auxinux-libvirt-default-network.xml"
        if ! virsh net-info default >/dev/null 2>&1; then
            cat > "$default_net_xml" <<'EOF'
<network>
  <name>default</name>
  <forward mode='nat'/>
  <bridge name='virbr0' stp='on' delay='0'/>
  <ip address='192.168.122.1' netmask='255.255.255.0'>
    <dhcp>
      <range start='192.168.122.100' end='192.168.122.200'/>
    </dhcp>
  </ip>
</network>
EOF
            virsh net-define "$default_net_xml" >/dev/null 2>&1 \
                && info "Defined libvirt default network" \
                || warn "Unable to define libvirt default network"
            rm -f "$default_net_xml"
        fi

        systemctl restart virtnetworkd.service >/dev/null 2>&1 || true
        systemctl restart libvirtd.service >/dev/null 2>&1 || true
        virsh net-autostart default >/dev/null 2>&1 || true
        virsh net-start default >/dev/null 2>&1 || true

        if ip link show virbr0 >/dev/null 2>&1; then
            info "Libvirt default bridge ready: virbr0"
        else
            warn "virbr0 is unavailable; VM networking on the default libvirt network may fail"
        fi
    fi

    if systemctl list-unit-files docker.service >/dev/null 2>&1; then
        systemctl restart docker.service >/dev/null 2>&1 || true
        if ip link show docker0 >/dev/null 2>&1; then
            info "Docker default bridge ready: docker0"
        else
            warn "docker0 is unavailable; Docker default bridge networking may fail"
        fi
    fi
}

configure_services() {
    step "Enable system services"

    # Only enable ifupdown's networking.service when the host actually uses
    # ifupdown. Forcing it on a systemd-networkd/cloud-init host makes both
    # stacks fight over the NIC on reboot → public IP unreachable.
    local netmgr_cfg
    netmgr_cfg="$(detect_network_manager)"
    if [[ "$netmgr_cfg" == "ifupdown" ]]; then
        enable_service_if_present networking.service
    else
        info "Network managed by '${netmgr_cfg}' — not enabling ifupdown networking.service (avoids reboot IP conflict)"
    fi
    enable_service_if_present libvirtd.service virtlogd.service virtlockd.service
    enable_service_if_present virtqemud.service virtnetworkd.service virtstoraged.service virtinterfaced.service virtnodedevd.service
    enable_service_if_present lxcfs.service lxc-net.service docker.service containerd.service

    if command -v virsh >/dev/null 2>&1; then
        virsh net-autostart default >/dev/null 2>&1 || true
        virsh net-start default >/dev/null 2>&1 || true
    fi

    if command -v kvm-ok >/dev/null 2>&1; then
        if kvm-ok >/dev/null 2>&1; then
            success "KVM is available"
        else
            warn "KVM is unavailable, VMs will run with software emulation"
        fi
    elif [[ -e /dev/kvm ]]; then
        success "/dev/kvm detected"
    else
        warn "/dev/kvm is missing, check BIOS/UEFI virtualization settings"
    fi
}

configure_service_user() {
    step "Create service user"

    local useradd_cmd usermod_cmd
    useradd_cmd="$(command -v useradd || true)"
    usermod_cmd="$(command -v usermod || true)"

    [[ -n "$useradd_cmd" ]] || error "useradd is unavailable. Ensure package 'passwd' is installed before continuing."
    [[ -n "$usermod_cmd" ]] || error "usermod is unavailable. Ensure package 'passwd' is installed before continuing."

    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
        "$useradd_cmd" --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    fi

    getent group libvirt >/dev/null 2>&1 && "$usermod_cmd" -a -G libvirt "$SERVICE_USER" || true
    getent group libvirt-qemu >/dev/null 2>&1 && "$usermod_cmd" -a -G libvirt-qemu "$SERVICE_USER" || true
    getent group docker >/dev/null 2>&1 && "$usermod_cmd" -a -G docker "$SERVICE_USER" || true
    success "Service user ready: $SERVICE_USER"
}

create_data_dirs() {
    step "Create data directories"

    local dirs=(
        "$AUXINUX_DATA_DIR"
        "$AUXINUX_DATA_DIR/pools/local"
        "$AUXINUX_DATA_DIR/pools/isos"
        "$AUXINUX_DATA_DIR/pools/backups"
        "$AUXINUX_DATA_DIR/templates/lxc"
        "$AUXINUX_DATA_DIR/templates/docker"
        "$AUXINUX_DATA_DIR/images/vm-disks"
        "$AUXINUX_DATA_DIR/db"
        "$AUXINUX_DATA_DIR/ssl"
        "/var/lib/libvirt/images"
        "/var/lib/libvirt/images/isos"
        "/var/lib/lxc"
    )

    install -d -m 0755 "${dirs[@]}"
    chown -R root:root "$AUXINUX_DATA_DIR"
    chmod -R 0755 "$AUXINUX_DATA_DIR"
    chmod 0711 "$AUXINUX_DATA_DIR"
    fix_libvirt_storage_permissions
    success "Data directories are ready"
}

fix_libvirt_storage_permissions() {
    local qemu_user="" qemu_group=""
    local qemu_isos_dir="${QEMU_ISOS_DIR:-/var/lib/libvirt/images/isos}"
    local qemu_images_dir
    qemu_images_dir="$(dirname "$qemu_isos_dir")"

    if id libvirt-qemu >/dev/null 2>&1; then
        qemu_user="libvirt-qemu"
        qemu_group="libvirt-qemu"
    elif id qemu >/dev/null 2>&1; then
        qemu_user="qemu"
        qemu_group="qemu"
    fi

    if [[ -n "$qemu_group" ]]; then
        chown root:root "$AUXINUX_DATA_DIR" 2>/dev/null || true
        chmod 0711 "$AUXINUX_DATA_DIR" 2>/dev/null || true
        find "$AUXINUX_DATA_DIR/pools" -type d -exec chown root:"$qemu_group" {} \; -exec chmod 2775 {} \; 2>/dev/null || true
    else
        chmod 0711 "$AUXINUX_DATA_DIR" 2>/dev/null || true
        find "$AUXINUX_DATA_DIR/pools" -type d -exec chmod 0755 {} \; 2>/dev/null || true
    fi

    if [[ -n "$qemu_user" ]]; then
        find "$AUXINUX_DATA_DIR/pools" -type f \( -iname '*.qcow2' -o -iname '*.img' -o -iname '*.raw' -o -iname '*.vmdk' \) \
            -exec chown "$qemu_user:$qemu_group" {} \; -exec chmod 0660 {} \; 2>/dev/null || true
    else
        find "$AUXINUX_DATA_DIR/pools" -type f \( -iname '*.qcow2' -o -iname '*.img' -o -iname '*.raw' -o -iname '*.vmdk' \) \
            -exec chmod 0666 {} \; 2>/dev/null || true
    fi

    install -d -m 0755 "$qemu_images_dir" "$qemu_isos_dir" 2>/dev/null || true
    chown root:root "$qemu_images_dir" "$qemu_isos_dir" 2>/dev/null || true
    chmod 0755 "$qemu_images_dir" "$qemu_isos_dir" 2>/dev/null || true

    if [[ -n "$qemu_user" ]]; then
        find "$qemu_isos_dir" -type f \( -iname '*.iso' -o -iname '*.img' \) \
            -exec chown "$qemu_user:$qemu_group" {} \; -exec chmod 0640 {} \; 2>/dev/null || true
    else
        find "$qemu_isos_dir" -type f \( -iname '*.iso' -o -iname '*.img' \) \
            -exec chmod 0644 {} \; 2>/dev/null || true
    fi
}

append_once() {
    local file="$1"
    local line="$2"
    install -d -m 0755 "$(dirname "$file")"
    touch "$file"
    grep -qxF "$line" "$file" 2>/dev/null || printf '%s\n' "$line" >> "$file"
}

insert_apparmor_rule_before_profile_end() {
    local file="$1"
    local line="$2"
    [[ -f "$file" ]] || return 0
    grep -qxF "$line" "$file" 2>/dev/null && return 0
    python3 - "$file" "$line" <<'PY'
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
line = sys.argv[2]
text = path.read_text()
if line in text.splitlines():
    raise SystemExit(0)
idx = text.rfind("\n}")
if idx == -1:
    path.write_text(text.rstrip() + "\n" + line + "\n")
else:
    path.write_text(text[:idx] + "\n" + line + text[idx:])
PY
}

configure_libvirt_storage_apparmor() {
    step "Configure libvirt AppArmor storage access"

    # Debian/Ubuntu libvirt profiles can deny QEMU access to custom disk pools
    # even when Unix ownership is correct. Keep the broad access constrained to
    # Virtua-managed storage only.
    local pool_rule="  /var/lib/auxinuxvirtual/pools/** rwk,"
    local pool_dir_rule="  /var/lib/auxinuxvirtual/pools/**/ r,"
    local changed=0

    if [[ -d /etc/apparmor.d ]]; then
        if [[ -f /etc/apparmor.d/abstractions/libvirt-qemu ]]; then
            append_once /etc/apparmor.d/local/abstractions/libvirt-qemu "$pool_dir_rule"
            append_once /etc/apparmor.d/local/abstractions/libvirt-qemu "$pool_rule"
            if ! grep -q "local/abstractions/libvirt-qemu" /etc/apparmor.d/abstractions/libvirt-qemu 2>/dev/null; then
                append_once /etc/apparmor.d/abstractions/libvirt-qemu "$pool_dir_rule"
                append_once /etc/apparmor.d/abstractions/libvirt-qemu "$pool_rule"
            fi
            changed=1
        fi

        if [[ -f /etc/apparmor.d/usr.lib.libvirt.virt-aa-helper ]]; then
            append_once /etc/apparmor.d/local/usr.lib.libvirt.virt-aa-helper "$pool_dir_rule"
            append_once /etc/apparmor.d/local/usr.lib.libvirt.virt-aa-helper "$pool_rule"
            if ! grep -q "local/usr.lib.libvirt.virt-aa-helper" /etc/apparmor.d/usr.lib.libvirt.virt-aa-helper 2>/dev/null; then
                insert_apparmor_rule_before_profile_end /etc/apparmor.d/usr.lib.libvirt.virt-aa-helper "$pool_dir_rule"
                insert_apparmor_rule_before_profile_end /etc/apparmor.d/usr.lib.libvirt.virt-aa-helper "$pool_rule"
            fi
            changed=1
        fi
    fi

    if [[ "$changed" -eq 1 ]]; then
        systemctl reload apparmor.service >/dev/null 2>&1 || systemctl restart apparmor.service >/dev/null 2>&1 || true
        command -v apparmor_parser >/dev/null 2>&1 && {
            [[ -f /etc/apparmor.d/abstractions/libvirt-qemu ]] && apparmor_parser -r /etc/apparmor.d/abstractions/libvirt-qemu >/dev/null 2>&1 || true
            [[ -f /etc/apparmor.d/usr.lib.libvirt.virt-aa-helper ]] && apparmor_parser -r /etc/apparmor.d/usr.lib.libvirt.virt-aa-helper >/dev/null 2>&1 || true
        }
        systemctl restart virtqemud.service >/dev/null 2>&1 || true
        systemctl restart libvirtd.service >/dev/null 2>&1 || true
        success "Libvirt AppArmor rules allow Virtua storage pools"
    else
        info "No libvirt AppArmor profile detected; skipping"
    fi
}

install_node_modules() {
    step "Install Node.js dependencies"
    cd "$INSTALL_DIR"

    # If a node_modules tree was copied over from another machine (e.g. a
    # developer's macOS workstation), the prebuilt native binaries inside it
    # are Mach-O / wrong-ABI and will fail at runtime with:
    #     "invalid ELF header"
    # `npm install --prefer-offline` does NOT detect this — it sees the
    # package already extracted and skips re-extraction. Wipe the native
    # module dirs up-front so npm freshly re-extracts the right prebuilds
    # (or falls through to the source build below).
    info "Clearing native module trees to avoid cross-platform binaries"
    rm -rf node_modules/argon2 node_modules/better-sqlite3 node_modules/node-pty \
           apps/api/node_modules/argon2 apps/api/node_modules/better-sqlite3 \
           apps/api/node_modules/node-pty 2>/dev/null || true

    npm install --no-audit --prefer-offline

    # Re-run native lifecycle scripts after extraction. npm 12 removed the
    # legacy --build-from-source CLI config and blocks unapproved dependency
    # scripts; package.json pins the reviewed scripts in allowScripts. Each
    # module uses a matching prebuild when available and falls back to node-gyp.
    info "Rebuilding native modules against $(node --version)"
    if ! npm rebuild argon2 better-sqlite3 node-pty 2>&1 | tail -5; then
        error "Failed to rebuild native modules. Check npm allowScripts and that build-essential, python3 and g++ are installed."
    fi

    local mod
    for mod in argon2 better-sqlite3 node-pty; do
        node -e "require('${mod}')" >/dev/null 2>&1 \
            || error "Native module ${mod} still fails to load after rebuild — see logs above."
        success "Native module loads: ${mod}"
    done
}

build_project() {
    step "Build project"
    cd "$INSTALL_DIR"

    rm -rf apps/api/dist apps/runner/dist apps/ui/dist apps/cli/dist packages/shared/dist
    npm run build
    success "Build completed"
}

install_cli_binary() {
    step "Install CLI"
    install -d -m 0755 /usr/bin
    ln -sf "${INSTALL_DIR}/apps/cli/dist/cli.js" /usr/bin/virtua
    chmod 0755 "${INSTALL_DIR}/apps/cli/dist/cli.js" /usr/bin/virtua

    if [[ -d /usr/local/bin ]] || mkdir -p /usr/local/bin 2>/dev/null; then
        ln -sf /usr/bin/virtua /usr/local/bin/virtua 2>/dev/null || true
    fi

    success "CLI installed: /usr/bin/virtua"
}

write_env_file() {
    step "Configure environment"
    local env_file="$INSTALL_DIR/apps/api/.env"
    local session_secret existing_port existing_data_dir existing_runner_sock existing_qemu_isos_dir existing_lxc_templates_dir existing_docker_archives_dir existing_vm_disks_dir existing_node_env
    session_secret="$(read_env_value "$env_file" "AUXINUX_SESSION_SECRET")"
    existing_port="$(read_env_value "$env_file" "AUXINUX_PORT")"
    existing_data_dir="$(read_env_value "$env_file" "AUXINUX_DATA_DIR")"
    existing_runner_sock="$(read_env_value "$env_file" "AUXINUX_RUNNER_SOCK")"
    existing_qemu_isos_dir="$(read_env_value "$env_file" "QEMU_ISOS_DIR")"
    existing_lxc_templates_dir="$(read_env_value "$env_file" "LXC_TEMPLATES_DIR")"
    existing_docker_archives_dir="$(read_env_value "$env_file" "DOCKER_ARCHIVES_DIR")"
    existing_vm_disks_dir="$(read_env_value "$env_file" "VM_DISKS_DIR")"
    existing_node_env="$(read_env_value "$env_file" "NODE_ENV")"

    session_secret="${session_secret:-$(openssl rand -hex 48)}"
    local env_port="${existing_port:-$AUXINUX_PORT}"
    local env_data_dir="${existing_data_dir:-$AUXINUX_DATA_DIR}"
    local env_runner_sock="${existing_runner_sock:-$AUXINUX_RUNNER_SOCK}"
    local env_qemu_isos_dir="${existing_qemu_isos_dir:-/var/lib/libvirt/images/isos}"
    local env_lxc_templates_dir="${existing_lxc_templates_dir:-${env_data_dir}/templates/lxc}"
    local env_docker_archives_dir="${existing_docker_archives_dir:-${env_data_dir}/templates/docker}"
    local env_vm_disks_dir="${existing_vm_disks_dir:-${env_data_dir}/images/vm-disks}"
    local env_node_env="${existing_node_env:-production}"

    if [[ -f "$env_file" ]]; then
        info "Updating existing .env file"
        backup_file_if_exists "$env_file"
    else
        info "Creating .env file"
    fi

    cat > "$env_file" <<EOF
# AuxiNux API — configuration
AUXINUX_PORT=${env_port}
AUXINUX_DATA_DIR=${env_data_dir}
AUXINUX_RUNNER_SOCK=${env_runner_sock}
AUXINUX_SESSION_SECRET=${session_secret}
AUXINUX_MAX_URL_DOWNLOADS=${AUXINUX_MAX_URL_DOWNLOADS:-3}
QEMU_ISOS_DIR=${env_qemu_isos_dir}
LXC_TEMPLATES_DIR=${env_lxc_templates_dir}
DOCKER_ARCHIVES_DIR=${env_docker_archives_dir}
VM_DISKS_DIR=${env_vm_disks_dir}
NODE_ENV=${env_node_env}
EOF
    chmod 0600 "$env_file"
}

write_systemd_units() {
    step "Create systemd units"

    backup_file_if_exists /etc/systemd/system/auxinuxvirtual-runner.service
    # IMPORTANT: paths are wrapped in double quotes so systemd does not split
    # them on whitespace. Required whenever INSTALL_DIR contains a space
    # (e.g. "AuxiNux Controle Virtua") — otherwise node receives the first
    # word only and fails with "Cannot find module".
    cat > /etc/systemd/system/auxinuxvirtual-runner.service <<EOF
[Unit]
Description=AuxiNux Runner
After=network-online.target docker.service libvirtd.service virtqemud.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}/apps/runner
ExecStart=/usr/bin/node "${INSTALL_DIR}/apps/runner/dist/runner.js"
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
Environment=AUXINUX_RUNNER_SOCK=${AUXINUX_RUNNER_SOCK}
RuntimeDirectory=auxinuxvirtual
RuntimeDirectoryMode=0750
LimitNOFILE=65536
LimitNPROC=8192
NoNewPrivileges=false
ProtectSystem=no
PrivateTmp=no

[Install]
WantedBy=multi-user.target
EOF

    backup_file_if_exists /etc/systemd/system/auxinuxvirtual-api.service
    cat > /etc/systemd/system/auxinuxvirtual-api.service <<EOF
[Unit]
Description=AuxiNux API
After=network-online.target auxinuxvirtual-runner.service
Wants=network-online.target
Requires=auxinuxvirtual-runner.service

[Service]
Type=simple
User=root
Group=root
WorkingDirectory=${INSTALL_DIR}/apps/api
EnvironmentFile=${INSTALL_DIR}/apps/api/.env
ExecStart=/usr/bin/node "${INSTALL_DIR}/apps/api/dist/server.js"
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
StandardOutput=journal
StandardError=journal
SyslogIdentifier=auxinuxvirtual-api
LimitNOFILE=65536
LimitNPROC=8192
# The API owns the host maintenance PTY. Keep setuid helpers available so
# root shell commands such as apt, su, kernel packages and Debian package hooks
# work normally from the web maintenance terminal.
NoNewPrivileges=false
ProtectKernelTunables=false
ProtectKernelModules=false
ProtectClock=true
RestrictSUIDSGID=false

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    success "Systemd units created"
}

configure_firewall() {
    step "Configure firewall"

    if command -v ufw >/dev/null 2>&1; then
        ufw allow "${AUXINUX_PORT}/tcp" comment "AuxiNux Web UI" >/dev/null 2>&1 || true
        ufw allow 22/tcp comment "SSH" >/dev/null 2>&1 || true
        ufw allow 80/tcp comment "AuxiNux HTTP (Let's Encrypt challenge + redirect)" >/dev/null 2>&1 || true
        ufw allow 443/tcp comment "AuxiNux HTTPS" >/dev/null 2>&1 || true
        ufw allow 3389/tcp comment "AuxiNux RDP Remote console" >/dev/null 2>&1 || true
        info "Opened ${AUXINUX_PORT}/tcp, 80/tcp, 443/tcp, 3389/tcp via ufw"
    else
        iptables -C INPUT -p tcp --dport "${AUXINUX_PORT}" -j ACCEPT >/dev/null 2>&1 \
            || iptables -I INPUT -p tcp --dport "${AUXINUX_PORT}" -j ACCEPT >/dev/null 2>&1 || true
        iptables -C INPUT -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1 \
            || iptables -I INPUT -p tcp --dport 80 -j ACCEPT >/dev/null 2>&1 || true
        iptables -C INPUT -p tcp --dport 443 -j ACCEPT >/dev/null 2>&1 \
            || iptables -I INPUT -p tcp --dport 443 -j ACCEPT >/dev/null 2>&1 || true
        iptables -C INPUT -p tcp --dport 3389 -j ACCEPT >/dev/null 2>&1 \
            || iptables -I INPUT -p tcp --dport 3389 -j ACCEPT >/dev/null 2>&1 || true
        info "Added iptables rules for ${AUXINUX_PORT}/tcp, 80/tcp, 443/tcp, 3389/tcp"
    fi
}

start_auxinux_services() {
    step "Start AuxiNux services"
    systemctl enable auxinuxvirtual-runner auxinuxvirtual-api >/dev/null 2>&1
    systemctl restart auxinuxvirtual-runner

    info "Waiting for runner socket..."
    local i
    for i in $(seq 1 20); do
        [[ -S "$AUXINUX_RUNNER_SOCK" ]] && break
        sleep 1
    done

    [[ -S "$AUXINUX_RUNNER_SOCK" ]] || warn "Runner socket not detected: $AUXINUX_RUNNER_SOCK"
    systemctl restart auxinuxvirtual-api
    info "Running deployed Virtua version: ${PROJECT_VERSION}"
}

final_summary() {
    step "Final verification"
    sleep 3

    local api_status runner_status server_ip
    api_status="$(systemctl is-active auxinuxvirtual-api 2>/dev/null || echo failed)"
    runner_status="$(systemctl is-active auxinuxvirtual-runner 2>/dev/null || echo failed)"
    server_ip="$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)"
    server_ip="${server_ip:-<SERVER-IP>}"

    echo -e "${BOLD}"
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║         AuxiNux Virtua Control — Installation OK            ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo -e "  Runner   : $( [[ "$runner_status" == "active" ]] && echo "${GREEN}active${NC}" || echo "${RED}${runner_status}${NC}" )"
    echo -e "  API      : $( [[ "$api_status" == "active" ]] && echo "${GREEN}active${NC}" || echo "${RED}${api_status}${NC}" )"
    echo ""
    echo -e "  ${BOLD}Web interface${NC}  : http://${server_ip}:${AUXINUX_PORT}"
    echo -e "  ${BOLD}HTTPS (SSL)${NC}    : https://${server_ip}  (configurable via Paramètres → SSL)"
    echo -e "  ${BOLD}Credentials${NC}    : admin / admin123"
    echo -e "  ${BOLD}Docker${NC}         : $(docker --version 2>/dev/null || echo missing)"
    echo -e "  ${BOLD}Compose${NC}        : $(docker compose version 2>/dev/null | head -1 || echo missing)"
    echo -e "  ${BOLD}Node.js${NC}        : $(node --version 2>/dev/null || echo missing)"
    echo -e "  ${BOLD}Virtua${NC}         : ${PROJECT_VERSION}"
    echo ""
    echo "  Logs runner  : journalctl -fu auxinuxvirtual-runner"
    echo "  Logs API     : journalctl -fu auxinuxvirtual-api"
    echo "  Restart      : systemctl restart auxinuxvirtual-runner auxinuxvirtual-api"
    echo ""

    if [[ "$api_status" != "active" ]]; then
        warn "The API did not start correctly"
        journalctl -u auxinuxvirtual-api --no-pager -n 50 || true
    fi
}

main() {
    parse_args "$@"
    detect_project_version
    require_root
    ensure_apt_prereqs
    validate_platform
    validate_release_sources
    apply_mode_preflight

    step "Update system packages"
    apt-get update -qq "${APT_LOCK_OPT[@]}"
    "${APT_GET[@]}" upgrade >/dev/null 2>&1 || warn "System upgrade was only partially completed"

    install_system_packages
    install_docker_stack
    install_node_stack
    configure_kernel_and_runtime
    configure_lxc_networking
    ensure_vmbr0_bridge
    refresh_netguard_service
    install_bridge_heal_service
    configure_services
    configure_virtualization_networking
    configure_service_user
    create_data_dirs
    configure_libvirt_storage_apparmor
    if [[ "$MODE" == "install" || "$MODE" == "update" ]]; then
        stop_auxinux_services_if_present
    fi
    install_node_modules
    build_project
    install_cli_binary
    write_env_file
    write_systemd_units
    configure_firewall
    start_auxinux_services
    final_summary
    write_install_completion_marker
    PROGRESS_STEP="${PROGRESS_TOTAL}"
    write_progress done "Installation completed"
    success "Installation completed"
}

main "$@"
