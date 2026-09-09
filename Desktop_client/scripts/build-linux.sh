#!/usr/bin/env bash
# Build the Virtua Desktop client on Linux, installing the toolchain and the
# GTK/WebKit development libraries the machine is missing first.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "$(uname -m)" in
  aarch64|arm64) DEFAULT_TARGET="aarch64-unknown-linux-gnu" ;;
  *) DEFAULT_TARGET="x86_64-unknown-linux-gnu" ;;
esac
TARGET="${1:-$DEFAULT_TARGET}"
BUNDLES="${2:-deb,appimage}"

have() { command -v "$1" >/dev/null 2>&1; }

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  if have sudo; then
    SUDO="sudo"
  else
    echo "Ni root ni sudo: installe les prerequis manuellement, puis relance." >&2
  fi
fi

install_linux_prereqs() {
  if have apt-get; then
    $SUDO apt-get update
    # WebKitGTK is 4.1 on current releases and 4.0 on older ones; ask for both
    # and let apt pick what exists instead of failing the whole install.
    $SUDO apt-get install -y \
      build-essential curl wget file pkg-config libssl-dev \
      libdbus-1-dev libgtk-3-dev librsvg2-dev libsoup-3.0-dev \
      libayatana-appindicator3-dev nodejs npm \
      || true
    $SUDO apt-get install -y libwebkit2gtk-4.1-dev \
      || $SUDO apt-get install -y libwebkit2gtk-4.0-dev
    return
  fi

  if have dnf; then
    $SUDO dnf install -y \
      gcc gcc-c++ make curl wget file pkgconf-pkg-config openssl-devel \
      dbus-devel gtk3-devel librsvg2-devel libsoup3-devel \
      libappindicator-gtk3-devel nodejs npm
    $SUDO dnf install -y webkit2gtk4.1-devel || $SUDO dnf install -y webkit2gtk3-devel
    return
  fi

  if have zypper; then
    $SUDO zypper --non-interactive install -t pattern devel_basis || true
    $SUDO zypper --non-interactive install \
      curl wget file pkg-config libopenssl-devel dbus-1-devel gtk3-devel \
      librsvg-devel libsoup-devel webkit2gtk3-soup2-devel nodejs npm
    return
  fi

  if have pacman; then
    $SUDO pacman -Syu --needed --noconfirm \
      base-devel curl wget file pkgconf openssl gtk3 webkit2gtk-4.1 \
      libsoup3 librsvg libayatana-appindicator nodejs npm
    return
  fi

  echo "Gestionnaire de paquets non supporte. Installe Node.js, Rust, GTK3, WebKitGTK 4.1, libsoup3, OpenSSL et pkg-config." >&2
  exit 1
}

install_rust() {
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
}

if ! have node || ! have npm || ! have pkg-config \
  || ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  echo "Installation des prerequis Linux..."
  install_linux_prereqs
fi

# shellcheck disable=SC1091
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
if ! have rustup || ! have cargo; then
  echo "Installation de Rust..."
  install_rust
fi

rustup target add "$TARGET"

if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

npm run build
npm run tauri -- build --target "$TARGET" --bundles "$BUNDLES"

echo
echo "Build Linux termine ($TARGET)."
echo "Sorties: src-tauri/target/$TARGET/release/bundle/"
