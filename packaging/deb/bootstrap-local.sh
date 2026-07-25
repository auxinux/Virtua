#!/usr/bin/env bash
# =============================================================================
#  Local bootstrap installer for a fresh Debian 13 host.
#
#  This script is meant to run from the extracted virtua-bootstrap_*.tar.gz kit.
#  It installs the local VirtuaOS/Virtua .deb files without needing the AuxiNux
#  APT repository, then lets auxinux-virtua-setup.service run the normal host
#  provisioning.
#
#  Usage on the target server:
#    sudo bash bootstrap-local.sh
#
#  Notes:
#  - The AuxiNux repo is NOT required.
#  - Internet access to Debian/NodeSource/Docker repositories is still required
#    unless all system dependencies are already available locally.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="${SCRIPT_DIR}/packages"

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
info(){ echo -e "${C}[INFO]${N} $*"; }
ok(){ echo -e "${G}[OK]${N} $*"; }
warn(){ echo -e "${Y}[WARN]${N} $*"; }
die(){ echo -e "${R}[ERR]${N} $*"; exit 1; }

is_supported_debian13_base() {
  case "${ID:-}" in
    debian|virtuaos|auxinux|auxinuxos|auxinux-virtua|virtua) ;;
    *)
      case " ${ID_LIKE:-} " in
        *" debian "*) ;;
        *) case "${PRETTY_NAME:-} ${NAME:-}" in *VirtuaOS*|*AuxinuxOS*|*AuxiNuxOS*) ;; *) return 1 ;; esac ;;
      esac
      ;;
  esac

  [[ "${VERSION_CODENAME:-}" == "trixie" || "${VERSION_ID:-}" == "13" ]]
}

APT_UPDATE=1
WATCH=1

usage() {
  cat <<'EOF'
Usage:
  sudo bash bootstrap-local.sh [options]

Options:
  --no-apt-update   Do not run apt-get update before installing local packages
  --no-watch        Do not open the provisioning progress watcher after install
  -h, --help        Show this help
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-apt-update) APT_UPDATE=0 ;;
    --no-watch) WATCH=0 ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: ${arg}" ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || die "Run this script as root: sudo bash bootstrap-local.sh"
[[ -d "${PKG_DIR}" ]] || die "Missing packages directory: ${PKG_DIR}"

if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  if ! is_supported_debian13_base; then
    warn "This kit targets Debian 13 / VirtuaOS / AuxinuxOS. Detected: ${PRETTY_NAME:-unknown OS}."
  fi
else
  warn "Cannot read /etc/os-release; continuing anyway."
fi

shopt -s nullglob
virtuaos_debs=( "${PKG_DIR}"/virtuaos-cli_*_amd64.deb )
virtua_debs=( "${PKG_DIR}"/auxinux-virtua_*_amd64.deb )
shopt -u nullglob

[[ "${#virtuaos_debs[@]}" -ge 1 ]] || die "Missing virtuaos-cli .deb in ${PKG_DIR}"
[[ "${#virtua_debs[@]}" -ge 1 ]] || die "Missing auxinux-virtua .deb in ${PKG_DIR}"
[[ "${#virtuaos_debs[@]}" -eq 1 ]] || die "Expected one virtuaos-cli .deb, found ${#virtuaos_debs[@]}"
[[ "${#virtua_debs[@]}" -eq 1 ]] || die "Expected one auxinux-virtua .deb, found ${#virtua_debs[@]}"

info "Local packages:"
echo "  - ${virtuaos_debs[0]}"
echo "  - ${virtua_debs[0]}"

if [[ -f "${SCRIPT_DIR}/SHA256SUMS" ]] && command -v sha256sum >/dev/null 2>&1; then
  info "Verifying SHA256SUMS"
  ( cd "${SCRIPT_DIR}" && sha256sum -c SHA256SUMS )
else
  warn "SHA256SUMS not found or sha256sum unavailable; skipping checksum verification."
fi

export DEBIAN_FRONTEND=noninteractive

if [[ "${APT_UPDATE}" -eq 1 ]]; then
  info "Refreshing Debian package metadata"
  apt-get update
fi

info "Installing local VirtuaOS + Virtua packages"
apt-get install -y "${virtuaos_debs[0]}" "${virtua_debs[0]}"

systemctl daemon-reload || true

ok "Local packages installed."
echo ""
info "The Virtua provisioning now runs in the background via auxinux-virtua-setup.service."
echo "Useful checks:"
echo "  systemctl status auxinux-virtua-setup --no-pager"
echo "  journalctl -fu auxinux-virtua-setup"
echo "  virtuaos setup"
echo "  virtua status"
echo ""

if [[ "${WATCH}" -eq 1 ]]; then
  if command -v virtuaos >/dev/null 2>&1; then
    info "Opening VirtuaOS provisioning watcher. Press Ctrl+C to leave the watcher only."
    virtuaos setup || true
  else
    info "virtuaos command not found yet; following systemd setup logs."
    journalctl -fu auxinux-virtua-setup || true
  fi
else
  ok "Watcher disabled by --no-watch."
fi
