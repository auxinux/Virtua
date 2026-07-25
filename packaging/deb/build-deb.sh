#!/usr/bin/env bash
# =============================================================================
#  Build the auxinux-virtua .deb
#
#  The package ships the project SOURCE under /opt/auxinux-virtua and provisions
#  the host via the bundled INSTALL/install.sh (run by auxinux-virtua-setup
#  systemd unit after apt). No compilation happens at package-build time, so this
#  works the same on macOS (via Docker) or a Debian box (native dpkg-deb).
#
#  Usage:
#    ./build-deb.sh            # auto: native dpkg-deb if present, else Docker
#    ./build-deb.sh --native   # force native (Debian/Ubuntu host)
#    ./build-deb.sh --docker    # force Docker (macOS / any host with Docker)
#    DEPLOY=1 DEPLOY_TARGET=/path ./build-deb.sh  # copy built .deb to staging
#
#  Output: packaging/deb/out/auxinux-virtua_<version>_amd64.deb
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${SCRIPT_DIR}/out"
PKG_NAME="auxinux-virtua"
DEPLOY="${DEPLOY:-0}"
DEPLOY_TARGET="${DEPLOY_TARGET:-${PROJECT_ROOT}/packaging/deb/repo/VIRTUA/pool/main}"

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
info(){ echo -e "${C}[INFO]${N} $*"; }
ok(){ echo -e "${G}[OK]${N} $*"; }
warn(){ echo -e "${Y}[WARN]${N} $*"; }
die(){ echo -e "${R}[ERR]${N} $*"; exit 1; }

MODE="auto"
[[ "${1:-}" == "--native" ]] && MODE="native"
[[ "${1:-}" == "--docker" ]] && MODE="docker"

# Version: single source of truth is release.sh's node_ver (same value that stamps
# every package.json and the web footer). Allow VERSION=… to override; fall back to
# the root package.json if release.sh can't be read.
VERSION="${VERSION:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(sed -n 's/^[[:space:]]*node_ver="\([^"]*\)".*/\1/p' "${PROJECT_ROOT}/INSTALL/release.sh" | head -1)"
fi
if [[ -z "$VERSION" ]]; then
  VERSION="$(node -e "console.log(require('${PROJECT_ROOT}/package.json').version)" 2>/dev/null \
    || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${PROJECT_ROOT}/package.json" | head -1)"
fi
[[ -n "$VERSION" ]] || die "Cannot determine version (set VERSION= or node_ver in INSTALL/release.sh)"

# ── The actual packaging steps (run natively on Debian, possibly inside Docker) ──
do_build_native() {
  command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb not found (run with --docker on macOS)"
  command -v rsync >/dev/null 2>&1 || die "rsync not found"

  local stage pkgroot
  stage="$(mktemp -d)"
  pkgroot="${stage}/pkgroot"
  mkdir -p "${pkgroot}/opt/auxinux-virtua" \
           "${pkgroot}/lib/systemd/system" \
           "${pkgroot}/DEBIAN"

  info "Staging project source → /opt/auxinux-virtua"
  rsync -a \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.vscode' \
    --exclude='.idea' \
    --exclude='*.env' \
    --exclude='*.log' \
    --exclude='.DS_Store' \
    --exclude='*.iso' \
    --exclude='packaging/deb/out' \
    --exclude='packaging/deb/repo' \
    --exclude='Client_Desktop' \
    --exclude='target' \
    --exclude='*.iso' \
    --exclude='*.deb' \
    --exclude='*.tar.gz' \
    --exclude='*.tar.zst' \
    --exclude='dist' \
    "${PROJECT_ROOT}/" "${pkgroot}/opt/auxinux-virtua/"

  info "Installing systemd setup unit"
  install -m 0644 "${SCRIPT_DIR}/systemd/auxinux-virtua-setup.service" \
    "${pkgroot}/lib/systemd/system/auxinux-virtua-setup.service"

  info "Writing DEBIAN control + maintainer scripts (version ${VERSION})"
  sed "s/@VERSION@/${VERSION}/" "${SCRIPT_DIR}/debian/control" > "${pkgroot}/DEBIAN/control"
  for s in postinst prerm postrm; do
    install -m 0755 "${SCRIPT_DIR}/debian/${s}" "${pkgroot}/DEBIAN/${s}"
  done
  # run-setup.sh must be executable inside the payload.
  chmod 0755 "${pkgroot}/opt/auxinux-virtua/packaging/deb/run-setup.sh" 2>/dev/null || true
  chmod 0755 "${pkgroot}/opt/auxinux-virtua/INSTALL/vdm-install.sh" 2>/dev/null || true
  chmod 0755 "${pkgroot}/opt/auxinux-virtua/INSTALL/vdm-ha-agent" 2>/dev/null || true

  # Declare /var/lib/auxinuxvirtual + .env as not-shipped (created at runtime).
  mkdir -p "${OUT_DIR}"
  local deb="${OUT_DIR}/${PKG_NAME}_${VERSION}_amd64.deb"
  info "Building ${deb}"
  dpkg-deb --root-owner-group --build "${pkgroot}" "${deb}"

  if [[ "${DEPLOY}" == "1" ]]; then
    info "Deploying ${deb} -> ${DEPLOY_TARGET}"
    if [[ "${DEPLOY_TARGET}" != *:* ]]; then
      mkdir -p "${DEPLOY_TARGET}"
    fi
    rsync -a "${deb}" "${DEPLOY_TARGET%/}/"
  fi

  rm -rf "${stage}"
  ok "Package built: ${deb}"
  dpkg-deb --info "${deb}" | sed 's/^/    /' || true
  echo ""
  ok "Size: $(du -sh "${deb}" | cut -f1)"
}

# ── Dispatcher ────────────────────────────────────────────────────────────────
if [[ "$MODE" == "native" ]] || { [[ "$MODE" == "auto" ]] && command -v dpkg-deb >/dev/null 2>&1; }; then
  do_build_native
else
  command -v docker >/dev/null 2>&1 || die "Need Docker (macOS) or dpkg-deb (Debian). Neither found."
  docker info >/dev/null 2>&1 || die "Docker daemon not running."
  info "Building inside Debian container (dpkg-deb)…"
  docker run --rm \
    -v "${PROJECT_ROOT}:/src" \
    -w /src/packaging/deb \
    -e VERSION="${VERSION}" \
    -e DEPLOY="${DEPLOY}" \
    -e DEPLOY_TARGET="${DEPLOY_TARGET}" \
    debian:trixie-slim \
    bash -c "apt-get update -qq && apt-get install -y -qq rsync dpkg-dev nodejs >/dev/null 2>&1 || apt-get install -y -qq rsync dpkg-dev >/dev/null 2>&1; bash build-deb.sh --native"
  ok "Done. Output in ${OUT_DIR}/"
fi
