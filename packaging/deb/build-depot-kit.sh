#!/usr/bin/env bash
# =============================================================================
#  Build a self-contained depot toolkit tarball for the repo server.
#
#  The resulting .tar.gz is meant to be extracted on the depot server under a
#  writable home directory such as /home/debian. It contains the publication and
#  kernel build scripts with the minimal supporting files they expect:
#    - packaging/deb/publish-repo.sh
#    - packaging/deb/build-deb.sh
#    - packaging/deb/build-virtuaos-deb.sh
#    - packaging/deb/README.md
#    - packaging/deb/debian/*
#    - packaging/deb/systemd/*
#    - packaging/deb/run-setup.sh
#    - INSTALL/release.sh
#    - package.json
#    - Kernel/VirtuaOS/build-depot-kernel.sh
#    - Kernel/VirtuaOS/build-virtua-kernel.sh
#    - Kernel/VirtuaOS/RELEASE-NOTES-7.0.11.md
#
#  Usage:
#    ./build-depot-kit.sh --build   # package from the current working tree
#
#  Output:
#    packaging/deb/out/virtua-depot-kit_<version>_all.tar.gz
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKSPACE_ROOT="$(cd "${PROJECT_ROOT}/.." && pwd)"
VIRTUAOS_ROOT="${VIRTUAOS_SOURCE_DIR:-${WORKSPACE_ROOT}/VirtuaOS}"
VIRTUA_KERNEL_ROOT="${VIRTUA_KERNEL_SOURCE_DIR:-${WORKSPACE_ROOT}/Kernel/VirtuaOS}"
OUT_DIR="${SCRIPT_DIR}/out"

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
info(){ echo -e "${C}[INFO]${N} $*"; }
ok(){ echo -e "${G}[OK]${N} $*"; }
warn(){ echo -e "${Y}[WARN]${N} $*"; }
die(){ echo -e "${R}[ERR]${N} $*"; exit 1; }

BUILD=0
for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    -h|--help)
      cat <<'EOF'
Usage:
  ./build-depot-kit.sh --build

Builds a depot toolkit tarball that can be extracted on the repository server.
EOF
      exit 0
      ;;
    *) die "Unknown argument: ${arg}" ;;
  esac
done

VERSION="$(sed -n 's/^[[:space:]]*node_ver="\([^"]*\)".*/\1/p' "${PROJECT_ROOT}/INSTALL/release.sh" | head -1)"
if [[ -z "${VERSION}" ]]; then
  VERSION="$(node -e "console.log(require('${PROJECT_ROOT}/package.json').version)" 2>/dev/null \
    || sed -n 's/.*\"version\": *\"\([^\"]*\)\".*/\1/p' "${PROJECT_ROOT}/package.json" | head -1)"
fi
[[ -n "${VERSION}" ]] || die "Cannot determine Virtua version"

stage="$(mktemp -d)"
bundle_name="virtua-depot-kit_${VERSION}_all"
bundle_dir="${stage}/${bundle_name}"

install -d \
  "${bundle_dir}/packaging/deb/debian" \
  "${bundle_dir}/packaging/deb/systemd" \
  "${bundle_dir}/Kernel/VirtuaOS" \
  "${bundle_dir}/VirtuaOS/releases" \
  "${bundle_dir}/VirtuaOS/virtuaos-cli/src"

cp "${PROJECT_ROOT}/package.json" "${bundle_dir}/package.json"
install -d "${bundle_dir}/INSTALL"
cp "${PROJECT_ROOT}/INSTALL/release.sh" "${bundle_dir}/INSTALL/release.sh"

for f in README.md run-setup.sh publish-repo.sh build-deb.sh build-virtuaos-deb.sh; do
  cp "${PROJECT_ROOT}/packaging/deb/${f}" "${bundle_dir}/packaging/deb/${f}"
done
cp -a "${PROJECT_ROOT}/packaging/deb/debian/." "${bundle_dir}/packaging/deb/debian/"
cp -a "${PROJECT_ROOT}/packaging/deb/systemd/." "${bundle_dir}/packaging/deb/systemd/"

for f in build-depot-kernel.sh build-virtua-kernel.sh RELEASE-NOTES-7.0.11.md; do
  cp "${VIRTUA_KERNEL_ROOT}/${f}" "${bundle_dir}/Kernel/VirtuaOS/${f}"
done

cp "${VIRTUAOS_ROOT}/virtuaos-cli/Cargo.toml" "${bundle_dir}/VirtuaOS/virtuaos-cli/Cargo.toml"
cp "${VIRTUAOS_ROOT}/virtuaos-cli/Cargo.lock" "${bundle_dir}/VirtuaOS/virtuaos-cli/Cargo.lock"
cp "${VIRTUAOS_ROOT}/virtuaos-cli/README.md" "${bundle_dir}/VirtuaOS/virtuaos-cli/README.md"
cp "${VIRTUAOS_ROOT}/virtuaos-cli/.gitignore" "${bundle_dir}/VirtuaOS/virtuaos-cli/.gitignore"
cp -a "${VIRTUAOS_ROOT}/virtuaos-cli/src/." "${bundle_dir}/VirtuaOS/virtuaos-cli/src/"
cp "${VIRTUAOS_ROOT}/README-OSUPGRADE.md" "${bundle_dir}/VirtuaOS/README-OSUPGRADE.md"
if [[ -d "${VIRTUAOS_ROOT}/releases" ]]; then
  cp -a "${VIRTUAOS_ROOT}/releases/." "${bundle_dir}/VirtuaOS/releases/"
fi

cat > "${bundle_dir}/publish-virtua.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}/packaging/deb"

MODE="publish"
for arg in "$@"; do
  case "$arg" in
    --build) MODE="build-and-publish" ;;
    -h|--help)
      cat <<'HELP'
Usage:
  ./publish-virtua.sh [--build]

Publishes the application side of /VIRTUA.

Where to put files:
  - built .deb packages live in packaging/deb/out/
  - auxinux-virtua_<version>_amd64.deb
  - virtuaos-cli_<version>_amd64.deb

What it does:
  - optionally builds the two .deb files first
  - runs packaging/deb/publish-repo.sh --deploy
  - syncs VirtuaOS/releases into /var/www/dep.auxinux.ca/VIRTUAOS
HELP
      exit 0
      ;;
    *) ;;
  esac
done

if [[ "${MODE}" == "build-and-publish" ]]; then
  ./build-virtuaos-deb.sh
  ./build-deb.sh
fi

GPG_KEY_ID="${GPG_KEY_ID:-repo@auxinux.ca}" ./publish-repo.sh --deploy

RELEASE_SRC="${ROOT}/VirtuaOS/releases"
RELEASE_DEPLOY_DIR="${RELEASE_DEPLOY_DIR:-/var/www/dep.auxinux.ca/VIRTUAOS}"
if [[ -d "${RELEASE_SRC}" ]]; then
  echo "[INFO] Syncing VirtuaOS release assets → ${RELEASE_DEPLOY_DIR}"
  sudo mkdir -p "${RELEASE_DEPLOY_DIR}"
  sudo rsync -av --delete "${RELEASE_SRC}/" "${RELEASE_DEPLOY_DIR}/"
fi
EOF

cat > "${bundle_dir}/publish-kernel.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMPORT_DIR="${1:-/tmp/virtua-kernel}"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      cat <<'HELP'
Usage:
  ./publish-kernel.sh [IMPORT_DIR]

Publishes the kernel side of /VIRTUA.

Where to put files:
  - copy the kernel .deb files to IMPORT_DIR first
  - default IMPORT_DIR is /tmp/virtua-kernel
  - the repository root stays at /var/www/dep.auxinux.ca/VIRTUA

What it does:
  - runs Kernel/VirtuaOS/build-depot-kernel.sh with the import directory
  - creates missing repo/import directories automatically
HELP
      exit 0
      ;;
  esac
done

cd "${ROOT}/Kernel/VirtuaOS"
if [[ "${EUID}" -eq 0 ]]; then
  exec GPG_KEY="${GPG_KEY:-repo@auxinux.ca}" ./build-depot-kernel.sh "${IMPORT_DIR}"
else
  exec sudo GPG_KEY="${GPG_KEY:-repo@auxinux.ca}" ./build-depot-kernel.sh "${IMPORT_DIR}"
fi
EOF

chmod 0755 "${bundle_dir}/publish-virtua.sh" "${bundle_dir}/publish-kernel.sh"

cat > "${bundle_dir}/README.md" <<'EOF'
# Virtua Depot Toolkit __VERSION__

Archive prepared for the repository server.

Extract it on the target machine, for example under /home/debian:

```bash
tar -xzf virtua-depot-kit___VERSION___all.tar.gz -C /home/debian
cd /home/debian/virtua-depot-kit___VERSION___all
```

Then use the top-level wrappers:

- `./publish-virtua.sh` to publish the application packages
- `./publish-kernel.sh /tmp/virtua-kernel` to publish the kernel side
- `./publish-virtua.sh` also syncs `VirtuaOS/releases/` into `/VIRTUAOS/`

Where to put files:

- application `.deb` files go in `packaging/deb/out/`
- kernel `.deb` files go in `/tmp/virtua-kernel/` before `publish-kernel.sh`
- Rust crate for `virtuaos-cli` lives in `VirtuaOS/virtuaos-cli/`
- VirtuaOS release metadata lives in `VirtuaOS/releases/` and should be
  copied to `/var/www/dep.auxinux.ca/VIRTUAOS/`

Package names expected in `packaging/deb/out/`:

- `auxinux-virtua_<version>_amd64.deb`
- `virtuaos-cli_<version>_amd64.deb`

Shared signing key:
- /VIRTUA/virtua-archive-keyring.asc
- /VIRTUA/virtua-archive-keyring.gpg

Typical publication flow:

```bash
cd /home/debian/virtua-depot-kit___VERSION___all
./publish-virtua.sh
./publish-kernel.sh /tmp/virtua-kernel
```

If you want to build the app packages on the repository server too, run:

```bash
cd /home/debian/virtua-depot-kit___VERSION___all/packaging/deb
./build-virtuaos-deb.sh
./build-deb.sh
```

The scripts expect to run from inside this extracted tree so their relative
paths remain valid. `./publish-virtua.sh --build` now works because the crate is
included in the kit.
EOF
perl -0pe "s/__VERSION__/${VERSION}/g" "${bundle_dir}/README.md" > "${bundle_dir}/README.md.tmp"
mv -f "${bundle_dir}/README.md.tmp" "${bundle_dir}/README.md"

if command -v sha256sum >/dev/null 2>&1; then
  ( cd "${bundle_dir}" && \
    release_files=( $(find VirtuaOS/releases -type f | sort) ) && \
    sha256sum \
      package.json \
      INSTALL/release.sh \
      packaging/deb/README.md \
      packaging/deb/run-setup.sh \
      packaging/deb/publish-repo.sh \
      packaging/deb/build-deb.sh \
      packaging/deb/build-virtuaos-deb.sh \
      packaging/deb/debian/* \
      packaging/deb/systemd/* \
      Kernel/VirtuaOS/build-depot-kernel.sh \
      Kernel/VirtuaOS/build-virtua-kernel.sh \
      Kernel/VirtuaOS/RELEASE-NOTES-7.0.11.md \
      VirtuaOS/README-OSUPGRADE.md \
      "${release_files[@]}" \
      publish-virtua.sh \
      publish-kernel.sh \
      README.md > SHA256SUMS )
else
  warn "sha256sum not found; SHA256SUMS will not be created."
fi

mkdir -p "${OUT_DIR}"
tarball="${OUT_DIR}/${bundle_name}.tar.gz"
rm -f "${tarball}"
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "${stage}" 2>/dev/null || true
fi
tar_args=(-C "${stage}" -czf "${tarball}" "${bundle_name}")
if tar --help 2>/dev/null | grep -q -- '--no-xattrs'; then
  tar_args=(--no-xattrs "${tar_args[@]}")
fi
COPYFILE_DISABLE=1 tar "${tar_args[@]}"
rm -rf "${stage}"

ok "Depot toolkit built: ${tarball}"
ok "Size: $(du -sh "${tarball}" | cut -f1)"
echo ""
echo "Copy to the depot server, extract under /home/debian, then use:"
echo "  cd /home/debian/${bundle_name}"
echo "  cd packaging/deb && GPG_KEY_ID=repo@auxinux.ca ./publish-repo.sh --deploy"
echo "  cd Kernel/VirtuaOS && sudo GPG_KEY=repo@auxinux.ca ./build-depot-kernel.sh /tmp/virtua-kernel"
