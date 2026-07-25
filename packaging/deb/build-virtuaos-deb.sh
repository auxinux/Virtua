#!/usr/bin/env bash
# =============================================================================
#  Build the virtuaos-cli .deb (the Rust `virtuaos` host/update manager).
#
#  Ships a single static-ish binary at /usr/bin/virtuaos. This is the package
#  that provides `virtuaos setup` — the live progress TUI watched during an
#  `apt install auxinux-virtua` (auxinux-virtua Recommends: virtuaos-cli).
#
#  The .deb is amd64/Linux, so on macOS it MUST be built in Docker (rust image);
#  on a Debian box with cargo it builds natively. Output lands in the SAME
#  packaging/deb/out/ dir, so publish-repo.sh picks it up alongside auxinux-virtua.
#
#  Usage:
#    ./build-virtuaos-deb.sh            # auto: native cargo if present, else Docker
#    ./build-virtuaos-deb.sh --native   # force native (Debian/Ubuntu + cargo)
#    ./build-virtuaos-deb.sh --docker    # force Docker (macOS / any host w/ Docker)
#    DEPLOY=1 DEPLOY_TARGET=/path ./build-virtuaos-deb.sh  # copy built .deb to staging
#
#  Output: packaging/deb/out/virtuaos-cli_<version>_amd64.deb
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
if [[ -d "${PROJECT_ROOT}/VirtuaOS/virtuaos-cli" ]]; then
  # Self-contained depot kit layout.
  WORKSPACE_ROOT="${PROJECT_ROOT}"
  VIRTUA_DOCKER_ROOT="/src"
else
  # Separate sibling repositories: Virtua/ and VirtuaOS/.
  WORKSPACE_ROOT="$(cd "${PROJECT_ROOT}/.." && pwd)"
  VIRTUA_DOCKER_ROOT="/src/Virtua"
fi
VIRTUAOS_ROOT="${VIRTUAOS_SOURCE_DIR:-${WORKSPACE_ROOT}/VirtuaOS}"
CRATE_DIR="${VIRTUAOS_ROOT}/virtuaos-cli"
OUT_DIR="${SCRIPT_DIR}/out"
PKG_NAME="virtuaos-cli"
BIN_NAME="virtuaos"
DEPLOY="${DEPLOY:-0}"
DEPLOY_TARGET="${DEPLOY_TARGET:-${PROJECT_ROOT}/packaging/deb/repo/VIRTUA/pool/main}"

C='\033[0;36m'; G='\033[0;32m'; R='\033[0;31m'; N='\033[0m'
info(){ echo -e "${C}[INFO]${N} $*"; }
ok(){ echo -e "${G}[OK]${N} $*"; }
die(){ echo -e "${R}[ERR]${N} $*"; exit 1; }

[[ -f "${CRATE_DIR}/Cargo.toml" ]] || die "crate not found: ${CRATE_DIR}"

MODE="auto"
[[ "${1:-}" == "--native" ]] && MODE="native"
[[ "${1:-}" == "--docker" ]] && MODE="docker"
[[ "${1:-}" == "--package-only" ]] && MODE="package-only"
[[ "${1:-}" == "--check-layout" ]] && MODE="check-layout"

# Version: Cargo.toml is the source of truth (override with VERSION=).
VERSION="${VERSION:-}"
if [[ -z "$VERSION" ]]; then
  VERSION="$(sed -n 's/^version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "${CRATE_DIR}/Cargo.toml" | head -1)"
fi
[[ -n "$VERSION" ]] || die "Cannot determine version (set VERSION= or version in Cargo.toml)"

# ── Package an already-built linux/amd64 binary into a .deb ───────────────────
package_binary() {
  local binary="$1"
  command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb not found (run with --docker)"
  [[ -x "$binary" ]] || die "binary not found/executable: $binary"
  if command -v file >/dev/null 2>&1; then
    local binary_info
    binary_info="$(file "$binary")"
    [[ "$binary_info" == *"x86-64"* || "$binary_info" == *"x86_64"* ]] \
      || die "refusing to package non-amd64 binary as amd64: ${binary_info}"
  fi

  local stage pkgroot
  stage="$(mktemp -d)"
  pkgroot="${stage}/pkgroot"
  mkdir -p "${pkgroot}/usr/bin" "${pkgroot}/DEBIAN"

  install -m 0755 "$binary" "${pkgroot}/usr/bin/${BIN_NAME}"

  # Short alias: `vos` → `virtuaos` (relative symlink, resolves to /usr/bin/virtuaos
  # on the target). "vos" = VirtuaOS initials; distinctive, low collision risk.
  ln -sf "${BIN_NAME}" "${pkgroot}/usr/bin/vos"

  cat > "${pkgroot}/DEBIAN/control" <<EOF
Package: ${PKG_NAME}
Version: ${VERSION}
Architecture: amd64
Maintainer: AuxiNux <support@auxinux.ca>
Provides: virtuaos
Section: admin
Priority: optional
Homepage: https://auxinux.ca
Depends: libc6
Description: VirtuaOS host & update manager (virtuaos)
 The \`virtuaos\` CLI manages and updates a VirtuaOS host: component versions,
 service health, apt-based updates of the AuxiNux packages (kernel-virtua,
 auxinux-virtua, virtuaos-cli), and \`virtuaos setup\` — a live progress TUI for
 an in-flight Virtua install/upgrade.
EOF

  # postinst: stamp the VirtuaOS release identity this cli carries onto the host.
  # This is what makes `virtuaos update` (apt) promote an existing 1.0.x host to
  # the release the cli belongs to — dpkg runs this after unpacking the NEW
  # binary, so the freshly-installed `virtuaos` writes the new os-release/issue.
  cat > "${pkgroot}/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "configure" ] && [ -x /usr/bin/virtuaos ]; then
    /usr/bin/virtuaos apply-branding || true
fi
exit 0
EOF
  chmod 0755 "${pkgroot}/DEBIAN/postinst"

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
  ok "Size: $(du -sh "${deb}" | cut -f1)"
}

build_native() {
  command -v cargo >/dev/null 2>&1 || die "cargo not found (run with --docker)"
  [[ "$(uname -s)" == "Linux" ]] || die "native build only makes sense on Linux/amd64 (use --docker on macOS)"
  [[ "$(uname -m)" == "x86_64" ]] || die "native amd64 package build requires x86_64 (use --docker on other hosts)"
  info "cargo build --release (native)"
  ( cd "${CRATE_DIR}" && cargo build --release )
  package_binary "${CRATE_DIR}/target/release/${BIN_NAME}"
}

# ── Dispatcher ────────────────────────────────────────────────────────────────
if [[ "$MODE" == "check-layout" ]]; then
  echo "Virtua root   : ${PROJECT_ROOT}"
  echo "VirtuaOS root : ${VIRTUAOS_ROOT}"
  echo "CLI crate     : ${CRATE_DIR}"
  echo "Layout valid."
elif [[ "$MODE" == "package-only" ]]; then
  # Internal entrypoint: package an already-built binary (used inside Docker).
  [[ -n "${2:-}" ]] || die "--package-only requires a path to the built binary"
  package_binary "$2"
elif [[ "$MODE" == "native" ]] || { [[ "$MODE" == "auto" ]] && [[ "$(uname -s)" == "Linux" ]] && command -v cargo >/dev/null 2>&1; }; then
  build_native
else
  command -v docker >/dev/null 2>&1 || die "Need Docker (macOS) or cargo+dpkg-deb (Debian)."
  docker info >/dev/null 2>&1 || die "Docker daemon not running."
  info "Building linux/amd64 binary + .deb inside Docker (rust:trixie-slim)…"
  docker run --rm \
    --platform linux/amd64 \
    -v "${WORKSPACE_ROOT}:/src" \
    -w "${VIRTUA_DOCKER_ROOT}/packaging/deb" \
    -e VERSION="${VERSION}" \
    -e DEPLOY="${DEPLOY}" \
    -e DEPLOY_TARGET="${DEPLOY_TARGET}" \
    rust:slim \
    bash -c "set -e; apt-get update -qq && apt-get install -y -qq rsync dpkg-dev file >/dev/null 2>&1; \
             cd /src/VirtuaOS/virtuaos-cli && cargo build --release; \
             cd ${VIRTUA_DOCKER_ROOT}/packaging/deb && \
             bash build-virtuaos-deb.sh --package-only /src/VirtuaOS/virtuaos-cli/target/release/${BIN_NAME}"
  ok "Done. Output in ${OUT_DIR}/"
fi
