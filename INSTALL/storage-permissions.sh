#!/usr/bin/env bash
# =============================================================================
#  AuxiNux Virtua — storage permission helpers, sourced by install.sh.
#
#  Storage pools can hold LXC root filesystems: a container created on a pool
#  keeps its rootfs at <pool>/<container>/rootfs (createContainer in
#  apps/runner/src/handlers/lxc.ts). A rootfs is the guest's "/": its owners
#  and modes belong to the container, never to Virtua. Up to 0.8.2 the
#  installer ran a recursive chown/chmod over the whole data directory and a
#  `find <pools> -type d` that gave root:libvirt-qemu 2775 to every directory
#  it met, rewriting every guest filesystem on each install, update or repair
#  (sudo then refuses to run: "/etc/sudoers.d is owned by gid 64055").
#
#  Rules enforced here:
#    - nothing is ever changed recursively;
#    - a pool walk prunes LXC territory before it can descend into it;
#    - every chown/chmod goes through virtua_guarded_chown/chmod, which refuse
#      any path inside LXC territory.
#  The runner enforces the same rules (apps/runner/src/handlers/lxcRootfsGuard.ts).
#
#  Test-only overrides (unset in production):
#    VIRTUA_ROOT_USER, VIRTUA_ROOT_GROUP  owner of Virtua directories (root:root)
#    VIRTUA_QEMU_USER, VIRTUA_QEMU_GROUP  QEMU identity (auto-detected)
#    LXC_DIR                              container configs (/var/lib/lxc)
# =============================================================================

VIRTUA_POOL_WALK_MAX_DEPTH=32
VIRTUA_LXC_ROOTFS_REGISTRY=()

_virtua_log_info() {
    if declare -F info >/dev/null; then info "$*"; else printf '[INFO]  %s\n' "$*"; fi
}

_virtua_log_warn() {
    if declare -F warn >/dev/null; then warn "$*"; else printf '[WARN]  %s\n' "$*" >&2; fi
}

virtua_detect_qemu_identity() {
    if [[ -n "${VIRTUA_QEMU_USER:-}" ]]; then
        VIRTUA_QEMU_GROUP="${VIRTUA_QEMU_GROUP:-$VIRTUA_QEMU_USER}"
        return 0
    fi
    VIRTUA_QEMU_USER=""
    VIRTUA_QEMU_GROUP=""
    local candidate
    for candidate in libvirt-qemu qemu; do
        if id "$candidate" >/dev/null 2>&1; then
            VIRTUA_QEMU_USER="$candidate"
            VIRTUA_QEMU_GROUP="$candidate"
            return 0
        fi
    done
    return 0
}

# `rootfs` itself, or a copy kept beside it (`rootfs.rollback-<ts>`).
_virtua_is_rootfs_name() {
    [[ "$1" == rootfs || "$1" == rootfs.* ]]
}

# Host directories named by an lxc.rootfs.path value. "dir:/x", "/x" and
# "btrfs:/x" name one directory, "overlay:/lower:/upper" two; zfs:, lvm: and
# rbd: specs are not host paths (LXC mounts them at <lxc dir>/<name>/rootfs).
_virtua_rootfs_spec_paths() {
    local spec="$1" part
    local -a parts
    spec="${spec%"${spec##*[![:space:]]}"}"
    case "$spec" in
        /*) ;;
        [A-Za-z]*:/*) spec="${spec#*:}" ;;
        *) return 0 ;;
    esac
    IFS=':' read -r -a parts <<< "$spec"
    for part in "${parts[@]}"; do
        if [[ "$part" == /* ]]; then
            realpath -m "$part"
        fi
    done
    return 0
}

# Every directory that holds the rootfs of a container declared on this host.
virtua_load_lxc_rootfs_registry() {
    local lxc_dir="${LXC_DIR:-/var/lib/lxc}" cfg spec rootfs
    VIRTUA_LXC_ROOTFS_REGISTRY=()
    for cfg in "$lxc_dir"/*/config; do
        [[ -f "$cfg" ]] || continue
        VIRTUA_LXC_ROOTFS_REGISTRY+=("$(realpath -m "${cfg%/config}/rootfs")")
        spec="$(sed -n 's/^[[:space:]]*lxc\.rootfs\.path[[:space:]]*=[[:space:]]*//p' "$cfg" | tail -n 1)"
        [[ -n "$spec" ]] || continue
        while IFS= read -r rootfs; do
            [[ -n "$rootfs" ]] && VIRTUA_LXC_ROOTFS_REGISTRY+=("$rootfs")
        done < <(_virtua_rootfs_spec_paths "$spec")
    done
    VIRTUA_LXC_ROOTFS_REGISTRY_LOADED=1
    return 0
}

# Called outside command substitutions so the registry survives for the next call.
_virtua_ensure_lxc_rootfs_registry() {
    [[ "${VIRTUA_LXC_ROOTFS_REGISTRY_LOADED:-0}" == 1 ]] || virtua_load_lxc_rootfs_registry
}

_virtua_in_registry() {
    local candidate="$1" rootfs
    for rootfs in "${VIRTUA_LXC_ROOTFS_REGISTRY[@]}"; do
        [[ "$candidate" == "$rootfs" ]] && return 0
    done
    return 1
}

# A directory holding a Linux root filesystem: etc/ plus usr/, bin/ or sbin/.
# Catches a rootfs that is neither named "rootfs" nor declared on this host,
# e.g. a container of another node sharing the pool.
virtua_looks_like_linux_root() {
    local dir="$1"
    [[ -e "$dir/etc" || -L "$dir/etc" ]] || return 1
    [[ -e "$dir/usr" || -L "$dir/usr" || -e "$dir/bin" || -L "$dir/bin" || -e "$dir/sbin" || -L "$dir/sbin" ]]
}

# Prints why a path must never receive a Virtua permission change and
# succeeds, or fails silently when the path is fair game. The physical path
# and each of its ancestors (except "/") are checked.
virtua_lxc_territory_reason() {
    local current
    current="$(realpath -m "$1")"
    while [[ -n "$current" && "$current" != "/" ]]; do
        if _virtua_is_rootfs_name "${current##*/}"; then
            printf 'inside an LXC rootfs (%s)' "$current"
            return 0
        fi
        if _virtua_in_registry "$current"; then
            printf 'inside the rootfs of a registered LXC container (%s)' "$current"
            return 0
        fi
        if [[ -d "$current" ]] && virtua_looks_like_linux_root "$current"; then
            printf 'inside a Linux root filesystem (%s)' "$current"
            return 0
        fi
        current="${current%/*}"
    done
    return 1
}

virtua_guarded_chown() {
    local owner="$1" target="$2" reason
    _virtua_ensure_lxc_rootfs_registry
    if reason="$(virtua_lxc_territory_reason "$target")"; then
        _virtua_log_warn "Refusing to chown ${target}: ${reason}"
        return 1
    fi
    chown "$owner" "$target" 2>/dev/null || true
}

virtua_guarded_chmod() {
    local mode="$1" target="$2" reason
    _virtua_ensure_lxc_rootfs_registry
    if reason="$(virtua_lxc_territory_reason "$target")"; then
        _virtua_log_warn "Refusing to chmod ${target}: ${reason}"
        return 1
    fi
    chmod "$mode" "$target" 2>/dev/null || true
}

# Walks a pools root and prints NUL-terminated records: "F<path>" for each VM
# disk image, "P<path>" for each LXC directory pruned. Never follows symlinks
# and never enters LXC territory.
virtua_list_pool_disk_images() {
    local root="$1" saved
    [[ -d "$root" ]] || return 0
    virtua_load_lxc_rootfs_registry
    saved="$(shopt -p nullglob dotglob || true)"
    shopt -s nullglob dotglob
    _virtua_walk_pool "$(realpath -m "$root")" 0
    eval "$saved"
    return 0
}

_virtua_walk_pool() {
    local dir="$1" depth="$2" entry
    [[ "$depth" -lt "$VIRTUA_POOL_WALK_MAX_DEPTH" ]] || return 0
    for entry in "$dir"/*; do
        [[ -L "$entry" ]] && continue
        if [[ -d "$entry" ]]; then
            if _virtua_is_rootfs_name "${entry##*/}" || _virtua_in_registry "$entry" || virtua_looks_like_linux_root "$entry"; then
                printf 'P%s\0' "$entry"
                continue
            fi
            _virtua_walk_pool "$entry" $((depth + 1))
        elif [[ -f "$entry" ]]; then
            case "${entry,,}" in
                *.qcow2|*.img|*.raw|*.vmdk) printf 'F%s\0' "$entry" ;;
            esac
        fi
    done
    return 0
}

_virtua_normalize_storage_dir() {
    local dir="$1"
    if [[ -n "$VIRTUA_QEMU_GROUP" ]]; then
        virtua_guarded_chown "${VIRTUA_ROOT_USER:-root}:${VIRTUA_QEMU_GROUP}" "$dir" || return 0
        virtua_guarded_chmod 2775 "$dir" || return 0
    else
        virtua_guarded_chmod 0755 "$dir" || return 0
    fi
}

_virtua_normalize_disk_image() {
    local disk="$1"
    if [[ -n "$VIRTUA_QEMU_USER" ]]; then
        virtua_guarded_chown "${VIRTUA_QEMU_USER}:${VIRTUA_QEMU_GROUP}" "$disk" || return 0
        virtua_guarded_chmod 0660 "$disk" || return 0
    else
        virtua_guarded_chmod 0666 "$disk" || return 0
    fi
}

# Create Virtua's own directories and set THEIR owner and mode — never their
# contents: pools and snapshots hold container filesystems.
virtua_prepare_data_dirs() {
    local data_dir="$1" dir key
    shift
    local owner="${VIRTUA_ROOT_USER:-root}:${VIRTUA_ROOT_GROUP:-root}"
    install -d -m 0755 "$data_dir" "$@"
    for dir in "$data_dir" "$@"; do
        virtua_guarded_chown "$owner" "$dir" || continue
        virtua_guarded_chmod 0755 "$dir" || true
    done
    chmod 0711 "$data_dir"
    # The old recursive chmod left private keys 0755; ssl.ts writes them 0600.
    for key in "$data_dir/ssl/key.pem" "$data_dir/ssl/account.key.pem"; do
        if [[ -f "$key" && ! -L "$key" ]]; then
            chmod 0600 "$key"
        fi
    done
    return 0
}

# The data directory mixes portal state (db, ssl, usb map, markers) with guest
# data: pools (VM disks, LXC root filesystems, backups), LXC snapshots, VM disk
# images, templates and Docker compose projects. reset/clean and the automatic
# recovery of an aborted install remove the portal state only — up to 0.8.2
# they deleted the whole directory, taking every pool-backed container with it.
VIRTUA_GUEST_DATA_ENTRIES=(pools snapshots images templates compose)

virtua_remove_portal_data() {
    local data_dir="$1" entry saved
    [[ -d "$data_dir" ]] || return 0
    saved="$(shopt -p nullglob dotglob || true)"
    shopt -s nullglob dotglob
    for entry in "$data_dir"/*; do
        if [[ " ${VIRTUA_GUEST_DATA_ENTRIES[*]} " == *" ${entry##*/} "* ]]; then
            _virtua_log_info "Kept guest data: $entry"
            continue
        fi
        rm -rf -- "$entry"
        _virtua_log_info "Removed: $entry"
    done
    eval "$saved"
    return 0
}

# Let QEMU reach Virtua storage: the pools root, each pool directory and every
# directory on the way to a VM disk image get root:<qemu group> 2775, disk
# images get <qemu user>:<qemu group> 0660. Nothing else is touched, and
# nothing inside an LXC root filesystem ever is.
virtua_fix_pool_permissions() {
    local pools_root="$1" root pool record target parent pruned=0 disks=0
    local -A normalized=()
    [[ -d "$pools_root" ]] || return 0
    virtua_detect_qemu_identity
    virtua_load_lxc_rootfs_registry
    root="$(realpath -m "$pools_root")"

    _virtua_normalize_storage_dir "$root"
    normalized[$root]=1
    for pool in "$root"/*; do
        [[ -d "$pool" && ! -L "$pool" ]] || continue
        _virtua_normalize_storage_dir "$pool"
        normalized[$pool]=1
    done

    while IFS= read -r -d '' record; do
        target="${record:1}"
        case "${record:0:1}" in
            P) pruned=$((pruned + 1)) ;;
            F)
                disks=$((disks + 1))
                _virtua_normalize_disk_image "$target"
                # The walk never yields a disk below LXC territory, so every
                # directory between the disk and its pool is plain storage.
                parent="${target%/*}"
                while [[ "$parent" == "$root"/* && -z "${normalized[$parent]+set}" ]]; do
                    normalized[$parent]=1
                    _virtua_normalize_storage_dir "$parent"
                    parent="${parent%/*}"
                done
                ;;
        esac
    done < <(virtua_list_pool_disk_images "$root")

    _virtua_log_info "Storage pools: ${disks} disk image(s) normalised, ${pruned} LXC root filesystem(s) left untouched"
    return 0
}

# Traces the recursive permission changes of Virtua <= 0.8.2 leave in a rootfs,
# one line each. Detection only: the original owners and modes are gone.
# Keep in sync with auditRootfsPermissions() in apps/runner/src/handlers/lxcRootfsGuard.ts.
virtua_rootfs_damage_signs() {
    local rootfs="$1" qemu_gid="$2" rel target st uid gid mode
    for rel in "" etc etc/sudoers.d usr usr/bin var var/lib var/log var/tmp root home tmp; do
        target="$rootfs${rel:+/$rel}"
        [[ -d "$target" && ! -L "$target" ]] || continue
        st="$(stat -c '%g %a' "$target" 2>/dev/null)" || continue
        gid="${st%% *}"
        mode="${st##* }"
        if [[ -n "$qemu_gid" && "$gid" == "$qemu_gid" ]]; then
            echo "/${rel}: group ${VIRTUA_QEMU_GROUP:-qemu} (gid ${gid})"
        fi
        if [[ "$mode" == 2775 ]]; then
            echo "/${rel}: mode 2775 on a system directory"
        fi
    done
    for rel in tmp var/tmp; do
        target="$rootfs/$rel"
        [[ -d "$target" && ! -L "$target" ]] || continue
        mode="$(stat -c '%a' "$target" 2>/dev/null)" || continue
        if (( (8#$mode & 8#1000) == 0 )); then
            echo "/${rel}: sticky bit missing (mode ${mode})"
        fi
    done
    target="$rootfs/etc/shadow"
    if [[ -f "$target" && ! -L "$target" ]] && mode="$(stat -c '%a' "$target" 2>/dev/null)"; then
        if (( (8#$mode & 8#004) != 0 )); then
            echo "/etc/shadow: readable by every user (mode ${mode})"
        fi
    fi
    for rel in usr/bin/sudo usr/bin/su usr/bin/passwd bin/su; do
        target="$rootfs/$rel"
        [[ -f "$target" && ! -L "$target" ]] || continue
        st="$(stat -c '%u %a' "$target" 2>/dev/null)" || continue
        uid="${st%% *}"
        mode="${st##* }"
        if [[ "$uid" == 0 ]] && (( (8#$mode & 8#4000) == 0 )); then
            echo "/${rel}: setuid bit missing (mode ${mode})"
        fi
    done
    return 0
}

# Warn about every container rootfs (and Virtua snapshot of one) that carries
# those traces. Never modifies anything. Sets VIRTUA_DAMAGED_LXC_COUNT.
virtua_report_damaged_lxc_rootfs() {
    local pools_root="$1" snapshots_root="$2" lxc_dir="${LXC_DIR:-/var/lib/lxc}"
    local cfg name rootfs label signs line qemu_gid="" i
    local -a labels=() paths=()
    local -A seen=()
    VIRTUA_DAMAGED_LXC_COUNT=0
    virtua_detect_qemu_identity
    if [[ -n "$VIRTUA_QEMU_GROUP" ]]; then
        qemu_gid="$(getent group "$VIRTUA_QEMU_GROUP" 2>/dev/null | cut -d: -f3)" || qemu_gid=""
    fi

    for cfg in "$lxc_dir"/*/config; do
        [[ -f "$cfg" ]] || continue
        name="${cfg%/config}"
        name="${name##*/}"
        while IFS= read -r rootfs; do
            [[ -n "$rootfs" ]] || continue
            labels+=("container ${name}")
            paths+=("$rootfs")
        done < <(
            realpath -m "${cfg%/config}/rootfs"
            _virtua_rootfs_spec_paths "$(sed -n 's/^[[:space:]]*lxc\.rootfs\.path[[:space:]]*=[[:space:]]*//p' "$cfg" | tail -n 1)"
        )
    done
    # Containers of other nodes sharing a pool, or left behind by a failed delete.
    for rootfs in "$pools_root"/*/*/rootfs; do
        [[ -d "$rootfs" ]] || continue
        name="${rootfs%/rootfs}"
        labels+=("unregistered container ${name##*/}")
        paths+=("$(realpath -m "$rootfs")")
    done
    for rootfs in "$snapshots_root"/*/*/rootfs "$snapshots_root"/*/*/container/rootfs; do
        [[ -d "$rootfs" ]] || continue
        name="${rootfs#"$snapshots_root"/}"
        labels+=("snapshot ${name%%/rootfs*}")
        paths+=("$(realpath -m "$rootfs")")
    done

    for i in "${!paths[@]}"; do
        rootfs="${paths[$i]}"
        [[ -d "$rootfs" && -z "${seen[$rootfs]+set}" ]] || continue
        seen[$rootfs]=1
        label="${labels[$i]}"
        signs="$(virtua_rootfs_damage_signs "$rootfs" "$qemu_gid")"
        [[ -n "$signs" ]] || continue
        VIRTUA_DAMAGED_LXC_COUNT=$((VIRTUA_DAMAGED_LXC_COUNT + 1))
        _virtua_log_warn "LXC ${label}: ${rootfs} shows permission damage from Virtua 0.8.2 or earlier:"
        while IFS= read -r line; do
            _virtua_log_warn "    ${line}"
        done <<< "$signs"
    done

    if [[ "$VIRTUA_DAMAGED_LXC_COUNT" -gt 0 ]]; then
        _virtua_log_warn "${VIRTUA_DAMAGED_LXC_COUNT} LXC root filesystem(s) were altered by an earlier Virtua installer."
        _virtua_log_warn "Virtua no longer touches container filesystems, but it cannot undo that damage: the original owners and modes were overwritten."
        _virtua_log_warn "Restore these containers from a backup archive taken before the damage (archives kept their permissions); Virtua snapshots were altered too."
        _virtua_log_warn "Do not reset owners or modes across a whole rootfs: that would also destroy the permissions that are still correct. Details: Virtua UI > Health."
    fi
    return 0
}
