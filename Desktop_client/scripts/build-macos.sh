#!/usr/bin/env bash
# Build the Virtua Desktop client on macOS (Apple Silicon or Intel), installing
# whatever the machine is missing first.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

case "$(uname -m)" in
  arm64) DEFAULT_TARGET="aarch64-apple-darwin" ;;
  *) DEFAULT_TARGET="x86_64-apple-darwin" ;;
esac
TARGET="${1:-$DEFAULT_TARGET}"
BUNDLES="${2:-app,dmg}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Ce script s'execute sur macOS. Utilise scripts/build-linux.sh ou scripts/build-windows.ps1." >&2
  exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }

# Homebrew installs into a different prefix on Apple Silicon; load whichever exists.
load_brew() {
  for prefix in /opt/homebrew /usr/local; do
    if [[ -x "$prefix/bin/brew" ]]; then
      eval "$("$prefix/bin/brew" shellenv)"
      return 0
    fi
  done
  return 1
}

ensure_xcode_tools() {
  if xcode-select -p >/dev/null 2>&1; then return; fi
  echo "Installation des outils de ligne de commande Xcode (fenetre systeme)..."
  xcode-select --install || true
  echo "Termine l'assistant Xcode, puis relance ce script." >&2
  exit 1
}

ensure_brew() {
  if load_brew; then return; fi
  echo "Installation de Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_brew || { echo "Homebrew reste introuvable." >&2; exit 1; }
}

ensure_node() {
  if have node && have npm; then return; fi
  ensure_brew
  brew install node
}

ensure_rust() {
  # shellcheck disable=SC1091
  [[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
  if have cargo && have rustup; then return; fi
  echo "Installation de Rust..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
}

ensure_xcode_tools
load_brew || true
ensure_node
ensure_rust

rustup target add "$TARGET"

if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

npm run build
npm run tauri -- build --target "$TARGET" --bundles "$BUNDLES"

echo
echo "Build macOS termine ($TARGET)."
echo "Sorties: src-tauri/target/$TARGET/release/bundle/"
echo "La distribution publique demande signature et notarisation Apple."
