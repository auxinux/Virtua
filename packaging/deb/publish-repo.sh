#!/usr/bin/env bash
# =============================================================================
#  Publish / refresh the AuxiNux Virtua APT packages into your existing repo:
#      https://dep.auxinux.ca/VIRTUA   (suite: virtua, component: main)
#
#  This lives ALONGSIDE your kernel suite in the SAME repository root and is
#  signed with the SAME GPG key, so clients trust ONE key for everything:
#
#      VIRTUA/
#        dists/kernel/…                    <- kernel suite published separately
#        dists/virtua/Release InRelease Release.gpg
#        dists/virtua/main/binary-amd64/Packages[.gz]
#        pool/main/auxinux-virtua_<ver>_amd64.deb
#        virtua-archive-keyring.{asc,gpg}   <- SAME signing key as KERNEL
#        virtua.sources                    <- deb822 client file (key inlined)
#
#  Usage:
#    ./publish-repo.sh [extra/*.deb ...]                 # uses repo@auxinux.ca
#    GPG_KEY_ID=<id-or-email> ./publish-repo.sh
#
#  Env (optional):
#    GPG_KEY_ID   signing key (default: repo@auxinux.ca — same as the kernel)
#    REPO_DIR     output dir   (default: packaging/deb/repo/VIRTUA)
#    SUITE        suite        (default: virtua)
#    COMPONENT    component    (default: main)
#    ARCH         architecture (default: amd64)
#    BASE_URI     public URL   (default: https://dep.auxinux.ca/VIRTUA)
#    ORIGIN/LABEL Release meta  (default: AuxiNux / VIRTUA)
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/out"
REPO_DIR="${REPO_DIR:-${SCRIPT_DIR}/repo/VIRTUA}"
SUITE="${SUITE:-virtua}"
COMPONENT="${COMPONENT:-main}"
ARCH="${ARCH:-amd64}"
BASE_URI="${BASE_URI:-https://dep.auxinux.ca/VIRTUA}"
ORIGIN="${ORIGIN:-AuxiNux}"
LABEL="${LABEL:-VIRTUA}"
# Same signing key as the kernel repo so clients need only ONE key.
GPG_KEY_ID="${GPG_KEY_ID:-repo@auxinux.ca}"
KEYRING_NAME="${KEYRING_NAME:-virtua-archive-keyring.gpg}"
KEYRING_ASC="${KEYRING_ASC:-virtua-archive-keyring.asc}"
# Optional direct deploy into the live web root (run with --deploy). Only the
# 'virtua' suite + pool + public keyring are pushed; the kernel suite/pool are
# never touched here because they are managed by the kernel builder.
DEPLOY="${DEPLOY:-0}"
DEPLOY_DIR="${DEPLOY_DIR:-/var/www/dep.auxinux.ca/VIRTUA}"

C='\033[0;36m'; G='\033[0;32m'; R='\033[0;31m'; N='\033[0m'
info(){ echo -e "${C}[INFO]${N} $*"; }
ok(){ echo -e "${G}[OK]${N} $*"; }
die(){ echo -e "${R}[ERR]${N} $*"; exit 1; }

run_native() {
  command -v apt-ftparchive >/dev/null 2>&1 || die "apt-ftparchive missing (apt-utils). Use Docker mode."
  command -v dpkg-deb >/dev/null 2>&1 || die "dpkg-deb missing (dpkg)."
  command -v dpkg >/dev/null 2>&1 || die "dpkg missing."
  command -v gpg >/dev/null 2>&1 || die "gpg missing."
  [[ -n "${GPG_KEY_ID:-}" ]] || die "Set GPG_KEY_ID to your signing key id/email."

  local pooldir="pool/${COMPONENT}"
  local bindir="dists/${SUITE}/${COMPONENT}/binary-${ARCH}"
  mkdir -p "${REPO_DIR}/${pooldir}" "${REPO_DIR}/${bindir}"

  info "Collecting .deb packages into ${pooldir}"
  shopt -s nullglob
  local debs=( "${OUT_DIR}"/*.deb "$@" )
  [[ ${#debs[@]} -gt 0 ]] || die "No .deb found in ${OUT_DIR} (run build-deb.sh first)."
  for d in "${debs[@]}"; do
    [[ -f "$d" ]] && cp -f "$d" "${REPO_DIR}/${pooldir}/"
  done

  cd "${REPO_DIR}"

  # Keep historical .deb files in the shared pool, but advertise only the newest
  # Debian version of each package/architecture in the Virtua suite. This avoids
  # rebuilding the index from every old application release while leaving the
  # kernel suite and rollback artifacts untouched.
  local index_root pkg version deb_arch key
  index_root="$(mktemp -d)"
  mkdir -p "${index_root}/${pooldir}"
  declare -A latest_version=()
  declare -A latest_deb=()
  while IFS= read -r -d '' d; do
    pkg="$(dpkg-deb -f "$d" Package)"
    version="$(dpkg-deb -f "$d" Version)"
    deb_arch="$(dpkg-deb -f "$d" Architecture)"
    [[ "$deb_arch" == "$ARCH" || "$deb_arch" == "all" ]] || continue
    key="${pkg}:${deb_arch}"
    if [[ -z "${latest_version[$key]+x}" ]] || dpkg --compare-versions "$version" gt "${latest_version[$key]}"; then
      latest_version[$key]="$version"
      latest_deb[$key]="$d"
    fi
  done < <(find "${pooldir}" -maxdepth 1 -type f -name '*.deb' -print0)
  [[ ${#latest_deb[@]} -gt 0 ]] || die "No indexable ${ARCH}/all package found in ${pooldir}."
  for key in "${!latest_deb[@]}"; do
    ln -s "${REPO_DIR}/${latest_deb[$key]}" "${index_root}/${pooldir}/$(basename "${latest_deb[$key]}")"
  done

  info "Generating Packages with the newest version of each package (Filename → ${pooldir}/…)"
  (cd "${index_root}" && apt-ftparchive packages "${pooldir}") > "${bindir}/Packages"
  rm -rf "${index_root}"
  gzip -9kf "${bindir}/Packages"

  info "Generating dists/${SUITE}/Release"
  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin="${ORIGIN}" \
    -o APT::FTPArchive::Release::Label="${LABEL}" \
    -o APT::FTPArchive::Release::Suite="${SUITE}" \
    -o APT::FTPArchive::Release::Codename="${SUITE}" \
    -o APT::FTPArchive::Release::Components="${COMPONENT}" \
    -o APT::FTPArchive::Release::Architectures="${ARCH}" \
    release "dists/${SUITE}" > "dists/${SUITE}/Release"

  info "Signing Release (key: ${GPG_KEY_ID})"
  rm -f "dists/${SUITE}/Release.gpg" "dists/${SUITE}/InRelease"
  gpg --batch --yes --default-key "${GPG_KEY_ID}" -abs  -o "dists/${SUITE}/Release.gpg" "dists/${SUITE}/Release"
  gpg --batch --yes --default-key "${GPG_KEY_ID}" --clearsign -o "dists/${SUITE}/InRelease" "dists/${SUITE}/Release"

  info "Exporting public key (${KEYRING_ASC}, ${KEYRING_NAME}) + deb822 .sources"
  gpg --armor --export "${GPG_KEY_ID}" > "${KEYRING_ASC}"
  gpg --export "${GPG_KEY_ID}" > "${KEYRING_NAME}"

  # Modern deb822 client file with the (same-as-kernel) key INLINED.
  # Armored key is indented one space; blank lines become " .".
  {
    echo "Types: deb"
    echo "URIs: ${BASE_URI}"
    echo "Suites: ${SUITE}"
    echo "Components: ${COMPONENT}"
    echo "Architectures: ${ARCH}"
    echo "Signed-By:"
    gpg --armor --export "${GPG_KEY_ID}" | sed -e 's/^$/./' -e 's/^/ /'
  } > virtua.sources

  ok "Repository ready: ${REPO_DIR}"

  if [[ "${DEPLOY}" == "1" ]]; then
    [[ -d "${DEPLOY_DIR}" ]] || die "DEPLOY_DIR not found: ${DEPLOY_DIR} (set DEPLOY_DIR=…)"
    local SUDO=""
    [[ -w "${DEPLOY_DIR}" ]] || SUDO="sudo"
    info "Deploying to ${DEPLOY_DIR} (suite '${SUITE}' + public keyring; kernel suite untouched)"
    ${SUDO} mkdir -p "${DEPLOY_DIR}/dists/${SUITE}" "${DEPLOY_DIR}/${pooldir}"
    # Suite metadata: --delete is safe here (only this suite's own dir).
    ${SUDO} rsync -av --delete "dists/${SUITE}/" "${DEPLOY_DIR}/dists/${SUITE}/"
    # Pool: ADDITIVE (no --delete) so kernel/template debs are never removed.
    ${SUDO} rsync -av "${pooldir}/" "${DEPLOY_DIR}/${pooldir}/"
    # Shared public keyring used by both /VIRTUA and /KERNEL helper scripts.
    ${SUDO} rsync -av "${KEYRING_ASC}" "${KEYRING_NAME}" "${DEPLOY_DIR}/"
    # Client sources file.
    ${SUDO} rsync -av "virtua.sources" "${DEPLOY_DIR}/"
    ok "Deployed → live at ${BASE_URI}/dists/${SUITE}/InRelease"
    echo ""
    echo "── Verify ──────────────────────────────────────────────────"
    echo "  curl -fsI ${BASE_URI}/dists/${SUITE}/InRelease"
    echo "  curl -fsI ${BASE_URI}/dists/kernel/InRelease   # kernel still there"
    echo ""
    echo "── Client ──────────────────────────────────────────────────"
    echo "  sudo curl -fsSL ${BASE_URI}/virtua.sources -o /etc/apt/sources.list.d/virtua.sources"
    echo "  sudo apt update && sudo apt install auxinux-virtua"
    return 0
  fi

  echo ""
  echo "── Deploy ──────────────────────────────────────────────────"
  echo "  Re-run with --deploy to push straight into ${DEPLOY_DIR}"
  echo "  (override path with DEPLOY_DIR=…)"
  echo ""
  echo "── Manual upload (SAFE — never deletes your 'kernel' suite) ─"
  echo "  REMOTE=user@dep.auxinux.ca:/var/www/dep.auxinux.ca/VIRTUA"
  echo "  # the app's own suite dir may use --delete (only its own files):"
  echo "  rsync -av --delete '${REPO_DIR}/dists/${SUITE}/' \"\$REMOTE/dists/${SUITE}/\""
  echo "  # pool + keyring + sources are ADDITIVE (no --delete → kernel debs kept):"
  echo "  rsync -av '${REPO_DIR}/${pooldir}/'        \"\$REMOTE/${pooldir}/\""
  echo "  rsync -av '${REPO_DIR}/${KEYRING_ASC}' '${REPO_DIR}/${KEYRING_NAME}' '${REPO_DIR}/virtua.sources' \"\$REMOTE/\""
  echo ""
  echo "── Client setup (deb822, ONE file, same key as the kernel) ──"
  echo "  sudo curl -fsSL ${BASE_URI}/virtua.sources \\"
  echo "    -o /etc/apt/sources.list.d/virtua.sources"
  echo "  sudo apt update && sudo apt install auxinux-virtua"
  echo ""
  echo "  # One-line style (same key as kernel):"
  echo "  deb [signed-by=/usr/share/keyrings/${KEYRING_NAME}] ${BASE_URI} ${SUITE} ${COMPONENT}"
  echo ""
  echo "── Updates ─────────────────────────────────────────────────"
  echo "  sudo apt update && sudo apt upgrade   # new auxinux-virtua → install.sh -update"
}

# ── Parse flags (strip them from the extra-.deb list) ───────────────────────
_args=()
for a in "$@"; do
  case "$a" in
    --deploy) DEPLOY=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^#\{1,\} \{0,1\}//'; exit 0 ;;
    *) _args+=("$a") ;;
  esac
done
set -- ${_args[@]+"${_args[@]}"}

if command -v apt-ftparchive >/dev/null 2>&1 && command -v gpg >/dev/null 2>&1; then
  run_native "$@"
else
  command -v docker >/dev/null 2>&1 || die "Need apt-ftparchive+gpg (Debian) or Docker."
  [[ "${DEPLOY}" == "1" ]] && info "Note: --deploy is ignored in Docker mode (build on the repo server to deploy)."
  info "Running in Docker (apt-utils + gpg)…"
  docker run --rm \
    -e GPG_KEY_ID="${GPG_KEY_ID}" -e REPO_DIR=/work/repo/VIRTUA -e DEPLOY=0 \
    -e SUITE="${SUITE}" -e COMPONENT="${COMPONENT}" -e ARCH="${ARCH}" \
    -e BASE_URI="${BASE_URI}" -e ORIGIN="${ORIGIN}" -e LABEL="${LABEL}" \
    -e KEYRING_NAME="${KEYRING_NAME}" \
    -v "${SCRIPT_DIR}:/work" \
    -v "${GNUPGHOME:-$HOME/.gnupg}:/root/.gnupg" \
    debian:trixie-slim \
    bash -c "apt-get update -qq && apt-get install -y -qq apt-utils gnupg gzip >/dev/null 2>&1; cd /work && bash publish-repo.sh"
fi
