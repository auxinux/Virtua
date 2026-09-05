#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-x86_64-unknown-linux-gnu}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SUDO=""
if [[ "${EUID:-$(id -u)}" -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

install_linux_prereqs() {
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update
    $SUDO apt-get install -y \
      build-essential curl file pkg-config libssl-dev \
      libdbus-1-dev libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev \
      libayatana-appindicator3-dev nodejs npm
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y \
      gcc gcc-c++ make curl file pkgconf-pkg-config openssl-devel \
      dbus-devel gtk3-devel webkit2gtk4.1-devel librsvg2-devel \
      libappindicator-gtk3-devel nodejs npm
    return
  fi

  if command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -Syu --needed --noconfirm \
      base-devel curl file pkgconf openssl gtk3 webkit2gtk-4.1 \
      librsvg libayatana-appindicator nodejs npm
    return
  fi

  echo "Gestionnaire de paquets non supporte. Installe Node.js, Rust, GTK3, WebKitGTK 4.1, OpenSSL et pkg-config." >&2
  exit 1
}

install_rust() {
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1090
  source "$HOME/.cargo/env"
}

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1 || ! command -v pkg-config >/dev/null 2>&1; then
  echo "Installation des prerequis Linux..."
  install_linux_prereqs
fi

if ! command -v rustup >/dev/null 2>&1 || ! command -v cargo >/dev/null 2>&1; then
  echo "Installation de Rust..."
  install_rust
fi

rustup target add "$TARGET"

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

npm run build
npm run tauri -- build --target "$TARGET"

echo
echo "Build Linux termine."
echo "Sorties possibles:"
echo "  src-tauri/target/$TARGET/release/"
echo "  src-tauri/target/$TARGET/release/bundle/"
