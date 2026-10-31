#!/usr/bin/env bash
# Turn the Tauri .deb into the package published on dep.auxinux.ca/VIRTUA.
#
# Tauri derives the Debian package name from productName ("auxi-nux-virtua-
# desktop-client", file name with spaces) and offers no setting for it. The
# apt repository publishes it as `auxinux-virtua-desktop`, next to the server
# package `auxinux-virtua`; nothing else in the package changes.
#
# Usage: scripts/package-apt.sh [tauri.deb] [output dir]   (after `tauri build --bundles deb`)
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${1:-$(ls -t "$ROOT_DIR"/src-tauri/target/release/bundle/deb/*.deb | head -1)}"
OUT_DIR="${2:-$ROOT_DIR/src-tauri/target/release/bundle/apt}"
VERSION="$(dpkg-deb -f "$SRC" Version)"
ARCH="$(dpkg-deb -f "$SRC" Architecture)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

dpkg-deb -R "$SRC" "$WORK/pkg"
sed -i \
  -e 's/^Package: .*/Package: auxinux-virtua-desktop/' \
  -e 's/^Maintainer: .*/Maintainer: AuxiNux <repo@auxinux.ca>/' \
  "$WORK/pkg/DEBIAN/control"
# Anyone who installed the Tauri-named .deb by hand gets it replaced cleanly.
cat >> "$WORK/pkg/DEBIAN/control" <<'CONTROL'
Replaces: auxi-nux-virtua-desktop-client
Conflicts: auxi-nux-virtua-desktop-client
CONTROL
mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/auxinux-virtua-desktop_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group -Zxz --build "$WORK/pkg" "$OUT" >/dev/null
echo "$OUT"
