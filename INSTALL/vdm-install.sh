#!/usr/bin/env bash
# =============================================================================
# AuxiNux VDM (Virtua Datacenter Manager) - Unified Installer
#
# Host mode (default):
#   - Creates/provisions a Debian 13 LXC container
#   - Enables LXC autostart on host reboot
#   - Copies this release into the container
#   - Installs and configures VDM inside the container
#
# In-container mode (--inside-lxc):
#   - Installs all VDM runtime/build dependencies
#   - Builds and configures VDM service + firewall
# =============================================================================
set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()    { echo -e "\n${BOLD}${BLUE}== $*${NC}"; }

# Shared config
VDM_PORT="${VDM_PORT:-8440}"
VDM_DATA_DIR="/var/lib/auxinux-vdm"
NODE_MAJOR=22
SERVICE_USER="auxinux-vdm"
PROJECT_VERSION="unknown"

# Host/LXC provisioning config
LXC_NAME="${LXC_NAME:-auxinux-vdm}"
LXC_DIST="${LXC_DIST:-debian}"
LXC_RELEASE="${LXC_RELEASE:-trixie}"
LXC_ARCH="${LXC_ARCH:-amd64}"
LXC_BRIDGE="${LXC_BRIDGE:-vmbr0}"
LXC_IPV4="${LXC_IPV4:-dhcp}"            # dhcp OR e.g. 192.168.1.50/24
LXC_GATEWAY="${LXC_GATEWAY:-}"          # required if LXC_IPV4 is static
LXC_IP_MODE="${LXC_IP_MODE:-}"          # dhcp-reserved | --- empty string for staticor DHCP
LXC_PATH_BASE="/var/lib/lxc"
LXC_ROOT_DIR=""
HA_CONFIG_FILE="/etc/auxinux-vdm/ha.conf"
VDM_HA_LXC_PATH="${VDM_HA_LXC_PATH:-}"
VDM_HA_RESOURCE="${VDM_HA_RESOURCE:-auxinux-vdm}"
VDM_HA_BRIDGE="${VDM_HA_BRIDGE:-}"

if [[ -r "$HA_CONFIG_FILE" ]]; then
    # Root-owned configuration written by this installer.
    # shellcheck disable=SC1090
    source "$HA_CONFIG_FILE"
    [[ -n "${VDM_HA_LXC_PATH:-}" ]] && LXC_PATH_BASE="$VDM_HA_LXC_PATH"
fi

# Installer behavior
MODE="install"
INSIDE_LXC=0
YES=0
ENABLE_HA_AFTER_INSTALL=0
TARGET_NODE=""
CLUSTER_LOCK_HELD=0
CLUSTER_LOCK_HOLDER="$(hostname -s 2>/dev/null || echo node)-vdm-$$"
CLUSTER_LOCKED_REMOTES=""
FIREWALL_ENABLED="${VDM_FIREWALL_ENABLED:-1}"
INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTO_INSTALL_HOST_REQS="${AUTO_INSTALL_HOST_REQS:-}"

# Bootstrap wizard values (collected on host, applied in-container)
BOOTSTRAP_DATACENTER_NAME="${BOOTSTRAP_DATACENTER_NAME:-AuxiNux Datacenter}"
BOOTSTRAP_ADMIN_USERNAME="${BOOTSTRAP_ADMIN_USERNAME:-admin}"
BOOTSTRAP_ADMIN_PASSWORD="${BOOTSTRAP_ADMIN_PASSWORD:-admin123}"
BOOTSTRAP_NODE_NAME="${BOOTSTRAP_NODE_NAME:-node1}"
BOOTSTRAP_NODE_DISPLAY_NAME="${BOOTSTRAP_NODE_DISPLAY_NAME:-Node 1}"
BOOTSTRAP_NODE_API_URL="${BOOTSTRAP_NODE_API_URL:-}"
BOOTSTRAP_NODE_AUTH_TOKEN="${BOOTSTRAP_NODE_AUTH_TOKEN:-}"
BOOTSTRAP_NODE_ENABLED="${BOOTSTRAP_NODE_ENABLED:-1}"
BOOTSTRAP_APPLY="${BOOTSTRAP_APPLY:-0}"

REQUIRED_RELEASE_FILES=(
    "apps/vdm/src/server.ts"
    "apps/vdm/src/db.ts"
    "apps/vdm/package.json"
    "apps/vdm-ui/src/App.tsx"
    "apps/vdm-ui/package.json"
    "packages/shared/src/types/vm.ts"
    "packages/shared/src/types/user.ts"
    "INSTALL/vdm-install.sh"
)

export DEBIAN_FRONTEND=noninteractive
APT_GET=(apt-get -y -qq -o Dpkg::Use-Pty=0)

show_help() {
    cat <<'EOF'
AuxiNux VDM installer

Usage:
  bash INSTALL/vdm-install.sh                    # Host mode: create LXC + install VDM in it
  bash INSTALL/vdm-install.sh -update            # Update VDM in existing LXC
  bash INSTALL/vdm-install.sh -repair            # Repair runtime/build artifacts in existing LXC
  bash INSTALL/vdm-install.sh -reset             # Recreate LXC and reinstall VDM from scratch
  bash INSTALL/vdm-install.sh --uninstall         # Remove the managed VDM LXC
  bash INSTALL/vdm-install.sh --status            # Cluster placement, health and HA state
  bash INSTALL/vdm-install.sh --movenode --target-node=<host>
  bash INSTALL/vdm-install.sh -h                 # Show help

Advanced host options:
  --lxc-name=<name>                              # default: auxinux-vdm
  --lxc-bridge=<bridge>                          # default: vmbr0
  --lxc-ipv4=dhcp|<ip/cidr>                      # default: dhcp
  --lxc-gateway=<ip>                             # required with static --lxc-ipv4
  --no-firewall                                  # do not configure nftables in the VDM container
  --enable-ha                                    # enable HA after installation (validated prerequisites)
  --auto-install-host-reqs                       # auto-install missing host prerequisites without prompt

Internal option (do not use directly from host unless needed):
  --inside-lxc                                   # run only in-container install steps

Environment variables (optional):
  LXC_NAME, LXC_BRIDGE, LXC_IPV4, LXC_GATEWAY, VDM_PORT,
    AUXINUX_VDM_SESSION_SECRET, VDM_FIREWALL_ENABLED, AUTO_INSTALL_HOST_REQS

Wizard behavior:
    During host installation, the script asks for:
    - Datacenter name
    - VDM admin username/password
    - Node 1 API URL and auth token
    - Fixed-IP policy checks (host and LXC)
    It then pre-seeds VDM so the host is already registered as Node 1.
EOF
}

set_mode() {
    local new_mode="$1"
    if [[ "$MODE" != "install" && "$MODE" != "$new_mode" ]]; then
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
            --install)
                set_mode "install"
                ;;
            --uninstall)
                set_mode "uninstall"
                ;;
            --status)
                set_mode "status"
                ;;
            --movenode)
                set_mode "movenode"
                ;;
            --ha-enable)
                set_mode "ha-enable"
                ;;
            --ha-disable)
                set_mode "ha-disable"
                ;;
            --ha-status)
                set_mode "ha-status"
                ;;
            --target-node=*)
                TARGET_NODE="${arg#*=}"
                ;;
            --enable-ha)
                ENABLE_HA_AFTER_INSTALL=1
                ;;
            -y|--yes)
                YES=1
                ;;
            --inside-lxc)
                INSIDE_LXC=1
                ;;
            --lxc-name=*)
                LXC_NAME="${arg#*=}"
                ;;
            --lxc-bridge=*)
                LXC_BRIDGE="${arg#*=}"
                ;;
            --lxc-ipv4=*)
                LXC_IPV4="${arg#*=}"
                ;;
            --lxc-gateway=*)
                LXC_GATEWAY="${arg#*=}"
                ;;
            --no-firewall)
                FIREWALL_ENABLED="0"
                ;;
            --auto-install-host-reqs)
                AUTO_INSTALL_HOST_REQS="1"
                ;;
            "")
                ;;
            *)
                error "Unknown argument: $arg. Use -h for help."
                ;;
        esac
    done

    if [[ -z "$LXC_NAME" ]]; then
        error "LXC name cannot be empty"
    fi
    if [[ ! "$LXC_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
        error "Invalid LXC name '$LXC_NAME' (allowed: letters, digits, dot, underscore and dash)"
    fi
    LXC_ROOT_DIR="${LXC_PATH_BASE}/${LXC_NAME}"
}

cleanup_tmp() {
    rm -f /tmp/vdm-install.err /tmp/vdm-install.out 2>/dev/null || true
    release_cluster_install_lock || true
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
        error "Extracted project is incomplete. Recreate the archive with INSTALL/release.sh -vdm and rerun installer."
    fi

    info "Detected VDM version: ${PROJECT_VERSION}"
    success "Release content validation passed"
}

require_root() {
    if [[ $EUID -ne 0 ]]; then
        error "This script must be run as root"
    fi
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-y}"
    local answer
    local hint="[y/N]"
    if [[ "$default" == "y" ]]; then
        hint="[Y/n]"
    fi
    read -r -p "$prompt $hint " answer || true
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[Yy]$ ]]
}

prompt_value() {
    local prompt="$1"
    local default="${2:-}"
    local answer
    if [[ -n "$default" ]]; then
        read -r -p "$prompt [$default]: " answer || true
        echo "${answer:-$default}"
    else
        read -r -p "$prompt: " answer || true
        echo "$answer"
    fi
}

prompt_secret() {
    local prompt="$1"
    local answer
    read -r -s -p "$prompt: " answer || true
    echo
    echo "$answer"
}

detect_host_primary_ip() {
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
}

detect_host_primary_iface() {
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}'
}

detect_host_gateway() {
    ip -4 route show default 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="via") {print $(i+1); exit}}'
}

virtua_db_path() {
    if [[ -n "${AUXINUX_NODE_DB_PATH:-}" ]]; then
        echo "$AUXINUX_NODE_DB_PATH"
    elif [[ -f /var/lib/auxinuxvirtual/db/auxinux.sqlite ]]; then
        echo /var/lib/auxinuxvirtual/db/auxinux.sqlite
    else
        echo /var/lib/auxinux/db/auxinux.sqlite
    fi
}

cluster_mode() {
    local db_path
    db_path="$(virtua_db_path)"
    [[ -f "$db_path" ]] || { echo standalone; return; }
    sqlite3 "$db_path" "SELECT COALESCE((SELECT value FROM settings WHERE key='datacenter.mode'),'standalone');" 2>/dev/null || echo standalone
}

cluster_remote_nodes() {
    local db_path
    db_path="$(virtua_db_path)"
    [[ -f "$db_path" ]] || return 0
    sqlite3 -separator '|' "$db_path" "SELECT name, rtrim(api_url,'/'), auth_token FROM datacenter_nodes WHERE enabled=1 AND is_local=0 AND api_url IS NOT NULL AND api_url!='' AND auth_token IS NOT NULL AND auth_token!='' ORDER BY name;" 2>/dev/null || true
}

cluster_unverifiable_node_count() {
    local db_path
    db_path="$(virtua_db_path)"
    [[ -f "$db_path" ]] || { echo 0; return; }
    sqlite3 "$db_path" "SELECT COUNT(*) FROM datacenter_nodes WHERE enabled=1 AND is_local=0 AND (api_url IS NULL OR api_url='' OR auth_token IS NULL OR auth_token='');" 2>/dev/null || echo 0
}

check_cluster_has_single_vdm() {
    step "Verify unique VDM placement in cluster"
    local mode row name api_url token response_file code
    mode="$(cluster_mode)"

    if [[ "$mode" == "datacenter" && "$(cluster_unverifiable_node_count)" != "0" ]]; then
        error "Some enabled cluster nodes have no API URL or authentication token. Installation is blocked until every node can confirm VDM placement."
    fi

    if lxc_exists; then
        error "VDM is already installed on this node. Use 'vos vdm update', 'status' or 'movenode'."
    fi
    local db_path manager_url
    db_path="$(virtua_db_path)"
    manager_url=""
    [[ -f "$db_path" ]] && manager_url="$(sqlite3 "$db_path" "SELECT COALESCE((SELECT value FROM settings WHERE key='vdm.managerApiUrl'),'');" 2>/dev/null || true)"
    [[ -z "$manager_url" ]] || error "This node is already registered to VDM at ${manager_url}. Use 'vos vdm status' or move the existing VDM."

    while IFS='|' read -r name api_url token; do
        [[ -n "$name" ]] || continue
        response_file="$(mktemp)"
        code="$(curl -k -sS --connect-timeout 4 --max-time 10 -o "$response_file" -w '%{http_code}' \
            -H "x-auxinux-node-token: ${token}" "${api_url}/api/internal/vdm-host-status" || true)"
        if [[ "$code" != "200" ]]; then
            rm -f "$response_file"
            error "Cannot verify VDM placement on cluster node '${name}' (${api_url}, HTTP ${code:-unreachable}). Installation is blocked to prevent a second VDM."
        fi
        if grep -Eq '"vdmInstalled"[[:space:]]*:[[:space:]]*true|"joined"[[:space:]]*:[[:space:]]*true' "$response_file"; then
            local detail
            detail="$(tr -d '\n' < "$response_file" | cut -c1-300)"
            rm -f "$response_file"
            error "Cluster node '${name}' already reports a VDM (${detail}). Use 'vos vdm movenode', never a second install."
        fi
        rm -f "$response_file"
    done < <(cluster_remote_nodes)

    if [[ "$mode" == "datacenter" ]]; then
        success "Every reachable cluster node confirms that no VDM exists"
    else
        success "Standalone node confirms that no local VDM exists"
    fi
}

acquire_cluster_install_lock() {
    step "Acquire cluster-wide VDM installation lock"
    local db_path expires payload name api_url token response_file code
    db_path="$(virtua_db_path)"
    expires="$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)"
    payload="{\"holder\":\"${CLUSTER_LOCK_HOLDER}\",\"expiresAt\":\"${expires}\"}"
    CLUSTER_LOCKED_REMOTES="/tmp/vdm-locked-remotes.$$"
    : > "$CLUSTER_LOCKED_REMOTES"

    if [[ -f "$db_path" ]]; then
        local stored_holder
        stored_holder="$(sqlite3 "$db_path" "BEGIN IMMEDIATE; DELETE FROM settings WHERE key='vdm.installLock' AND COALESCE(json_extract(value,'$.expiresAt'),'') <= strftime('%Y-%m-%dT%H:%M:%SZ','now'); INSERT INTO settings(key,value,updated_at) SELECT 'vdm.installLock','${payload}',datetime('now') WHERE NOT EXISTS(SELECT 1 FROM settings WHERE key='vdm.installLock'); COMMIT; SELECT COALESCE(json_extract(value,'$.holder'),'') FROM settings WHERE key='vdm.installLock';")"
        [[ "$stored_holder" == "$CLUSTER_LOCK_HOLDER" ]] || error "Another VDM operation owns the local cluster lock (${stored_holder:-unknown holder})"
    fi
    CLUSTER_LOCK_HELD=1

    while IFS='|' read -r name api_url token; do
        [[ -n "$name" ]] || continue
        response_file="$(mktemp)"
        code="$(curl -k -sS --connect-timeout 4 --max-time 10 -o "$response_file" -w '%{http_code}' \
            -X POST -H "x-auxinux-node-token: ${token}" -H 'content-type: application/json' \
            --data "{\"action\":\"acquire\",\"holder\":\"${CLUSTER_LOCK_HOLDER}\",\"ttlSeconds\":7200}" \
            "${api_url}/api/internal/vdm-install-lock" || true)"
        if [[ "$code" != "200" ]]; then
            local detail
            detail="$(tr -d '\n' < "$response_file" | cut -c1-300)"
            rm -f "$response_file"
            error "Unable to lock cluster node '${name}' (HTTP ${code:-unreachable}): ${detail}"
        fi
        printf '%s|%s|%s\n' "$name" "$api_url" "$token" >> "$CLUSTER_LOCKED_REMOTES"
        rm -f "$response_file"
    done < <(cluster_remote_nodes)
    success "Cluster-wide VDM lock acquired by ${CLUSTER_LOCK_HOLDER}"
}

release_cluster_install_lock() {
    [[ "$CLUSTER_LOCK_HELD" == "1" ]] || return 0
    local db_path name api_url token
    db_path="$(virtua_db_path)"
    if [[ -f "$db_path" ]]; then
        sqlite3 "$db_path" "DELETE FROM settings WHERE key='vdm.installLock';" 2>/dev/null || true
    fi
    if [[ -n "$CLUSTER_LOCKED_REMOTES" && -f "$CLUSTER_LOCKED_REMOTES" ]]; then
        while IFS='|' read -r name api_url token; do
            curl -k -fsS --connect-timeout 2 --max-time 5 -X POST \
                -H "x-auxinux-node-token: ${token}" -H 'content-type: application/json' \
                --data "{\"action\":\"release\",\"holder\":\"${CLUSTER_LOCK_HOLDER}\"}" \
                "${api_url}/api/internal/vdm-install-lock" >/dev/null 2>&1 || true
        done < "$CLUSTER_LOCKED_REMOTES"
        rm -f "$CLUSTER_LOCKED_REMOTES"
    fi
    CLUSTER_LOCK_HELD=0
}

host_iface_looks_dynamic() {
    local iface="$1"
    ip -4 -o addr show dev "$iface" 2>/dev/null | grep -qE ' dynamic( |$)'
}

enforce_host_fixed_ip_policy() {
    step "Validate host fixed IP policy"

    local iface host_ip gateway
    iface="$(detect_host_primary_iface)"
    host_ip="$(detect_host_primary_ip)"
    gateway="$(detect_host_gateway)"

    [[ -n "$iface" ]] || error "Unable to detect host primary network interface"
    [[ -n "$host_ip" ]] || error "Unable to detect host primary IPv4 address"

    info "Host network: iface=${iface} ip=${host_ip} gw=${gateway:-unknown}"

    if host_iface_looks_dynamic "$iface"; then
        warn "Host IP appears dynamic (DHCP lease)."
        if prompt_yes_no "Is this DHCP address reserved/fixed on your DHCP server?" "n"; then
            success "Host fixed-IP policy accepted (DHCP reservation confirmed)"
            return 0
        fi

        warn "VDM orchestration requires stable addressing for host and nodes."
        warn "Suggested static example:"
        echo "  Interface: $iface"
        echo "  Address  : ${host_ip}/24"
        echo "  Gateway  : ${gateway:-<set-gateway>}"
        error "Configure a fixed host IP (static or DHCP reservation), then rerun installer."
    fi

    success "Host IP appears fixed"
}

collect_lxc_network_policy() {
    if [[ "$MODE" != "install" && "$MODE" != "reset" ]]; then
        return 0
    fi

    step "Validate LXC fixed IP policy"

    if [[ "$LXC_IPV4" != "dhcp" ]]; then
        if [[ -z "$LXC_GATEWAY" ]]; then
            LXC_GATEWAY="$(prompt_value "LXC gateway" "$(detect_host_gateway)")"
            [[ -n "$LXC_GATEWAY" ]] || error "LXC gateway is required for static LXC IP"
        fi
        success "LXC static IP configured: ${LXC_IPV4} via ${LXC_GATEWAY}"
        return 0
    fi

    warn "LXC is configured for DHCP by default. VDM requires stable IPs."
    if prompt_yes_no "Will DHCP provide a fixed reservation for LXC '${LXC_NAME}'?" "n"; then
        LXC_IP_MODE="dhcp-reserved"
        success "LXC fixed-IP policy accepted (DHCP reservation confirmed)"
        return 0
    fi

    info "Configure a static IPv4 for the VDM LXC now."
    local suggested_ip
    suggested_ip="$(prompt_value "LXC IPv4 CIDR (example 192.168.1.50/24)" "")"
    [[ -n "$suggested_ip" ]] || error "Static LXC IP is required if DHCP reservation is not used"

    LXC_IPV4="$suggested_ip"
    LXC_GATEWAY="$(prompt_value "LXC gateway" "$(detect_host_gateway)")"
    [[ -n "$LXC_GATEWAY" ]] || error "LXC gateway is required for static LXC IP"

    success "LXC static IP set to ${LXC_IPV4} via ${LXC_GATEWAY}"
}

detect_local_node_token_from_host() {
    if ! command -v sqlite3 >/dev/null 2>&1; then
        return 0
    fi
    # Probe the known Virtua data-dir locations, newest convention first.
    #  - /var/lib/auxinuxvirtual : the path install.sh forces (AUXINUX_DATA_DIR)
    #  - /var/lib/auxinux        : the API source-code default (dev/legacy)
    # AUXINUX_NODE_DB_PATH (explicit override) always wins when provided.
    local candidates=()
    [[ -n "${AUXINUX_NODE_DB_PATH:-}" ]] && candidates+=("$AUXINUX_NODE_DB_PATH")
    candidates+=(
        "/var/lib/auxinuxvirtual/db/auxinux.sqlite"
        "/var/lib/auxinux/db/auxinux.sqlite"
    )
    local db_path token
    for db_path in "${candidates[@]}"; do
        [[ -f "$db_path" ]] || continue
        token="$(sqlite3 "$db_path" "SELECT value FROM settings WHERE key = 'datacenter.nodeAuthToken' LIMIT 1;" 2>/dev/null || true)"
        if [[ -n "$token" ]]; then
            echo "$token"
            return 0
        fi
    done
    return 0
}

collect_bootstrap_wizard() {
    if [[ "$MODE" != "install" && "$MODE" != "reset" ]]; then
        BOOTSTRAP_APPLY="0"
        return 0
    fi

    step "VDM bootstrap wizard"
    info "This wizard will pre-configure VDM with datacenter name, fixed admin credentials and host node registration."

    local host_ip detected_token enabled_node
    host_ip="$(detect_host_primary_ip)"
    detected_token="$(detect_local_node_token_from_host)"

    # ---- prompts requis : datacenter name only ----
    BOOTSTRAP_DATACENTER_NAME="$(prompt_value "Datacenter name" "$BOOTSTRAP_DATACENTER_NAME")"
    BOOTSTRAP_ADMIN_USERNAME="admin"
    BOOTSTRAP_ADMIN_PASSWORD="admin123"

    # ---- auto-détection du Node local (même host) ----
    local auto_hostname
    auto_hostname="$(hostname -s 2>/dev/null || echo "node1")"
    [[ -z "$BOOTSTRAP_NODE_NAME" ]]         && BOOTSTRAP_NODE_NAME="$auto_hostname"
    [[ -z "$BOOTSTRAP_NODE_DISPLAY_NAME" ]] && BOOTSTRAP_NODE_DISPLAY_NAME="$(hostname 2>/dev/null || echo "Node 1")"
    BOOTSTRAP_NODE_API_URL="http://${host_ip:-127.0.0.1}:8441"

    if [[ -n "$detected_token" ]]; then
        BOOTSTRAP_NODE_AUTH_TOKEN="$detected_token"
        BOOTSTRAP_NODE_ENABLED="1"
    else
        warn "Could not auto-detect node auth token from host DB — node will be created disabled."
        BOOTSTRAP_NODE_AUTH_TOKEN="MISSING_TOKEN"
        BOOTSTRAP_NODE_ENABLED="0"
    fi

    enabled_node="disabled"
    [[ "$BOOTSTRAP_NODE_ENABLED" == "1" ]] && enabled_node="enabled (auto-detected)"

    info "Wizard summary:"
    echo "  Datacenter : $BOOTSTRAP_DATACENTER_NAME"
    echo "  Admin user : $BOOTSTRAP_ADMIN_USERNAME"
    echo "  Admin pass : admin123"
    echo "  Node 1     : $BOOTSTRAP_NODE_NAME ($BOOTSTRAP_NODE_DISPLAY_NAME)  [auto-detected]"
    echo "  Node URL   : $BOOTSTRAP_NODE_API_URL  [auto-detected]"
    echo "  Node state : $enabled_node"

    if ! prompt_yes_no "Apply this bootstrap configuration?" "y"; then
        warn "Bootstrap wizard skipped. VDM will use default first-boot behavior."
        BOOTSTRAP_APPLY="0"
        return 0
    fi

    BOOTSTRAP_APPLY="1"
    success "Bootstrap configuration captured"
}

# ------------------------------
# Host mode (LXC provisioning)
# ------------------------------

install_host_lxc_requirements() {
    step "Validate host prerequisites"

    local missing=()
    for cmd in lxc-create lxc-attach lxc-start lxc-stop lxc-info debootstrap ip tar curl sqlite3 rsync; do
        command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
    done

    if [[ ${#missing[@]} -eq 0 ]]; then
        success "Host prerequisites already satisfied"
        return 0
    fi

    warn "Missing host prerequisites: ${missing[*]}"

    if [[ "$AUTO_INSTALL_HOST_REQS" != "1" ]]; then
        if ! prompt_yes_no "Install/configure missing host prerequisites now?" "y"; then
            error "Cannot continue without host prerequisites"
        fi
    else
        info "AUTO_INSTALL_HOST_REQS=1 set, proceeding without prompt"
    fi

    step "Install host requirements for LXC provisioning"
    "${APT_GET[@]}" update
    "${APT_GET[@]}" install \
        ca-certificates \
        curl \
        gnupg \
        rsync \
        tar \
        lxc \
        lxc-templates \
        debootstrap \
        bridge-utils \
        sqlite3

    command -v lxc-create >/dev/null 2>&1 || error "lxc-create not found after installation"
    command -v lxc-attach >/dev/null 2>&1 || error "lxc-attach not found after installation"
    success "Host LXC toolchain is ready"
}

lxc_exists() {
    [[ -d "$LXC_ROOT_DIR" ]]
}

lxc_has_vdm_installation() {
    [[ -f "$LXC_ROOT_DIR/rootfs/etc/systemd/system/auxinux-vdm.service" ]] \
        || [[ -f "$LXC_ROOT_DIR/rootfs/opt/auxinux-vdm/apps/vdm/dist/server.js" ]]
}

ensure_lxc_bridge_available() {
    if ! ip link show "$LXC_BRIDGE" >/dev/null 2>&1; then
        error "Bridge '$LXC_BRIDGE' does not exist on host. Use --lxc-bridge=<bridge> with an existing bridge."
    fi
}

lxc_download_cache_dir() {
    printf '/var/cache/lxc/download/%s/%s/%s/default' "$LXC_DIST" "$LXC_RELEASE" "$LXC_ARCH"
}

purge_broken_lxc_download_cache() {
    local cache_dir
    cache_dir="$(lxc_download_cache_dir)"
    [[ -d "$cache_dir" ]] || return 0

    # lxc-download may leave metadata behind after the rootfs archive was
    # removed or interrupted. It then reports "Using image from local cache"
    # and fails because rootfs.tar.* does not exist.
    if ! find "$cache_dir" -type f -name 'rootfs.tar.*' -size +0c -print -quit 2>/dev/null | grep -q .; then
        warn "Incomplete LXC image cache detected at $cache_dir; removing it before download"
        rm -rf -- "$cache_dir"
    fi
}

purge_lxc_download_cache() {
    local cache_dir
    cache_dir="$(lxc_download_cache_dir)"
    if [[ -d "$cache_dir" ]]; then
        warn "Removing cached ${LXC_DIST}/${LXC_RELEASE}/${LXC_ARCH} image before retry"
        rm -rf -- "$cache_dir"
    fi
}

cleanup_incomplete_lxc() {
    [[ -d "$LXC_ROOT_DIR" ]] || return 0
    [[ ! -f "$LXC_ROOT_DIR/config" ]] || return 0

    warn "Removing incomplete LXC directory: $LXC_ROOT_DIR"
    lxc-stop -P "$LXC_PATH_BASE" -n "$LXC_NAME" >/dev/null 2>&1 || true
    lxc-destroy -P "$LXC_PATH_BASE" -n "$LXC_NAME" >/dev/null 2>&1 || true
    if [[ -d "$LXC_ROOT_DIR" ]]; then
        [[ "$LXC_ROOT_DIR" == "${LXC_PATH_BASE}/"* && "$LXC_ROOT_DIR" != "$LXC_PATH_BASE" ]] \
            || error "Refusing unsafe cleanup path: $LXC_ROOT_DIR"
        rm -rf -- "$LXC_ROOT_DIR"
    fi
}

cleanup_failed_lxc_creation() {
    [[ -d "$LXC_ROOT_DIR" ]] || return 0
    warn "Removing failed LXC creation state: $LXC_ROOT_DIR"
    lxc-stop -P "$LXC_PATH_BASE" -n "$LXC_NAME" >/dev/null 2>&1 || true
    lxc-destroy -P "$LXC_PATH_BASE" -n "$LXC_NAME" >/dev/null 2>&1 || true
    if [[ -d "$LXC_ROOT_DIR" ]]; then
        [[ "$LXC_ROOT_DIR" == "${LXC_PATH_BASE}/"* && "$LXC_ROOT_DIR" != "$LXC_PATH_BASE" ]] \
            || error "Refusing unsafe cleanup path: $LXC_ROOT_DIR"
        rm -rf -- "$LXC_ROOT_DIR"
    fi
}

create_or_reset_lxc() {
    step "Create/prepare LXC container"

    if [[ "$MODE" == "reset" ]] && lxc_exists; then
        info "Reset mode: removing existing LXC '$LXC_NAME'"
        lxc-stop -P "$LXC_PATH_BASE" -n "$LXC_NAME" >/dev/null 2>&1 || true
        lxc-destroy -P "$LXC_PATH_BASE" -n "$LXC_NAME" || true
    fi

    # Recover automatically when a previous lxc-create stopped after creating
    # the directory but before writing a usable container configuration.
    cleanup_incomplete_lxc

    if lxc_exists; then
        if [[ -f "$LXC_ROOT_DIR/config" ]]; then
            # Cleanup legacy invalid key emitted by older installer versions.
            sed -i '/^lxc\.net\.0\.ipv4\.address = dhcp$/d' "$LXC_ROOT_DIR/config" || true
        fi
        if [[ "$MODE" == "install" ]]; then
            if lxc_has_vdm_installation; then
                error "LXC '$LXC_NAME' already contains VDM. Use -update, -repair or -reset."
            fi
            warn "Existing LXC '$LXC_NAME' is an incomplete VDM installation; resuming provisioning"
            return 0
        fi
        info "Using existing LXC '$LXC_NAME'"
        return 0
    fi

    ensure_lxc_bridge_available
    purge_broken_lxc_download_cache

    info "Creating LXC '$LXC_NAME' from ${LXC_DIST}/${LXC_RELEASE}/${LXC_ARCH} template"
    if ! lxc-create -P "$LXC_PATH_BASE" -n "$LXC_NAME" -t download -- --dist "$LXC_DIST" --release "$LXC_RELEASE" --arch "$LXC_ARCH"; then
        warn "Initial LXC image extraction failed; cleaning the partial container and cache, then retrying once"
        cleanup_failed_lxc_creation
        purge_lxc_download_cache
        lxc-create -P "$LXC_PATH_BASE" -n "$LXC_NAME" -t download -- --dist "$LXC_DIST" --release "$LXC_RELEASE" --arch "$LXC_ARCH" \
            || error "Failed to create LXC '$LXC_NAME' after a clean image download retry"
    fi

    if [[ ! -f "$LXC_ROOT_DIR/config" ]]; then
        error "LXC config file not found after creation: $LXC_ROOT_DIR/config"
    fi

    # Ensure deterministic network and host autostart behavior. Keep the MAC
    # generated by lxc-download, but replace its default bridge/network keys.
    sed -i \
        -e '/^lxc\.net\.0\.type[[:space:]]*=/d' \
        -e '/^lxc\.net\.0\.link[[:space:]]*=/d' \
        -e '/^lxc\.net\.0\.name[[:space:]]*=/d' \
        -e '/^lxc\.net\.0\.flags[[:space:]]*=/d' \
        -e '/^lxc\.net\.0\.ipv4\.address[[:space:]]*=/d' \
        -e '/^lxc\.net\.0\.ipv4\.gateway[[:space:]]*=/d' \
        "$LXC_ROOT_DIR/config"
    cat >> "$LXC_ROOT_DIR/config" <<EOF

# Managed by AuxiNux VDM installer
lxc.start.auto = 1
lxc.start.order = 20
lxc.start.delay = 10
lxc.net.0.type = veth
lxc.net.0.link = ${LXC_BRIDGE}
lxc.net.0.name = eth0
lxc.net.0.flags = up
EOF

    if [[ "$LXC_IPV4" != "dhcp" ]]; then
        [[ -n "$LXC_GATEWAY" ]] || error "--lxc-gateway is required when --lxc-ipv4 is static"
        echo "lxc.net.0.ipv4.address = ${LXC_IPV4}" >> "$LXC_ROOT_DIR/config"
        echo "lxc.net.0.ipv4.gateway = ${LXC_GATEWAY}" >> "$LXC_ROOT_DIR/config"
        info "LXC IPv4 mode: static (${LXC_IPV4})"
    elif [[ "${LXC_IP_MODE:-}" == "dhcp-reserved" ]]; then
        info "LXC IPv4 mode: DHCP with reservation"
        # No static IPv4 config needed; guest will obtain via DHCP
    else
        info "LXC IPv4 mode: DHCP unreserved"
    fi

    success "LXC '$LXC_NAME' created"
}

write_lxc_resolver_config() {
    local resolv_file="$LXC_ROOT_DIR/rootfs/etc/resolv.conf"
    local gateway nameservers
    gateway="${LXC_GATEWAY:-$(detect_host_gateway)}"
    nameservers="$(awk '/^nameserver[[:space:]]+/ && $2 !~ /^(127\.|::1$)/ { print $2 }' /etc/resolv.conf 2>/dev/null | awk '!seen[$0]++' || true)"

    # A host using systemd-resolved often exposes only 127.0.0.53, which is not
    # reachable from the container. Prefer real host DNS, then LAN gateway and
    # public resolvers as deterministic fallbacks.
    rm -f "$resolv_file"
    {
        local ns
        while IFS= read -r ns; do
            [[ -n "$ns" ]] && echo "nameserver $ns"
        done <<< "$nameservers"
        [[ -n "$gateway" ]] && echo "nameserver $gateway"
        echo "nameserver 1.1.1.1"
        echo "nameserver 8.8.8.8"
        echo "options timeout:2 attempts:2"
    } | awk '!seen[$0]++' > "$resolv_file"
    chmod 0644 "$resolv_file"
}

configure_lxc_guest_network() {
    step "Configure LXC guest network"
    local network_file="$LXC_ROOT_DIR/rootfs/etc/systemd/network/10-auxinux-vdm.network"
    mkdir -p "$(dirname "$network_file")"

    if [[ "$LXC_IPV4" == "dhcp" ]]; then
        cat > "$network_file" <<'EOF'
[Match]
Name=eth0

[Network]
DHCP=ipv4

[DHCPv4]
UseDNS=no
RouteMetric=100
EOF
        info "Guest network configured for DHCP on eth0"
    else
        cat > "$network_file" <<EOF
[Match]
Name=eth0

[Network]
DHCP=no
Address=${LXC_IPV4}
Gateway=${LXC_GATEWAY}
DNS=1.1.1.1
DNS=8.8.8.8
EOF
        info "Guest network configured with static address ${LXC_IPV4}"
    fi

    write_lxc_resolver_config
    success "LXC guest network configuration written"
}

ensure_lxc_running() {
    step "Start LXC container"

    if lxc-info -P "$LXC_PATH_BASE" -n "$LXC_NAME" -s 2>/dev/null | grep -q "RUNNING"; then
        info "LXC '$LXC_NAME' is already running"
        return 0
    fi

    lxc-start -P "$LXC_PATH_BASE" -n "$LXC_NAME"

    local tries=0
    until lxc-info -P "$LXC_PATH_BASE" -n "$LXC_NAME" -s 2>/dev/null | grep -q "RUNNING"; do
        tries=$((tries + 1))
        if [[ $tries -gt 30 ]]; then
            error "LXC '$LXC_NAME' did not reach RUNNING state"
        fi
        sleep 1
    done

    success "LXC '$LXC_NAME' is running"
}

wait_for_lxc_network() {
    step "Wait for LXC network and DNS"
    local tries=0

    # Ensure networkd is enabled even when resuming a container created by an
    # earlier failed installer run, then force the new configuration to load.
    lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- bash -lc '
      systemctl enable systemd-networkd >/dev/null 2>&1 || true
      systemctl restart systemd-networkd >/dev/null 2>&1 || true
    '

    while (( tries < 60 )); do
        if lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- bash -lc \
            'ip -4 -o addr show dev eth0 scope global | grep -q . && ip -4 route show default | grep -q . && getent hosts deb.debian.org >/dev/null 2>&1'; then
            local guest_ip
            guest_ip="$(lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- ip -4 -o addr show dev eth0 scope global 2>/dev/null | awk '{print $4; exit}' || true)"
            success "LXC network is ready (${guest_ip:-address detected}); DNS resolution works"
            return 0
        fi
        tries=$((tries + 1))
        if (( tries == 20 || tries == 40 )); then
            warn "LXC network is not ready yet (${tries}s); restarting networkd"
            write_lxc_resolver_config
            lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- systemctl restart systemd-networkd >/dev/null 2>&1 || true
        fi
        sleep 1
    done

    lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- bash -lc \
        'echo "Addresses:"; ip -br addr; echo "Routes:"; ip route; echo "Resolver:"; cat /etc/resolv.conf' 2>&1 || true
    error "LXC did not obtain a usable IP/default route/DNS within 60 seconds. Verify the DHCP reservation and bridge '$LXC_BRIDGE'."
}

bootstrap_lxc_os() {
    step "Bootstrap Debian inside LXC"

    lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- bash -lc '
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt_retry() {
        local attempt
        for attempt in 1 2 3; do
          if apt-get -y -qq -o Dpkg::Use-Pty=0 "$@"; then return 0; fi
          echo "APT operation failed (attempt ${attempt}/3); retrying in 5 seconds" >&2
          sleep 5
        done
        return 1
      }
      apt_retry update
      apt_retry upgrade
      apt_retry install \
        ca-certificates \
        curl \
        gnupg \
        rsync \
        tar \
        sudo \
        iproute2 \
        procps \
        systemd-sysv \
        netbase
    '

    success "Debian LXC bootstrap complete"
}

copy_release_to_lxc() {
    step "Copy release payload into LXC"

    tar \
      --exclude='node_modules' \
      --exclude='.git' \
      --exclude='.gitignore' \
      --exclude='*.env' \
      --exclude='*.env.local' \
      --exclude='*.log' \
      --exclude='.DS_Store' \
      --exclude='*.swp' \
      --exclude='*.tmp' \
      --exclude='.turbo' \
      --exclude='.vite' \
      -C "$INSTALL_DIR" -cf - . \
      | lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- bash -lc '
          set -euo pipefail
          rm -rf /opt/auxinux-vdm
          mkdir -p /opt/auxinux-vdm
          tar -C /opt/auxinux-vdm -xf -
        '

    success "Release copied to /opt/auxinux-vdm in LXC"
}

run_in_container_installer() {
    step "Run in-container VDM install"

    local mode_flag=""
    case "$MODE" in
        update) mode_flag="-update" ;;
        repair) mode_flag="-repair" ;;
        reset)  mode_flag="-reset" ;;
        *)      mode_flag="" ;;
    esac

        # Encode values to preserve special characters across host -> LXC shell layers.
        local env_session_b64 env_firewall_b64 env_bootstrap_apply_b64
        local env_dc_b64 env_admin_user_b64 env_admin_pass_b64
        local env_node_name_b64 env_node_display_b64 env_node_api_b64 env_node_token_b64 env_node_enabled_b64
        env_session_b64="$(printf '%s' "${AUXINUX_VDM_SESSION_SECRET:-}" | base64 | tr -d '\n')"
        env_firewall_b64="$(printf '%s' "${FIREWALL_ENABLED}" | base64 | tr -d '\n')"
        env_bootstrap_apply_b64="$(printf '%s' "${BOOTSTRAP_APPLY}" | base64 | tr -d '\n')"
        env_dc_b64="$(printf '%s' "${BOOTSTRAP_DATACENTER_NAME}" | base64 | tr -d '\n')"
        env_admin_user_b64="$(printf '%s' "${BOOTSTRAP_ADMIN_USERNAME}" | base64 | tr -d '\n')"
        env_admin_pass_b64="$(printf '%s' "${BOOTSTRAP_ADMIN_PASSWORD}" | base64 | tr -d '\n')"
        env_node_name_b64="$(printf '%s' "${BOOTSTRAP_NODE_NAME}" | base64 | tr -d '\n')"
        env_node_display_b64="$(printf '%s' "${BOOTSTRAP_NODE_DISPLAY_NAME}" | base64 | tr -d '\n')"
        env_node_api_b64="$(printf '%s' "${BOOTSTRAP_NODE_API_URL}" | base64 | tr -d '\n')"
        env_node_token_b64="$(printf '%s' "${BOOTSTRAP_NODE_AUTH_TOKEN}" | base64 | tr -d '\n')"
        env_node_enabled_b64="$(printf '%s' "${BOOTSTRAP_NODE_ENABLED}" | base64 | tr -d '\n')"

    lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- bash <<LXCEOF
      set -euo pipefail
      cd /opt/auxinux-vdm
            export AUXINUX_VDM_SESSION_SECRET="\$(printf '%s' '${env_session_b64}' | base64 -d)"
            export VDM_FIREWALL_ENABLED="\$(printf '%s' '${env_firewall_b64}' | base64 -d)"
            export BOOTSTRAP_APPLY="\$(printf '%s' '${env_bootstrap_apply_b64}' | base64 -d)"
            export BOOTSTRAP_DATACENTER_NAME="\$(printf '%s' '${env_dc_b64}' | base64 -d)"
            export BOOTSTRAP_ADMIN_USERNAME="\$(printf '%s' '${env_admin_user_b64}' | base64 -d)"
            export BOOTSTRAP_ADMIN_PASSWORD="\$(printf '%s' '${env_admin_pass_b64}' | base64 -d)"
            export BOOTSTRAP_NODE_NAME="\$(printf '%s' '${env_node_name_b64}' | base64 -d)"
            export BOOTSTRAP_NODE_DISPLAY_NAME="\$(printf '%s' '${env_node_display_b64}' | base64 -d)"
            export BOOTSTRAP_NODE_API_URL="\$(printf '%s' '${env_node_api_b64}' | base64 -d)"
            export BOOTSTRAP_NODE_AUTH_TOKEN="\$(printf '%s' '${env_node_token_b64}' | base64 -d)"
            export BOOTSTRAP_NODE_ENABLED="\$(printf '%s' '${env_node_enabled_b64}' | base64 -d)"
      bash INSTALL/vdm-install.sh --inside-lxc ${mode_flag}
LXCEOF

    success "VDM installed inside LXC"
}

enable_host_autostart_services() {
    step "Enable host autostart services"

    # lxc service name differs by distro; try both safely.
    systemctl enable lxc >/dev/null 2>&1 || true
    systemctl enable lxc-net >/dev/null 2>&1 || true

    success "Host LXC autostart services configured"
}

show_host_completion_info() {
    step "VDM deployment completed"

    local lxc_ip
    lxc_ip="$(lxc-info -P "$LXC_PATH_BASE" -n "$LXC_NAME" -iH 2>/dev/null | awk 'NF {print $1; exit}' || true)"

    [[ -n "$lxc_ip" ]] || error "VDM LXC is running but has no detectable IP address"
    if ! lxc-attach -P "$LXC_PATH_BASE" -n "$LXC_NAME" -- systemctl is-active --quiet auxinux-vdm; then
        error "VDM systemd service is not active after container installation"
    fi
    if ! curl -sS --connect-timeout 2 --max-time 5 -o /dev/null "http://${lxc_ip}:${VDM_PORT}/api/vdm/health"; then
        error "VDM is not reachable from the host at http://${lxc_ip}:${VDM_PORT}"
    fi

    echo ""
    success "VDM ${PROJECT_VERSION} is deployed in LXC '${LXC_NAME}'"
    info "Container autostart: enabled"
    info "VDM service in container: auxinux-vdm"
    echo ""

    info "VDM URL: http://${lxc_ip}:${VDM_PORT}"

    echo ""
    if [[ "$BOOTSTRAP_APPLY" == "1" ]]; then
        info "Admin credentials: admin / admin123"
    else
        info "Default credentials: admin / admin123"
    fi
    info "Host commands:"
    echo "  lxc-info -n ${LXC_NAME}"
    echo "  lxc-attach -n ${LXC_NAME}"
    echo "  lxc-stop -n ${LXC_NAME}"
    echo "  lxc-start -n ${LXC_NAME}"
    echo ""
}

show_vdm_status() {
    require_root
    detect_project_version
    echo "Virtua VDM ${PROJECT_VERSION}"
    echo "Cluster mode : $(cluster_mode)"
    if lxc_exists; then
        local state lxc_ip health
        state="$(lxc-info -P "$LXC_PATH_BASE" -n "$LXC_NAME" -sH 2>/dev/null || echo STOPPED)"
        lxc_ip="$(lxc-info -P "$LXC_PATH_BASE" -n "$LXC_NAME" -iH 2>/dev/null | awk 'NF {print $1; exit}' || true)"
        echo "Placement    : local node $(hostname -s)"
        echo "LXC          : ${LXC_NAME} (${state})"
        echo "Address      : ${lxc_ip:-unknown}:${VDM_PORT}"
        health=""
        if [[ -n "$lxc_ip" && "$state" == "RUNNING" ]]; then
            health="$(curl -fsS --connect-timeout 2 --max-time 5 "http://${lxc_ip}:${VDM_PORT}/api/vdm/health" 2>/dev/null || true)"
        fi
        echo "Health       : ${health:-unreachable}"
    else
        echo "Placement    : not local"
    fi

    local name api_url token response
    while IFS='|' read -r name api_url token; do
        [[ -n "$name" ]] || continue
        response="$(curl -k -fsS --connect-timeout 3 --max-time 8 -H "x-auxinux-node-token: ${token}" "${api_url}/api/internal/vdm-host-status" 2>/dev/null || true)"
        echo "Node ${name} : ${response:-unreachable}"
    done < <(cluster_remote_nodes)
    show_ha_status
}

confirm_destructive() {
    local message="$1" answer
    [[ "$YES" == "1" ]] && return 0
    read -r -p "${message} [y/N] " answer || true
    [[ "$answer" =~ ^[YyOo]$ ]] || error "Cancelled"
}

clear_cluster_vdm_registration() {
    local db_path name api_url token
    db_path="$(virtua_db_path)"
    if [[ -f "$db_path" ]]; then
        sqlite3 "$db_path" "DELETE FROM settings WHERE key IN ('vdm.managerApiUrl','vdm.joinedAt');" 2>/dev/null || true
    fi
    while IFS='|' read -r name api_url token; do
        [[ -n "$name" ]] || continue
        curl -k -fsS --connect-timeout 3 --max-time 8 -X DELETE \
            -H "x-auxinux-node-token: ${token}" "${api_url}/api/internal/vdm-placement" >/dev/null \
            || warn "Could not clear VDM registration on node ${name}; retry when it is online"
    done < <(cluster_remote_nodes)
}

uninstall_vdm() {
    require_root
    [[ "$INSIDE_LXC" == "0" ]] || error "Uninstall must run on a Virtua host"
    lxc_exists || error "VDM is not installed on this node"
    confirm_destructive "Remove LXC '${LXC_NAME}' and its VDM database?"
    acquire_cluster_install_lock
    disable_vdm_ha || true
    lxc-stop -P "$LXC_PATH_BASE" -n "$LXC_NAME" >/dev/null 2>&1 || true
    lxc-destroy -P "$LXC_PATH_BASE" -n "$LXC_NAME" || error "Failed to destroy VDM LXC"
    clear_cluster_vdm_registration
    rm -f "$HA_CONFIG_FILE"
    success "VDM was removed from the cluster"
}

move_vdm_to_node() {
    require_root
    [[ -n "$TARGET_NODE" ]] || error "--target-node=<host> is required"
    [[ "$TARGET_NODE" =~ ^[A-Za-z0-9_.@:-]+$ ]] || error "Invalid target node"
    lxc_exists || error "VDM is not installed on this node"
    command -v rsync >/dev/null 2>&1 || error "rsync is required"
    command -v ssh >/dev/null 2>&1 || error "ssh is required"
    confirm_destructive "Stop VDM and move its only LXC to '${TARGET_NODE}'?"

    if [[ "${VDM_HA_ENABLED:-0}" == "1" ]]; then
        command -v pcs >/dev/null 2>&1 || error "HA configuration exists but pcs is unavailable"
        acquire_cluster_install_lock
        pcs resource move "$VDM_HA_RESOURCE" "$TARGET_NODE" --wait=180 \
            || error "Pacemaker could not move VDM to ${TARGET_NODE}"
        pcs resource status "$VDM_HA_RESOURCE" | grep -q "$TARGET_NODE" \
            || error "Pacemaker did not confirm VDM on ${TARGET_NODE}"
        pcs resource clear "$VDM_HA_RESOURCE" >/dev/null 2>&1 || true
        success "Pacemaker moved VDM to ${TARGET_NODE}; automatic failover remains active"
        return 0
    fi

    step "Validate target Virtua node"
    ssh -o BatchMode=yes -o ConnectTimeout=8 "$TARGET_NODE" \
        "test -x /usr/bin/lxc-start && test ! -e '${LXC_ROOT_DIR}/config'" \
        || error "Target is unreachable, lacks LXC, or already has '${LXC_NAME}'"
    acquire_cluster_install_lock

    step "Stop and transfer VDM LXC"
    local was_running=0
    if lxc-info -P "$LXC_PATH_BASE" -n "$LXC_NAME" -sH 2>/dev/null | grep -q RUNNING; then
        was_running=1
        lxc-stop -P "$LXC_PATH_BASE" -n "$LXC_NAME" -t 60 || error "Could not stop VDM cleanly"
    fi
    if ! ssh "$TARGET_NODE" "mkdir -p '${LXC_ROOT_DIR}'" \
        || ! rsync -aHAX --numeric-ids --delete "${LXC_ROOT_DIR}/" "${TARGET_NODE}:${LXC_ROOT_DIR}/"; then
        [[ "$was_running" == "1" ]] && lxc-start -P "$LXC_PATH_BASE" -n "$LXC_NAME" || true
        error "Transfer failed; source VDM was kept and restarted"
    fi

    step "Start and validate VDM on target"
    if ! ssh "$TARGET_NODE" "lxc-start -P '${LXC_PATH_BASE}' -n '${LXC_NAME}' && sleep 3 && lxc-info -P '${LXC_PATH_BASE}' -n '${LXC_NAME}' -sH | grep -q RUNNING && lxc-attach -P '${LXC_PATH_BASE}' -n '${LXC_NAME}' -- systemctl is-active --quiet auxinux-vdm"; then
        ssh "$TARGET_NODE" "lxc-stop -P '${LXC_PATH_BASE}' -n '${LXC_NAME}'" >/dev/null 2>&1 || true
        [[ "$was_running" == "1" ]] && lxc-start -P "$LXC_PATH_BASE" -n "$LXC_NAME" || true
        error "Target validation failed; source VDM was kept and restarted"
    fi

    lxc-destroy -P "$LXC_PATH_BASE" -n "$LXC_NAME" || {
        ssh "$TARGET_NODE" "lxc-stop -P '${LXC_PATH_BASE}' -n '${LXC_NAME}'" >/dev/null 2>&1 || true
        error "Target is healthy but source cleanup failed. Target was stopped to prevent two VDM instances."
    }
    success "VDM moved to ${TARGET_NODE}; only the target instance is running"
}

pacemaker_nodes() {
    crm_node -l 2>/dev/null | awk '$3 == "member" {print $2}'
}

validate_ha_prerequisites() {
    [[ -n "${VDM_HA_LXC_PATH:-}" ]] || error "Set VDM_HA_LXC_PATH to a cluster filesystem mounted at the same path on every node"
    [[ "$VDM_HA_LXC_PATH" == /* && "$VDM_HA_LXC_PATH" != "/" ]] || error "VDM_HA_LXC_PATH must be an absolute, dedicated path"
    [[ ! "$VDM_HA_LXC_PATH" =~ [[:space:]] ]] || error "VDM_HA_LXC_PATH cannot contain whitespace"
    command -v pcs >/dev/null 2>&1 || error "Pacemaker/pcs is not installed or this node is not cluster-managed"
    command -v crm_node >/dev/null 2>&1 || error "Pacemaker crm_node is missing"
    pcs status >/dev/null 2>&1 || error "No operational Pacemaker cluster. Configure Corosync/Pacemaker first"
    local node_count fstype
    node_count="$(pacemaker_nodes | wc -l | tr -d ' ')"
    [[ "$node_count" -ge 2 ]] || error "HA requires at least two online Pacemaker members"
    corosync-quorumtool -s 2>/dev/null | grep -Eq 'Quorate:[[:space:]]+Yes' || error "Cluster has no quorum; HA activation refused"
    pcs property config 2>/dev/null | grep -Eq 'stonith-enabled[=:][[:space:]]*true' \
        || error "STONITH/fencing must be enabled before VDM HA can be activated"
    local stonith_config
    stonith_config="$(pcs stonith config 2>/dev/null || true)"
    [[ -n "$stonith_config" ]] && ! grep -Eqi 'no (stonith|fenc).*configured' <<<"$stonith_config" \
        || error "No fencing device is configured"
    mkdir -p "$VDM_HA_LXC_PATH"
    fstype="$(findmnt -n -o FSTYPE --target "$VDM_HA_LXC_PATH" 2>/dev/null || true)"
    case "$fstype" in
        gfs2|ocfs2|ceph|fuse.ceph|fuse.glusterfs|glusterfs) ;;
        nfs|nfs4|cifs) error "${fstype} is not safe for the SQLite VDM database; use a fenced cluster filesystem" ;;
        *) error "${VDM_HA_LXC_PATH} is not on a supported cluster filesystem (detected: ${fstype:-unknown})" ;;
    esac
}

install_ha_agent_on_cluster() {
    local source_agent="${INSTALL_DIR}/INSTALL/vdm-ha-agent" node local_name
    [[ -f "$source_agent" ]] || error "Missing HA resource agent: $source_agent"
    install -d -m 0755 /usr/lib/ocf/resource.d/auxinux
    install -m 0755 "$source_agent" /usr/lib/ocf/resource.d/auxinux/vdm-lxc
    local_name="$(hostname -s)"
    while read -r node; do
        [[ -n "$node" ]] || continue
        [[ "$node" == "$local_name" ]] && continue
        ssh -o BatchMode=yes -o ConnectTimeout=8 "root@${node}" \
            "command -v lxc-start >/dev/null && ip link show '${VDM_HA_BRIDGE}' >/dev/null && test -d '${VDM_HA_LXC_PATH}' && findmnt -n -o FSTYPE --target '${VDM_HA_LXC_PATH}' | grep -Eq '^(gfs2|ocfs2|ceph|fuse.ceph|fuse.glusterfs|glusterfs)$'" \
            || error "Cluster storage ${VDM_HA_LXC_PATH} is not mounted safely on ${node}"
        ssh -o BatchMode=yes -o ConnectTimeout=8 "root@${node}" "install -d -m 0755 /usr/lib/ocf/resource.d/auxinux" \
            || error "Root SSH is required between HA nodes (${node})"
        scp -q "$source_agent" "root@${node}:/usr/lib/ocf/resource.d/auxinux/vdm-lxc" \
            || error "Could not install the VDM HA agent on ${node}"
        ssh "root@${node}" "chmod 0755 /usr/lib/ocf/resource.d/auxinux/vdm-lxc" \
            || error "Could not activate the VDM HA agent on ${node}"
    done < <(pacemaker_nodes)
}

write_ha_config() {
    local enabled="$1"
    install -d -m 0755 /etc/auxinux-vdm
    local tmp
    tmp="$(mktemp)"
    {
        printf 'VDM_HA_ENABLED=%q\n' "$enabled"
        printf 'VDM_HA_LXC_PATH=%q\n' "$VDM_HA_LXC_PATH"
        printf 'VDM_HA_RESOURCE=%q\n' "$VDM_HA_RESOURCE"
    } > "$tmp"
    chmod 0600 "$tmp"
    mv -f "$tmp" "$HA_CONFIG_FILE"
}

enable_vdm_ha() {
    require_root
    validate_ha_prerequisites
    local source_path="${LXC_ROOT_DIR}" target_path="${VDM_HA_LXC_PATH}/${LXC_NAME}"
    [[ -f "$source_path/config" || -f "$target_path/config" ]] || error "Install VDM before enabling HA"
    local config_for_bridge="$source_path/config"
    [[ -f "$config_for_bridge" ]] || config_for_bridge="$target_path/config"
    VDM_HA_BRIDGE="$(sed -n 's/^lxc\.net\.0\.link[[:space:]]*=[[:space:]]*//p' "$config_for_bridge" | tail -1)"
    [[ -n "$VDM_HA_BRIDGE" ]] || error "VDM LXC network bridge cannot be determined"
    ip link show "$VDM_HA_BRIDGE" >/dev/null 2>&1 || error "Bridge ${VDM_HA_BRIDGE} is missing on this node"
    install_ha_agent_on_cluster

    if [[ "$source_path" != "$target_path" && ! -f "$target_path/config" ]]; then
        step "Move VDM onto fenced cluster storage"
        lxc-stop -P "$LXC_PATH_BASE" -n "$LXC_NAME" -t 60 >/dev/null 2>&1 || true
        mkdir -p "$target_path"
        rsync -aHAX --numeric-ids --delete "${source_path}/" "${target_path}/" || {
            lxc-start -P "$LXC_PATH_BASE" -n "$LXC_NAME" >/dev/null 2>&1 || true
            error "Could not move VDM to cluster storage"
        }
    fi
    sed -i '/^lxc\.start\.auto[[:space:]]*=/d' "$target_path/config"
    printf '\nlxc.start.auto = 0\n' >> "$target_path/config"

    local guest_env="${target_path}/rootfs/etc/auxinux-vdm.env" env_tmp cluster_id
    [[ -f "$guest_env" ]] || error "VDM environment file is missing from the HA LXC"
    env_tmp="$(mktemp)"
    grep -vE '^AUXINUX_VDM_(HA_ENABLED|CLUSTER_ID|INSTANCE_ID|ROLE)=' "$guest_env" > "$env_tmp" || true
    cluster_id="$(sqlite3 "$(virtua_db_path)" "SELECT COALESCE((SELECT value FROM settings WHERE key='datacenter.name'),'virtua-ha');" 2>/dev/null || echo virtua-ha)"
    cluster_id="$(printf '%s' "${cluster_id:-virtua-ha}" | tr -cs 'A-Za-z0-9_.-' '_' | cut -c1-100)"
    {
        printf 'AUXINUX_VDM_HA_ENABLED=1\n'
        printf 'AUXINUX_VDM_CLUSTER_ID=%s\n' "$cluster_id"
        printf 'AUXINUX_VDM_INSTANCE_ID=vdm-ha\n'
        printf 'AUXINUX_VDM_ROLE=active\n'
    } >> "$env_tmp"
    chmod 0640 "$env_tmp"
    chown --reference="$guest_env" "$env_tmp" 2>/dev/null || true
    mv -f "$env_tmp" "$guest_env"

    if pcs resource config "$VDM_HA_RESOURCE" >/dev/null 2>&1; then
        pcs resource update "$VDM_HA_RESOURCE" lxc_name="$LXC_NAME" lxc_path="$VDM_HA_LXC_PATH"
        pcs resource enable "$VDM_HA_RESOURCE"
    else
        pcs resource create "$VDM_HA_RESOURCE" ocf:auxinux:vdm-lxc \
            lxc_name="$LXC_NAME" lxc_path="$VDM_HA_LXC_PATH" \
            op start timeout=120s op stop timeout=120s op monitor interval=10s timeout=20s \
            meta migration-threshold=1 failure-timeout=60s
    fi
    pcs resource cleanup "$VDM_HA_RESOURCE" >/dev/null 2>&1 || true
    local tries=0
    until pcs resource status "$VDM_HA_RESOURCE" 2>/dev/null | grep -Eq 'Started|Promoted'; do
        tries=$((tries + 1)); [[ "$tries" -le 30 ]] || error "Pacemaker did not start VDM; source data was preserved at ${source_path}"
        sleep 2
    done

    if [[ "$source_path" != "$target_path" && -d "$source_path" ]]; then
        rm -rf "$source_path"
    fi
    VDM_HA_LXC_PATH="${VDM_HA_LXC_PATH}"
    LXC_PATH_BASE="$VDM_HA_LXC_PATH"
    LXC_ROOT_DIR="$target_path"
    write_ha_config 1
    success "VDM HA is active under Pacemaker with quorum and fencing"
}

disable_vdm_ha() {
    require_root
    if command -v pcs >/dev/null 2>&1 && pcs resource config "$VDM_HA_RESOURCE" >/dev/null 2>&1; then
        pcs resource disable "$VDM_HA_RESOURCE" --wait=120 || return 1
        pcs resource delete "$VDM_HA_RESOURCE" --wait=120 || return 1
    fi
    if [[ -n "${VDM_HA_LXC_PATH:-}" && -f "${VDM_HA_LXC_PATH}/${LXC_NAME}/config" ]]; then
        local guest_env="${VDM_HA_LXC_PATH}/${LXC_NAME}/rootfs/etc/auxinux-vdm.env" env_tmp
        if [[ -f "$guest_env" ]]; then
            env_tmp="$(mktemp)"
            grep -v '^AUXINUX_VDM_HA_ENABLED=' "$guest_env" > "$env_tmp" || true
            printf 'AUXINUX_VDM_HA_ENABLED=0\n' >> "$env_tmp"
            chmod 0640 "$env_tmp"
            chown --reference="$guest_env" "$env_tmp" 2>/dev/null || true
            mv -f "$env_tmp" "$guest_env"
        fi
        lxc-start -P "$VDM_HA_LXC_PATH" -n "$LXC_NAME" >/dev/null 2>&1 || true
    fi
    write_ha_config 0
    success "VDM automatic HA is disabled; the current node keeps VDM running"
}

show_ha_status() {
    local enabled="${VDM_HA_ENABLED:-0}"
    echo "HA configured: ${enabled}"
    echo "HA LXC path : ${VDM_HA_LXC_PATH:-not configured}"
    if command -v pcs >/dev/null 2>&1 && pcs resource config "$VDM_HA_RESOURCE" >/dev/null 2>&1; then
        pcs resource status "$VDM_HA_RESOURCE" 2>/dev/null || true
    fi
}

# ----------------------------------
# In-container mode (VDM deployment)
# ----------------------------------

setup_container_dependencies() {
    step "Install VDM dependencies inside container"

    "${APT_GET[@]}" update
    "${APT_GET[@]}" install ca-certificates curl gnupg

    if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
        info "Setting up Node.js ${NODE_MAJOR}.x repository"
        mkdir -p /etc/apt/keyrings
        curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
        "${APT_GET[@]}" update

        # Pin Debian node packages to "never install" to avoid conflicts with
        # NodeSource Node.js 22 (Debian 13 ships node-gyp which pulls libnode-dev=Node20)
        cat > /etc/apt/preferences.d/nodejs-nodesource.pref <<'PINEOF'
Package: libnode*
Pin: release o=Debian
Pin-Priority: -1

Package: node-gyp
Pin: release o=Debian
Pin-Priority: -1
PINEOF
    fi

    "${APT_GET[@]}" install \
        build-essential \
        git \
        python3 \
        sqlite3 \
        openssl \
        nodejs \
        nftables

    success "In-container dependencies installed"
}

setup_container_user_and_dirs() {
    step "Setup VDM user and directories in container"

    if ! id "$SERVICE_USER" >/dev/null 2>&1; then
        useradd -r -s /usr/sbin/nologin "$SERVICE_USER"
        info "Created system user: $SERVICE_USER"
    fi

    mkdir -p "$VDM_DATA_DIR"
    chown -R "$SERVICE_USER:$SERVICE_USER" "$VDM_DATA_DIR"
    chmod 750 "$VDM_DATA_DIR"

    success "Container users/directories ready"
}

install_vdm_in_container() {
    step "Install/build VDM in container"

    if [[ "$INSTALL_DIR" != "/opt/auxinux-vdm" && ! -d "$INSTALL_DIR/apps/vdm" ]]; then
        error "Unexpected INSTALL_DIR '$INSTALL_DIR'. In-container mode expects release under /opt/auxinux-vdm."
    fi

    cd "$INSTALL_DIR"

    if [[ "$MODE" == "repair" ]]; then
        info "Repair mode: cleaning runtime artifacts"
        rm -rf apps/vdm/node_modules apps/vdm/dist
        rm -rf apps/vdm-ui/node_modules apps/vdm-ui/dist
    fi

    if [[ "$MODE" == "reset" ]]; then
        info "Reset mode: cleaning VDM data"
        rm -rf "$VDM_DATA_DIR"/*
        mkdir -p "$VDM_DATA_DIR"
        chown -R "$SERVICE_USER:$SERVICE_USER" "$VDM_DATA_DIR"
    fi

    info "Installing npm dependencies"
    npm install --workspace=packages/shared
    npm install --workspace=apps/vdm
    npm install --workspace=apps/vdm-ui

    info "Building VDM"
    npm run build:vdm

    # The release archive and npm may preserve restrictive source permissions.
    # systemd starts VDM as an unprivileged user, which must be able to traverse
    # every directory below /opt and read the built JS/native modules.
    chown -R root:"$SERVICE_USER" "$INSTALL_DIR"
    chmod 0755 /opt
    find "$INSTALL_DIR" -type d -exec chmod 0750 {} +
    find "$INSTALL_DIR" -type f -exec chmod g+r {} +

    success "VDM build complete"
}

apply_bootstrap_configuration_in_container() {
        if [[ "$BOOTSTRAP_APPLY" != "1" ]]; then
                info "Bootstrap wizard data not requested; skipping pre-seed"
                return 0
        fi

        step "Apply bootstrap configuration (datacenter/admin/node1)"

        local db_path="${VDM_DATA_DIR}/vdm.sqlite"
    # DEBUG: Show what values we're about to apply
    info "Bootstrap values:"
    info "  BOOTSTRAP_APPLY=$BOOTSTRAP_APPLY"
    info "  BOOTSTRAP_DATACENTER_NAME=$BOOTSTRAP_DATACENTER_NAME"
    info "  BOOTSTRAP_ADMIN_USERNAME=$BOOTSTRAP_ADMIN_USERNAME"
    info "  BOOTSTRAP_ADMIN_PASSWORD=(${#BOOTSTRAP_ADMIN_PASSWORD} chars)"
    info "  BOOTSTRAP_NODE_ENABLED=$BOOTSTRAP_NODE_ENABLED"

        # Use node runtime to hash password with argon2 and update SQLite atomically.
        NODE_PATH="${INSTALL_DIR}/node_modules" \
        VDM_DB_PATH="$db_path" \
        BOOTSTRAP_DATACENTER_NAME="$BOOTSTRAP_DATACENTER_NAME" \
        BOOTSTRAP_ADMIN_USERNAME="$BOOTSTRAP_ADMIN_USERNAME" \
        BOOTSTRAP_ADMIN_PASSWORD="$BOOTSTRAP_ADMIN_PASSWORD" \
        BOOTSTRAP_NODE_NAME="$BOOTSTRAP_NODE_NAME" \
        BOOTSTRAP_NODE_DISPLAY_NAME="$BOOTSTRAP_NODE_DISPLAY_NAME" \
        BOOTSTRAP_NODE_API_URL="$BOOTSTRAP_NODE_API_URL" \
        BOOTSTRAP_NODE_AUTH_TOKEN="$BOOTSTRAP_NODE_AUTH_TOKEN" \
        BOOTSTRAP_NODE_ENABLED="$BOOTSTRAP_NODE_ENABLED" \
        node --input-type=module <<'NODE'
import Database from "better-sqlite3";
import * as argon2 from "argon2";

const dbPath = process.env.VDM_DB_PATH;
if (!dbPath) throw new Error("VDM_DB_PATH missing");

const datacenterName = (process.env.BOOTSTRAP_DATACENTER_NAME ?? "AuxiNux Datacenter").trim();
const adminUsername = (process.env.BOOTSTRAP_ADMIN_USERNAME ?? "admin").trim();
const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "admin123";
const nodeName = (process.env.BOOTSTRAP_NODE_NAME ?? "node1").trim();
const nodeDisplayName = (process.env.BOOTSTRAP_NODE_DISPLAY_NAME ?? "Node 1").trim();
const nodeApiUrl = (process.env.BOOTSTRAP_NODE_API_URL ?? "http://127.0.0.1:8441").trim();
const nodeAuthToken = (process.env.BOOTSTRAP_NODE_AUTH_TOKEN ?? "MISSING_TOKEN").trim();
const nodeEnabled = (process.env.BOOTSTRAP_NODE_ENABLED ?? "1") === "1" ? 1 : 0;

if (!adminUsername) throw new Error("Admin username cannot be empty");
if (!adminPassword) throw new Error("Admin password cannot be empty");
if (!nodeName) throw new Error("Node name cannot be empty");
if (!nodeApiUrl) throw new Error("Node API URL cannot be empty");

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Ensure schema exists (bootstrap runs before first server start)
db.exec(`
    CREATE TABLE IF NOT EXISTS vdm_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      display_name TEXT,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vdm_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      api_url TEXT NOT NULL,
      auth_token TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vdm_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
`);
const userColumns = db.prepare("PRAGMA table_info(vdm_users)").all().map((column) => column.name);
if (!userColumns.includes("must_change_password")) {
    db.exec("ALTER TABLE vdm_users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
}

const hash = await argon2.hash(adminPassword);

const tx = db.transaction(() => {
    db.prepare("INSERT OR REPLACE INTO vdm_settings (key, value) VALUES (?, ?)").run("vdmName", datacenterName);

    const existingAdmin = db
        .prepare("SELECT id FROM vdm_users WHERE username = ?")
        .get(adminUsername);

    if (existingAdmin) {
        db.prepare("UPDATE vdm_users SET password_hash = ?, role = 'admin', must_change_password = 1, updated_at = datetime('now') WHERE username = ?")
            .run(hash, adminUsername);
    } else {
        db.prepare("INSERT INTO vdm_users (username, password_hash, role, display_name, must_change_password) VALUES (?, ?, 'admin', ?, 1)")
            .run(adminUsername, hash, "Administrator");
    }

    if (adminUsername !== "admin") {
        db.prepare("DELETE FROM vdm_users WHERE username = 'admin'").run();
    }

    db.prepare(`
        INSERT INTO vdm_nodes (name, display_name, api_url, auth_token, enabled, status, notes, updated_at)
        VALUES (?, ?, ?, ?, ?, 'unknown', 'Added by installer wizard', datetime('now'))
        ON CONFLICT(name) DO UPDATE SET
            display_name = excluded.display_name,
            api_url = excluded.api_url,
            auth_token = excluded.auth_token,
            enabled = excluded.enabled,
            updated_at = datetime('now')
    `).run(nodeName, nodeDisplayName || null, nodeApiUrl, nodeAuthToken, nodeEnabled);
});

tx();
db.close();
NODE

        success "Bootstrap configuration applied"
}

create_container_systemd_service() {
    step "Configure VDM systemd service in container"

    cat > /etc/systemd/system/auxinux-vdm.service <<UNIT
[Unit]
Description=AuxiNux VDM (Virtua Datacenter Manager)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
Environment=NODE_ENV=production
Environment=LC_ALL=C.UTF-8
Environment=AUXINUX_VDM_PORT=${VDM_PORT}
Environment=AUXINUX_VDM_DATA_DIR=${VDM_DATA_DIR}
EnvironmentFile=-/etc/auxinux-vdm.env
ExecStart=/usr/bin/node ${INSTALL_DIR}/apps/vdm/dist/server.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=auxinux-vdm
TimeoutStopSec=30
KillMode=process
# --- Hardening ---
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectHome=yes
ProtectSystem=strict
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectKernelLogs=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
# Node/V8 requires executable memory for its JIT. MemoryDenyWriteExecute would
# make the same binary work manually but fail only when launched by systemd.
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
ReadWritePaths=${VDM_DATA_DIR} /var/log
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

    if [[ ! -f /etc/auxinux-vdm.env ]]; then
        # Generate a strong session secret if none was supplied via env/CLI.
        if [[ -z "${AUXINUX_VDM_SESSION_SECRET:-}" ]]; then
            AUXINUX_VDM_SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
        fi
        # Generate a DEDICATED encryption key for stored secrets (S3 keys, SMB
        # passwords). It must be independent of the session secret so rotating
        # the session secret never makes stored secrets undecryptable.
        if [[ -z "${AUXINUX_VDM_ENCRYPTION_KEY:-}" ]]; then
            AUXINUX_VDM_ENCRYPTION_KEY="$(openssl rand -base64 48 | tr -d '\n')"
        fi
        # Write via tmp + atomic rename + restrictive mode before populating secrets.
        local env_tmp
        env_tmp="$(mktemp)"
        cat > "$env_tmp" <<ENV
# AuxiNux VDM environment configuration
#AUXINUX_VDM_PORT=${VDM_PORT}
#AUXINUX_VDM_DATA_DIR=${VDM_DATA_DIR}
#AUXINUX_API_URL=http://127.0.0.1:8441
#AUXINUX_VDM_NODE_TIMEOUT_MS=15000
#AUXINUX_VDM_NODE_RETRIES=1
#AUXINUX_VDM_LONG_OPERATION_TIMEOUT_MS=14400000
#AUXINUX_VDM_HEARTBEAT_CONCURRENCY=4
#AUXINUX_VDM_CLUSTER_ID=standalone
#AUXINUX_VDM_INSTANCE_ID=vdm-01
#AUXINUX_VDM_ROLE=active
#AUXINUX_VDM_MIN_VIRTUA_VERSION=0.7.32
AUXINUX_VDM_ENCRYPTION_KEY=${AUXINUX_VDM_ENCRYPTION_KEY}
#AUXINUX_VDM_SECURE_COOKIE=0
#AUXINUX_VDM_TRUST_PROXY=0
ENV
        chmod 640 "$env_tmp"
        chown root:${SERVICE_USER} "$env_tmp"
        mv -f "$env_tmp" /etc/auxinux-vdm.env
    fi

    if [[ -n "${AUXINUX_VDM_SESSION_SECRET:-}" ]]; then
        # Rewrite the env file safely without sed (secret may contain sed metachars: |, &, \, /)
        local env_tmp
        env_tmp="$(mktemp)"
        # Preserve every line that is NOT AUXINUX_VDM_SESSION_SECRET=
        grep -v '^AUXINUX_VDM_SESSION_SECRET=' /etc/auxinux-vdm.env > "$env_tmp" 2>/dev/null || true
        # Use printf with %s so the secret is written verbatim (no interpretation).
        printf 'AUXINUX_VDM_SESSION_SECRET=%s\n' "${AUXINUX_VDM_SESSION_SECRET}" >> "$env_tmp"
        chmod 640 "$env_tmp"
        chown root:${SERVICE_USER} "$env_tmp"
        mv -f "$env_tmp" /etc/auxinux-vdm.env
    fi

    # Keep data-at-rest encryption independent from session rotation.
    if ! grep -q '^AUXINUX_VDM_ENCRYPTION_KEY=' /etc/auxinux-vdm.env 2>/dev/null; then
        local encryption_key env_tmp
        encryption_key="$(openssl rand -base64 48 | tr -d '\n')"
        env_tmp="$(mktemp)"
        grep -v '^AUXINUX_VDM_ENCRYPTION_KEY=' /etc/auxinux-vdm.env > "$env_tmp" 2>/dev/null || true
        printf 'AUXINUX_VDM_ENCRYPTION_KEY=%s\n' "$encryption_key" >> "$env_tmp"
        chmod 640 "$env_tmp"
        chown root:${SERVICE_USER} "$env_tmp"
        mv -f "$env_tmp" /etc/auxinux-vdm.env
    fi

    systemctl daemon-reload
    systemctl enable auxinux-vdm
    success "Systemd service configured"
}

configure_container_firewall() {
    if [[ "$FIREWALL_ENABLED" != "1" ]]; then
        warn "Firewall setup skipped (--no-firewall)"
        return 0
    fi

    step "Configure container firewall (nftables)"

    cat > /etc/nftables.conf <<EOF
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
  chain input {
    type filter hook input priority 0;
    policy drop;

    iif lo accept
    ct state established,related accept

    # ICMP for diagnostics
    ip protocol icmp accept
    ip6 nexthdr ipv6-icmp accept

    # SSH management
    tcp dport 22 accept

    # VDM web/API
    tcp dport ${VDM_PORT} accept
  }

  chain forward {
    type filter hook forward priority 0;
    policy drop;
  }

  chain output {
    type filter hook output priority 0;
    policy accept;
  }
}
EOF

    systemctl enable nftables
    systemctl restart nftables

    success "Firewall configured (allowed: 22, ${VDM_PORT})"
}

start_container_vdm_service() {
    step "Start VDM service in container"

    # Verify node binary exists
    local node_bin
    node_bin="$(command -v node 2>/dev/null || echo "")"
    if [[ -z "$node_bin" ]]; then
        error "node binary not found — Node.js installation may have failed"
    fi
    info "Node.js: $node_bin ($(node --version 2>/dev/null || echo unknown))"

    # Verify the server entry point exists
    local server_js="${INSTALL_DIR}/apps/vdm/dist/server.js"
    if [[ ! -f "$server_js" ]]; then
        error "VDM server entry point not found: $server_js — build may have failed"
    fi
    if ! runuser -u "$SERVICE_USER" -- bash -c 'cd "$1" && test -r "$2"' _ "$INSTALL_DIR" "$server_js"; then
        namei -l "$server_js" 2>/dev/null || true
        error "VDM runtime user '$SERVICE_USER' cannot traverse $INSTALL_DIR or read $server_js"
    fi

    # Verify data dir permissions
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "${VDM_DATA_DIR}" || true

    # Patch unit ExecStart to use the actual node binary path (handles non-standard paths).
    # Avoid sed — both $node_bin and $server_js could contain sed metachars (|, &, \, /).
    # Regenerate the [Service] ExecStart line via awk using a verbatim replacement.
    local unit_tmp
    unit_tmp="$(mktemp)"
    awk -v bin="$node_bin" -v js="$server_js" '
        /^ExecStart=/ { printf "ExecStart=%s %s\n", bin, js; next }
        { print }
    ' /etc/systemd/system/auxinux-vdm.service > "$unit_tmp"
    chmod 644 "$unit_tmp"
    mv -f "$unit_tmp" /etc/systemd/system/auxinux-vdm.service

    systemctl daemon-reload
    systemctl reset-failed auxinux-vdm >/dev/null 2>&1 || true
    systemctl restart auxinux-vdm

    local tries=0
    while (( tries < 30 )); do
        if systemctl is-active --quiet auxinux-vdm \
            && curl -sS --connect-timeout 1 --max-time 2 -o /dev/null "http://127.0.0.1:${VDM_PORT}/api/vdm/health"; then
            success "VDM service is running and answering on port ${VDM_PORT}"
            return 0
        fi
        tries=$((tries + 1))
        sleep 1
    done

    warn "VDM service did not become healthy through systemd — collecting diagnostics:"
    systemctl status auxinux-vdm --no-pager -l 2>&1 | head -40 || true
    journalctl -u auxinux-vdm -n 80 --no-pager 2>/dev/null | head -80 || true

    # A direct launch is diagnostic only. Never report installation success if
    # systemd is not the process keeping VDM alive after this script exits.
    systemctl stop auxinux-vdm >/dev/null 2>&1 || true
    warn "Testing a direct launch to distinguish application and systemd failures:"
    AUXINUX_VDM_PORT="${VDM_PORT}" \
    AUXINUX_VDM_DATA_DIR="${VDM_DATA_DIR}" \
    NODE_ENV=production \
    runuser -u "${SERVICE_USER}" -- bash -c \
        'set -a; source /etc/auxinux-vdm.env; exec "$1" "$2"' _ "$node_bin" "$server_js" &
    local pid=$!
    sleep 3
    if kill -0 "$pid" 2>/dev/null \
        && curl -sS --connect-timeout 1 --max-time 2 -o /dev/null "http://127.0.0.1:${VDM_PORT}/api/vdm/health"; then
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        error "VDM works when launched directly but its systemd unit fails. Installation is not considered operational."
    fi
    wait "$pid" 2>/dev/null || true
    error "VDM application failed to answer both through systemd and direct launch."
}

show_container_completion_info() {
    step "In-container installation complete"
    echo ""
    success "VDM ${PROJECT_VERSION} installed successfully"
    info "Listening port: ${VDM_PORT}"
    info "Data dir: ${VDM_DATA_DIR}"
    info "Service: systemctl status auxinux-vdm"
    echo ""
}

run_inside_lxc_mode() {
    require_root
    detect_project_version
    validate_release_sources
    setup_container_dependencies
    setup_container_user_and_dirs
    install_vdm_in_container
    apply_bootstrap_configuration_in_container
    create_container_systemd_service
    configure_container_firewall

    if [[ "$MODE" != "repair" ]]; then
        start_container_vdm_service
    else
        warn "Repair mode: service restart skipped"
    fi

    show_container_completion_info
}

run_host_mode() {
    require_root
    detect_project_version
    validate_release_sources

    install_host_lxc_requirements
    case "$MODE" in
        install)
            check_cluster_has_single_vdm
            acquire_cluster_install_lock
            ;;
        update|repair|reset)
            lxc_exists || error "VDM is not installed on this node. Locate it with 'vos vdm status'; do not create a second instance."
            acquire_cluster_install_lock
            ;;
    esac
    enforce_host_fixed_ip_policy
    collect_bootstrap_wizard
    collect_lxc_network_policy
    create_or_reset_lxc
    configure_lxc_guest_network
    ensure_lxc_running
    wait_for_lxc_network
    bootstrap_lxc_os
    copy_release_to_lxc
    run_in_container_installer
    enable_host_autostart_services
    show_host_completion_info
    if [[ "$ENABLE_HA_AFTER_INSTALL" == "1" ]]; then
        enable_vdm_ha
    fi
}

main() {
    parse_args "$@"
    detect_project_version

    echo -e "${BOLD}${BLUE}"
    echo "================================================================"
    echo " AuxiNux VDM Installer"
    echo " Version : ${PROJECT_VERSION}"
    echo " Mode    : ${MODE}"
    if [[ "$INSIDE_LXC" == "1" ]]; then
      echo " Context : inside-lxc"
    else
      echo " Context : host (provision-lxc)"
      echo " LXC     : ${LXC_NAME}"
      echo " Net     : bridge=${LXC_BRIDGE} ipv4=${LXC_IPV4}"
    fi
    echo "================================================================"
    echo -e "${NC}"

    if [[ "$INSIDE_LXC" == "0" ]]; then
        case "$MODE" in
            status) show_vdm_status; exit 0 ;;
            uninstall) uninstall_vdm; exit 0 ;;
            movenode) move_vdm_to_node; exit 0 ;;
            ha-enable) enable_vdm_ha; exit 0 ;;
            ha-disable) disable_vdm_ha; exit 0 ;;
            ha-status) show_ha_status; exit 0 ;;
        esac
    fi

    if [[ "$INSIDE_LXC" == "1" ]]; then
        run_inside_lxc_mode
    else
        run_host_mode
    fi
}

main "$@"
