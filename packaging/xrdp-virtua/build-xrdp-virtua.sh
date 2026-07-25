#!/usr/bin/env bash
# Build the VirtuaOS-patched xrdp package (skip login window when autorun is set).
#
# Run on debiandev (Debian 13 build host):
#   sudo apt-get build-dep -y xrdp && sudo apt-get install -y devscripts quilt
#   bash build-xrdp-virtua.sh
#
# Output: ../xrdp_<version>+virtua1_amd64.deb (plus xorgxrdp untouched deps),
# to publish on dep.auxinux.ca so apt prefers it over the Debian package.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="${SCRIPT_DIR}/skip-login-with-autorun.patch"
WORK="${1:-"${HOME}/xrdp-virtua-build"}"

[ -f "${PATCH}" ] || { echo "patch not found: ${PATCH}" >&2; exit 1; }

mkdir -p "${WORK}"
cd "${WORK}"

# Fetch the Debian source package (requires deb-src entries in sources.list).
apt-get source xrdp
SRC_DIR="$(find . -maxdepth 1 -type d -name 'xrdp-*' | sort | head -1)"
[ -n "${SRC_DIR}" ] || { echo "xrdp source dir not found (deb-src enabled?)" >&2; exit 1; }
cd "${SRC_DIR}"

# Register the patch with quilt (Debian 3.0 format applies debian/patches).
mkdir -p debian/patches
cp "${PATCH}" debian/patches/virtua-skip-login-with-autorun.patch
grep -qxF "virtua-skip-login-with-autorun.patch" debian/patches/series 2>/dev/null \
  || echo "virtua-skip-login-with-autorun.patch" >> debian/patches/series

# Verify the patch applies (line offsets may drift between xrdp releases —
# if this fails, refresh the hunk against xrdp/xrdp_wm.c: the target is the
# `if (self->session->client_info->rdp_autologin)` test in xrdp_wm_init()).
QUILT_PATCHES=debian/patches quilt push -a
QUILT_PATCHES=debian/patches quilt pop -a

# Version bump so apt prefers this build over Debian's.
DEBEMAIL="repo@auxinux.ca" DEBFULLNAME="AuxiNux Virtua" \
  dch --local "+virtua" "Skip xrdp login window when [Globals] autorun is set (Virtua per-VM RDP console gateways)."

dpkg-buildpackage -us -uc -b

echo
echo "Built packages:"
ls -1 ../*.deb
echo
echo "Publish xrdp_*+virtua*.deb to dep.auxinux.ca/VIRTUA (publish-repo.sh),"
echo "then on Virtua hosts: apt update && apt upgrade (or apt install xrdp)."
