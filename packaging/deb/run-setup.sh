#!/usr/bin/env bash
# =============================================================================
#  auxinux-virtua-setup — invoked by auxinux-virtua-setup.service
#
#  Runs the bundled install.sh in the right mode AFTER the apt transaction has
#  released the dpkg lock. This is what makes `apt install/upgrade auxinux-virtua`
#  behave exactly like:  tar xzf release.tar.gz && bash INSTALL/install.sh [mode]
# =============================================================================
set -euo pipefail

INSTALL_DIR="/opt/auxinux-virtua"
MODE="${AUXINUX_VIRTUA_SETUP_MODE:-update}"
PROGRESS_FILE="${AUXINUX_PROGRESS_FILE:-/run/auxinux-virtua-setup.progress}"
PROGRESS_START_TS="$(date +%s 2>/dev/null || echo 0)"

log() { echo "[auxinux-virtua-setup] $*"; }

write_progress() {
    local status="$1" step="$2" total="$3" pct="$4" label="$5"
    {
        echo "step=${step}"
        echo "total=${total}"
        echo "pct=${pct}"
        echo "status=${status}"
        echo "mode=${MODE}"
        echo "started=${PROGRESS_START_TS}"
        echo "ts=$(date +%s 2>/dev/null || echo 0)"
        echo "label=${label}"
    } > "${PROGRESS_FILE}.tmp" 2>/dev/null \
        && mv -f "${PROGRESS_FILE}.tmp" "${PROGRESS_FILE}" 2>/dev/null || true
}

[[ -f "${INSTALL_DIR}/INSTALL/install.sh" ]] || {
    log "FATAL: ${INSTALL_DIR}/INSTALL/install.sh not found"
    write_progress failed 0 24 0 "${INSTALL_DIR}/INSTALL/install.sh not found"
    exit 1
}

# Wait for any in-progress apt/dpkg transaction to release the lock so our own
# apt calls inside install.sh don't fail. install.sh also passes
# DPkg::Lock::Timeout, this is a belt-and-braces guard with a hard ceiling.
wait_for_apt_lock() {
    local waited=0
    while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 \
       || fuser /var/lib/dpkg/lock >/dev/null 2>&1; do
        [[ $waited -ge 600 ]] && { log "apt lock still held after 600s — proceeding anyway"; break; }
        if [[ $waited -eq 0 ]]; then
            log "waiting for apt/dpkg lock to be released…"
        fi
        write_progress running 0 24 0 "Waiting for apt/dpkg lock (${waited}s)"
        sleep 3; waited=$((waited + 3))
    done
}

case "$MODE" in
    install|update|repair|reset|clean) ;;
    *) log "Unknown mode '${MODE}', defaulting to update"; MODE="update" ;;
esac

log "Provisioning AuxiNux Virtua (mode: ${MODE})…"
write_progress running 0 24 0 "Starting setup service"
wait_for_apt_lock
write_progress running 0 24 0 "Launching installer"

# install.sh expects to be run from a checkout; it derives INSTALL_DIR from its
# own path, so calling it by absolute path is correct.
if [[ "$MODE" == "install" ]]; then
    bash "${INSTALL_DIR}/INSTALL/install.sh"
else
    bash "${INSTALL_DIR}/INSTALL/install.sh" "-${MODE}"
fi

# Consume the one-shot mode file so a manual `systemctl start` later defaults to update.
rm -f /run/auxinux-virtua-setup.env 2>/dev/null || true
log "Provisioning finished (mode: ${MODE})."
