#!/usr/bin/env bash
# =============================================================================
#  Build a self-contained local bootstrap kit for Debian 13.
#
#  The resulting .tar.gz can be copied to a fresh physical Debian 13 server when
#  the AuxiNux APT repository is not available yet. It contains:
#    - virtuaos-cli_<version>_amd64.deb
#    - auxinux-virtua_<version>_amd64.deb
#    - bootstrap-local.sh
#    - README.md
#    - SHA256SUMS
#
#  Usage:
#    ./build-bootstrap-kit.sh --build --docker   # recommended from macOS
#    ./build-bootstrap-kit.sh --build            # auto mode
#    ./build-bootstrap-kit.sh                    # use already-built out/*.deb
#
#  Output:
#    packaging/deb/out/virtua-bootstrap_<version>_amd64.tar.gz
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${SCRIPT_DIR}/out"

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
info(){ echo -e "${C}[INFO]${N} $*"; }
ok(){ echo -e "${G}[OK]${N} $*"; }
warn(){ echo -e "${Y}[WARN]${N} $*"; }
die(){ echo -e "${R}[ERR]${N} $*"; exit 1; }

BUILD=0
MODE="auto"

usage() {
  cat <<'EOF'
Usage:
  ./build-bootstrap-kit.sh [options]

Options:
  --build      Build virtuaos-cli and auxinux-virtua .deb before packaging
  --docker     Force Docker mode when --build is used
  --native     Force native mode when --build is used
  -h, --help   Show this help
EOF
}

for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --docker) MODE="docker" ;;
    --native) MODE="native" ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown argument: ${arg}" ;;
  esac
done

VERSION="$(sed -n 's/^[[:space:]]*node_ver="\([^"]*\)".*/\1/p' "${PROJECT_ROOT}/INSTALL/release.sh" | head -1)"
if [[ -z "${VERSION}" ]]; then
  VERSION="$(node -e "console.log(require('${PROJECT_ROOT}/package.json').version)" 2>/dev/null \
    || sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "${PROJECT_ROOT}/package.json" | head -1)"
fi
[[ -n "${VERSION}" ]] || die "Cannot determine Virtua version"

if [[ "${BUILD}" -eq 1 ]]; then
  build_arg=()
  [[ "${MODE}" != "auto" ]] && build_arg=( "--${MODE}" )
  info "Building virtuaos-cli .deb"
  bash "${SCRIPT_DIR}/build-virtuaos-deb.sh" "${build_arg[@]}"
  info "Building auxinux-virtua .deb"
  bash "${SCRIPT_DIR}/build-deb.sh" "${build_arg[@]}"
else
  warn "Using existing .deb files from ${OUT_DIR}. Pass --build to rebuild first."
fi

shopt -s nullglob
virtua_debs=( "${OUT_DIR}/auxinux-virtua_${VERSION}_amd64.deb" )
virtuaos_debs=( "${OUT_DIR}"/virtuaos-cli_*_amd64.deb )
shopt -u nullglob

[[ "${#virtua_debs[@]}" -eq 1 ]] || die "Missing ${OUT_DIR}/auxinux-virtua_${VERSION}_amd64.deb"
[[ "${#virtuaos_debs[@]}" -ge 1 ]] || die "Missing ${OUT_DIR}/virtuaos-cli_*_amd64.deb"

# If multiple virtuaos-cli builds exist, keep the newest one.
IFS=$'\n' virtuaos_sorted=( $(ls -t "${OUT_DIR}"/virtuaos-cli_*_amd64.deb) )
unset IFS
virtuaos_deb="${virtuaos_sorted[0]}"
virtua_deb="${virtua_debs[0]}"

stage="$(mktemp -d)"
bundle_name="virtua-bootstrap_${VERSION}_amd64"
bundle_dir="${stage}/${bundle_name}"
mkdir -p "${bundle_dir}/packages"

cp "${virtuaos_deb}" "${bundle_dir}/packages/"
cp "${virtua_deb}" "${bundle_dir}/packages/"
install -m 0755 "${SCRIPT_DIR}/bootstrap-local.sh" "${bundle_dir}/bootstrap-local.sh"

cat > "${bundle_dir}/README.md" <<EOF
# Virtua Bootstrap ${VERSION}

Ce kit sert a convertir une installation Debian 13 propre en VirtuaOS + Virtua
quand le depot AuxiNux n'est pas encore disponible.

## Sur le serveur Debian 13

\`\`\`bash
tar xzf ${bundle_name}.tar.gz
cd ${bundle_name}
sudo bash bootstrap-local.sh
\`\`\`

Le depot AuxiNux n'est pas requis pour installer ces deux paquets locaux.
Le serveur doit quand meme avoir acces aux depots Debian/NodeSource/Docker pour
installer les dependances systeme pendant le provisioning.

## Suivi

\`\`\`bash
virtuaos setup
journalctl -fu auxinux-virtua-setup
systemctl status auxinuxvirtual-api auxinuxvirtual-runner --no-pager
virtua status
\`\`\`

## Paquets inclus

- $(basename "${virtuaos_deb}")
- $(basename "${virtua_deb}")
EOF

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "${bundle_dir}" && sha256sum packages/*.deb bootstrap-local.sh README.md > SHA256SUMS )
elif command -v shasum >/dev/null 2>&1; then
  ( cd "${bundle_dir}" && shasum -a 256 packages/*.deb bootstrap-local.sh README.md > SHA256SUMS )
else
  warn "No sha256 tool found; SHA256SUMS will not be created."
fi

mkdir -p "${OUT_DIR}"
tarball="${OUT_DIR}/${bundle_name}.tar.gz"
rm -f "${tarball}"
tar -C "${stage}" -czf "${tarball}" "${bundle_name}"
rm -rf "${stage}"

ok "Bootstrap kit built: ${tarball}"
ok "Size: $(du -sh "${tarball}" | cut -f1)"
echo ""
echo "Copy to the Debian 13 server, then run:"
echo "  tar xzf $(basename "${tarball}")"
echo "  cd ${bundle_name}"
echo "  sudo bash bootstrap-local.sh"
