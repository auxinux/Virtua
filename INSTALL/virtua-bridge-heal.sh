#!/bin/bash
# =============================================================================
#  virtua-bridge-heal — reassemble AuxiNux Virtua managed bridges
#
#  A host update or reboot can leave a managed bridge broken: the bridge device
#  exists but its uplink is no longer enslaved (typically a competing network
#  profile won the boot race), or the bridge is missing entirely. Guests (VM /
#  LXC / Docker) then lose all connectivity even though "the card exists".
#
#  This script discovers every bridge/uplink pair persisted by AuxiNux Virtua —
#  across all four supported network stacks — verifies them, and repairs the
#  broken ones through their OWN manager (so the repair is consistent with what
#  the next reboot will do). It only ever touches bridges that carry the
#  "Managed by AuxiNux Virtua" marker / auxinux- profile prefix.
#
#  Usage: virtua-bridge-heal [bridge]     (no argument = heal every managed bridge)
#  Exit code: 0 = everything healthy (possibly after repair), 1 = still broken.
#
#  Installed to /usr/local/sbin/virtua-bridge-heal by install.sh, which also
#  arms virtua-bridge-heal.service to run it at every boot.
# =============================================================================
set -u

ONLY="${1:-}"
LOG_TAG="virtua-bridge-heal"

log() { logger -t "$LOG_TAG" -- "$*" 2>/dev/null || true; echo "[$LOG_TAG] $*"; }

# PAIRS entries: "<bridge>|<manager>|<uplink1 uplink2 ...>" (uplinks may be empty)
PAIRS=()

add_pair() { # bridge manager uplinks
    local br="$1" mgr="$2" ups="${3:-}"
    [[ -z "$br" ]] && return 0
    [[ -n "$ONLY" && "$br" != "$ONLY" ]] && return 0
    local i cur cur_mgr_ups cur_mgr cur_ups
    for i in "${!PAIRS[@]}"; do
        cur="${PAIRS[$i]}"
        if [[ "${cur%%|*}" == "$br" ]]; then
            # Already known — keep the first manager, merge in uplinks if this
            # source knows them and the stored entry doesn't.
            cur_mgr_ups="${cur#*|}"
            cur_mgr="${cur_mgr_ups%%|*}"
            cur_ups="${cur_mgr_ups#*|}"
            if [[ -z "$cur_ups" && -n "$ups" ]]; then
                PAIRS[$i]="${br}|${cur_mgr}|${ups}"
            fi
            return 0
        fi
    done
    PAIRS+=("${br}|${mgr}|${ups}")
}

discover_ifupdown() {
    local f br ports
    for f in /etc/network/interfaces.d/auxinuxvirtual-bridge-*.cfg; do
        [[ -f "$f" ]] || continue
        br=$(awk '$1=="iface"{print $2; exit}' "$f")
        ports=$(awk '$1=="bridge_ports"{$1="";print;exit}' "$f" | xargs 2>/dev/null || true)
        [[ "$ports" == "none" ]] && ports=""
        add_pair "$br" ifupdown "$ports"
    done
}

discover_networkd() {
    local f up br
    for f in /etc/systemd/network/*.network; do
        [[ -f "$f" ]] || continue
        grep -qs "Managed by AuxiNux Virtua" "$f" || continue
        br=$(sed -n 's/^[[:space:]]*Bridge=\(.*\)$/\1/p' "$f" | head -1)
        [[ -z "$br" ]] && continue
        up=$(sed -n 's/^[[:space:]]*Name=\(.*\)$/\1/p' "$f" | head -1)
        add_pair "$br" networkd "$up"
    done
}

discover_netplan() {
    local f br up base
    for f in /etc/netplan/90-auxinux-*.yaml /etc/netplan/90-auxinux-*.yml; do
        [[ -f "$f" ]] || continue
        grep -qs "Managed by AuxiNux Virtua" "$f" || continue
        base=$(basename "$f"); base=${base%.yaml}; base=${base%.yml}
        br=${base#90-auxinux-}
        up=$(sed -n 's/^[[:space:]]*interfaces:[[:space:]]*\[\(.*\)\].*/\1/p' "$f" | head -1 | tr -d ' ' | tr ',' ' ')
        add_pair "$br" netplan "$up"
    done
}

discover_nm() {
    command -v nmcli >/dev/null 2>&1 || return 0
    local line name type rest br up
    while IFS= read -r line; do
        name=${line%%:*}
        type=${line#*:}
        case "$name" in
            auxinux-*-port-*)
                rest=${name#auxinux-}
                br=${rest%%-port-*}
                up=${rest#*-port-}
                add_pair "$br" networkmanager "$up"
                ;;
            auxinux-*)
                [[ "$type" == *bridge* ]] && add_pair "${name#auxinux-}" networkmanager ""
                ;;
        esac
    done < <(nmcli -t -f NAME,TYPE connection show 2>/dev/null || true)
}

iface_exists() { [[ -e "/sys/class/net/$1" ]]; }

iface_admin_up() {
    local flags
    flags=$(cat "/sys/class/net/$1/flags" 2>/dev/null || echo 0)
    (( flags & 0x1 ))
}

enslaved_to() { # uplink bridge
    local master
    master=$(readlink -f "/sys/class/net/$1/master" 2>/dev/null || true)
    [[ -n "$master" && "$(basename "$master")" == "$2" ]]
}

iface_has_ipv4() {
    ip -4 -o addr show dev "$1" scope global 2>/dev/null | grep -q .
}

pair_healthy() { # bridge uplinks
    local br="$1" ups="$2" up
    iface_exists "$br" || return 1
    iface_admin_up "$br" || return 1
    for up in $ups; do
        # A physically absent NIC is not something we can heal — don't loop on it.
        iface_exists "$up" || continue
        enslaved_to "$up" "$br" || return 1
    done
    return 0
}

repair_pair() { # bridge manager uplinks
    local br="$1" mgr="$2" ups="$3" up
    log "bridge '$br' is broken (manager=$mgr, uplinks='${ups:-none}') — repairing"

    case "$mgr" in
        ifupdown)
            command -v ifup >/dev/null 2>&1 && ifup --force "$br" >/dev/null 2>&1 || true
            ;;
        netplan)
            command -v netplan >/dev/null 2>&1 && netplan apply >/dev/null 2>&1 || true
            ;;
        networkd)
            command -v networkctl >/dev/null 2>&1 && {
                networkctl reload >/dev/null 2>&1 || true
                networkctl reconfigure "$br" >/dev/null 2>&1 || true
                for up in $ups; do networkctl reconfigure "$up" >/dev/null 2>&1 || true; done
            }
            ;;
        networkmanager)
            command -v nmcli >/dev/null 2>&1 && {
                nmcli connection up "auxinux-$br" >/dev/null 2>&1 || true
                for up in $ups; do nmcli connection up "auxinux-${br}-port-${up}" >/dev/null 2>&1 || true; done
            }
            ;;
    esac

    # Kernel-level fallback: even if the manager is stuck, guarantee L2 so the
    # guests get their connectivity back (the manager keeps owning L3/IP).
    if ! iface_exists "$br"; then
        ip link add name "$br" type bridge 2>/dev/null || true
    fi
    ip link set dev "$br" up 2>/dev/null || true
    for up in $ups; do
        iface_exists "$up" || continue
        enslaved_to "$up" "$br" && continue
        # SAFETY: never steal a NIC that currently carries a global IPv4 — it is
        # serving the host right now and force-enslaving it here could cut the
        # host off. The manager-specific repair above is the safe path for that
        # case (e.g. `nmcli connection up` migrates the address properly).
        if iface_has_ipv4 "$up"; then
            log "NOT force-enslaving '$up' into '$br': it carries a host IPv4 (manager repair only)"
            continue
        fi
        ip link set dev "$up" master "$br" 2>/dev/null || true
        ip link set dev "$up" up 2>/dev/null || true
    done
}

discover_ifupdown
discover_networkd
discover_netplan
discover_nm

if [[ ${#PAIRS[@]} -eq 0 ]]; then
    [[ -n "$ONLY" ]] && log "no managed configuration found for bridge '$ONLY' — nothing to heal"
    exit 0
fi

RC=0
for entry in "${PAIRS[@]}"; do
    br=${entry%%|*}
    rest=${entry#*|}
    mgr=${rest%%|*}
    ups=${rest#*|}

    pair_healthy "$br" "$ups" && continue

    # Repair, with retries — boot-time races (slow NIC, STP, dhcp) settle quickly.
    for attempt in 1 2 3; do
        repair_pair "$br" "$mgr" "$ups"
        sleep 3
        if pair_healthy "$br" "$ups"; then
            log "bridge '$br' repaired (attempt $attempt)"
            break
        fi
    done

    if ! pair_healthy "$br" "$ups"; then
        log "bridge '$br' is STILL broken after 3 repair attempts (manager=$mgr, uplinks='${ups:-none}')"
        RC=1
    fi
done

exit $RC
