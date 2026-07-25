#!/usr/bin/env bash
# =============================================================================
#  Sync Debian/Ubuntu partial mirrors for dep.auxinux.ca.
#
#  Default layout:
#    /var/www/dep.auxinux.ca/DEBIAN/
#    /var/www/dep.auxinux.ca/UBUNTU/
#
#  Defaults intentionally mirror only amd64 binaries and no source packages.
#  A full all-arch/all-source mirror is much larger and slower.
# =============================================================================
set -euo pipefail

export HOME="${HOME:-/root}"

DEPOT_ROOT="${DEPOT_ROOT:-/var/www/dep.auxinux.ca}"
LOG_FILE="${LOG_FILE:-/var/log/auxinux-depot-sync.log}"
LOCK_FILE="${LOCK_FILE:-/run/auxinux-depot-sync.lock}"

ARCHES="${ARCHES:-amd64}"
DEBIAN_SUITES="${DEBIAN_SUITES:-trixie,trixie-updates}"
DEBIAN_SECURITY_SUITES="${DEBIAN_SECURITY_SUITES:-trixie-security}"
DEBIAN_SECTIONS="${DEBIAN_SECTIONS:-main,contrib,non-free,non-free-firmware}"

UBUNTU_CODENAME="${UBUNTU_CODENAME:-resolute}"
UBUNTU_SUITES="${UBUNTU_SUITES:-${UBUNTU_CODENAME},${UBUNTU_CODENAME}-updates}"
UBUNTU_SECURITY_SUITES="${UBUNTU_SECURITY_SUITES:-${UBUNTU_CODENAME}-security}"
UBUNTU_SECTIONS="${UBUNTU_SECTIONS:-main,restricted,universe,multiverse}"

DEBIAN_HOST="${DEBIAN_HOST:-deb.debian.org}"
DEBIAN_ROOT="${DEBIAN_ROOT:-debian}"
DEBIAN_SECURITY_HOST="${DEBIAN_SECURITY_HOST:-deb.debian.org}"
DEBIAN_SECURITY_ROOT="${DEBIAN_SECURITY_ROOT:-debian-security}"

UBUNTU_HOST="${UBUNTU_HOST:-archive.ubuntu.com}"
UBUNTU_ROOT="${UBUNTU_ROOT:-ubuntu}"
UBUNTU_SECURITY_HOST="${UBUNTU_SECURITY_HOST:-security.ubuntu.com}"
UBUNTU_SECURITY_ROOT="${UBUNTU_SECURITY_ROOT:-ubuntu}"

METHOD="${METHOD:-http}"
TIMEOUT="${TIMEOUT:-900}"
DRY_RUN="${DRY_RUN:-0}"

DEBIAN_KEYRING="${DEBIAN_KEYRING:-/usr/share/keyrings/debian-archive-keyring.gpg}"
UBUNTU_KEYRING="${UBUNTU_KEYRING:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}"

BASE_OPTS=(
  --method="${METHOD}"
  --arch="${ARCHES}"
  --nosource
  --diff=use
  --rsync-extra=none
  --timeout="${TIMEOUT}"
  --ignore-small-errors
  --nocleanup
)

if [[ "${DRY_RUN}" == "1" ]]; then
  BASE_OPTS+=(--dry-run)
fi

info() {
  printf '[%s] %s\n' "$(date -Is)" "$*"
}

need_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    echo "Run as root: sudo $0" >&2
    exit 1
  fi
}

install_deps() {
  local missing=()
  command -v debmirror >/dev/null 2>&1 || missing+=(debmirror)
  command -v rsync >/dev/null 2>&1 || missing+=(rsync)
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v xz >/dev/null 2>&1 || missing+=(xz-utils)
  command -v bzip2 >/dev/null 2>&1 || missing+=(bzip2)
  command -v gzip >/dev/null 2>&1 || missing+=(gzip)
  [[ -f "${DEBIAN_KEYRING}" ]] || missing+=(debian-archive-keyring)
  [[ -f "${UBUNTU_KEYRING}" ]] || missing+=(ubuntu-keyring)

  if ((${#missing[@]})); then
    info "Installing missing packages: ${missing[*]}"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y "${missing[@]}"
  fi
}

run_debmirror() {
  local label="$1"
  local target="$2"
  shift 2

  info "Starting ${label}"
  debmirror "${BASE_OPTS[@]}" "$@" "${target}"
  info "Finished ${label}"
}

fetch_i18n_path() {
  local base_url="$1"
  local dist="$2"
  local path="$3"
  local target_root="$4"
  local out="${target_root}/dists/${dist}/${path}"
  local url="${base_url}/dists/${dist}/${path}"
  local compressed

  [[ -f "${out}" ]] && return 0
  install -d -m 0755 "$(dirname "${out}")"

  if curl -fsSL --retry 3 --connect-timeout 20 --max-time "${TIMEOUT}" -o "${out}.tmp" "${url}" 2>/dev/null; then
    mv "${out}.tmp" "${out}"
    return 0
  fi
  rm -f "${out}.tmp"

  case "${path}" in
    *.xz|*.bz2|*.gz) return 0 ;;
  esac

  for compressed in "${path}.xz" "${path}.bz2" "${path}.gz"; do
    if [[ -f "${target_root}/dists/${dist}/${compressed}" ]]; then
      case "${compressed}" in
        *.xz) xz -dc "${target_root}/dists/${dist}/${compressed}" > "${out}.tmp" ;;
        *.bz2) bzip2 -dc "${target_root}/dists/${dist}/${compressed}" > "${out}.tmp" ;;
        *.gz) gzip -dc "${target_root}/dists/${dist}/${compressed}" > "${out}.tmp" ;;
      esac
      mv "${out}.tmp" "${out}"
      return 0
    fi
  done

  for compressed in "${path}.xz" "${path}.bz2" "${path}.gz"; do
    if fetch_i18n_path "${base_url}" "${dist}" "${compressed}" "${target_root}" \
      && [[ -f "${target_root}/dists/${dist}/${compressed}" ]]; then
      case "${compressed}" in
        *.xz) xz -dc "${target_root}/dists/${dist}/${compressed}" > "${out}.tmp" ;;
        *.bz2) bzip2 -dc "${target_root}/dists/${dist}/${compressed}" > "${out}.tmp" ;;
        *.gz) gzip -dc "${target_root}/dists/${dist}/${compressed}" > "${out}.tmp" ;;
      esac
      mv "${out}.tmp" "${out}"
      return 0
    fi
  done

  info "WARNING: missing i18n file upstream or unavailable: ${dist}/${path}"
}

sync_i18n_from_release() {
  local label="$1"
  local host="$2"
  local root="$3"
  local target_root="$4"
  local suites_csv="$5"
  local base_url="${METHOD}://${host}/${root}"
  local dist release

  IFS=',' read -r -a dists <<< "${suites_csv}"
  for dist in "${dists[@]}"; do
    release="${target_root}/dists/${dist}/Release"
    [[ -f "${release}" ]] || continue

    info "Syncing i18n indexes for ${label} ${dist}"
    awk '/\/i18n\/Translation-/ {print $3}' "${release}" | sort -u | while IFS= read -r path; do
      [[ -n "${path}" ]] || continue
      fetch_i18n_path "${base_url}" "${dist}" "${path}" "${target_root}"
    done
  done
}

main() {
  if (($#)); then
    echo "Usage: sudo env [VAR=value ...] $0" >&2
    echo "Example: sudo env DRY_RUN=1 ARCHES=none $0" >&2
    exit 2
  fi

  need_root
  install_deps

  install -d -m 0755 "${DEPOT_ROOT}/DEBIAN" "${DEPOT_ROOT}/UBUNTU"
  touch "${LOG_FILE}"
  chmod 0644 "${LOG_FILE}"

  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    info "Another sync is already running; exiting"
    exit 0
  fi

  {
    info "Mirror sync started: root=${DEPOT_ROOT}, arches=${ARCHES}"

    run_debmirror "Debian ${DEBIAN_SUITES}" "${DEPOT_ROOT}/DEBIAN" \
      --host="${DEBIAN_HOST}" \
      --root="${DEBIAN_ROOT}" \
      --dist="${DEBIAN_SUITES}" \
      --section="${DEBIAN_SECTIONS}" \
      --keyring="${DEBIAN_KEYRING}"

    run_debmirror "Debian security ${DEBIAN_SECURITY_SUITES}" "${DEPOT_ROOT}/DEBIAN" \
      --host="${DEBIAN_SECURITY_HOST}" \
      --root="${DEBIAN_SECURITY_ROOT}" \
      --dist="${DEBIAN_SECURITY_SUITES}" \
      --section="${DEBIAN_SECTIONS}" \
      --keyring="${DEBIAN_KEYRING}"

    sync_i18n_from_release "Debian" "${DEBIAN_HOST}" "${DEBIAN_ROOT}" \
      "${DEPOT_ROOT}/DEBIAN" "${DEBIAN_SUITES}"
    sync_i18n_from_release "Debian security" "${DEBIAN_SECURITY_HOST}" "${DEBIAN_SECURITY_ROOT}" \
      "${DEPOT_ROOT}/DEBIAN" "${DEBIAN_SECURITY_SUITES}"

    run_debmirror "Ubuntu ${UBUNTU_SUITES}" "${DEPOT_ROOT}/UBUNTU" \
      --host="${UBUNTU_HOST}" \
      --root="${UBUNTU_ROOT}" \
      --dist="${UBUNTU_SUITES}" \
      --section="${UBUNTU_SECTIONS}" \
      --keyring="${UBUNTU_KEYRING}"

    run_debmirror "Ubuntu security ${UBUNTU_SECURITY_SUITES}" "${DEPOT_ROOT}/UBUNTU" \
      --host="${UBUNTU_SECURITY_HOST}" \
      --root="${UBUNTU_SECURITY_ROOT}" \
      --dist="${UBUNTU_SECURITY_SUITES}" \
      --section="${UBUNTU_SECTIONS}" \
      --keyring="${UBUNTU_KEYRING}"

    sync_i18n_from_release "Ubuntu" "${UBUNTU_HOST}" "${UBUNTU_ROOT}" \
      "${DEPOT_ROOT}/UBUNTU" "${UBUNTU_SUITES}"
    sync_i18n_from_release "Ubuntu security" "${UBUNTU_SECURITY_HOST}" "${UBUNTU_SECURITY_ROOT}" \
      "${DEPOT_ROOT}/UBUNTU" "${UBUNTU_SECURITY_SUITES}"

    chmod -R a+rX "${DEPOT_ROOT}/DEBIAN" "${DEPOT_ROOT}/UBUNTU"
    info "Mirror sync completed"
  } 2>&1 | tee -a "${LOG_FILE}"
}

main "$@"
