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

# macOS ties permissions such as "Local Network" to the app's code signature.
# An ad-hoc signed build is a new app for macOS every time: the switch in
# System Settings stays on for the previous build and the new one gets "No
# route to host" on 192.168.x.x. A self-signed identity created once on this
# Mac keeps the same signature from one build to the next.
# Override with VIRTUA_SIGNING_IDENTITY (e.g. a Developer ID) or skip with
# VIRTUA_SIGNING_IDENTITY=-.
LOCAL_IDENTITY="Virtua Desktop Local Signing"

ensure_signing_identity() {
  if [[ -n "${VIRTUA_SIGNING_IDENTITY:-}" ]]; then
    [[ "$VIRTUA_SIGNING_IDENTITY" != "-" ]] && export APPLE_SIGNING_IDENTITY="$VIRTUA_SIGNING_IDENTITY"
    return
  fi
  if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$LOCAL_IDENTITY\""; then
    export APPLE_SIGNING_IDENTITY="$LOCAL_IDENTITY"
    return
  fi
  echo "Creation d'un certificat de signature local (une seule fois) : \"$LOCAL_IDENTITY\"."
  echo "macOS va demander le mot de passe de la session pour lui faire confiance."
  local work
  work="$(mktemp -d)"
  # /usr/bin/openssl (LibreSSL) writes a PKCS#12 that `security` can import.
  /usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=$LOCAL_IDENTITY" \
    -addext "keyUsage=critical,digitalSignature" \
    -addext "extendedKeyUsage=critical,codeSigning" \
    -keyout "$work/key.pem" -out "$work/cert.pem" >/dev/null 2>&1
  /usr/bin/openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -name "$LOCAL_IDENTITY" -out "$work/identity.p12" -passout pass:virtua >/dev/null 2>&1
  local keychain="$HOME/Library/Keychains/login.keychain-db"
  security import "$work/identity.p12" -k "$keychain" -P virtua -T /usr/bin/codesign >/dev/null
  security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$work/cert.pem"
  rm -rf "$work"
  if security find-identity -v -p codesigning | grep -q "\"$LOCAL_IDENTITY\""; then
    export APPLE_SIGNING_IDENTITY="$LOCAL_IDENTITY"
  else
    echo "Certificat local non valide : build signe ad hoc (l'autorisation Reseau local sera a refaire apres chaque build)." >&2
  fi
}

ensure_xcode_tools
load_brew || true
ensure_signing_identity
ensure_node
ensure_rust

rustup target add "$TARGET"

if [[ -f package-lock.json ]]; then npm ci; else npm install; fi

npm run build
npm run tauri -- build --target "$TARGET" --bundles "$BUNDLES"

echo
echo "Build macOS termine ($TARGET)."
echo "Sorties: src-tauri/target/$TARGET/release/bundle/"
if [[ -n "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  echo "Signe avec : $APPLE_SIGNING_IDENTITY (meme signature d'un build a l'autre)."
  echo "Premier build signe : Reglages Systeme > Confidentialite et securite > Reseau local,"
  echo "decochez puis recochez AuxiNux Virtua Desktop Client, puis relancez l'app."
fi
echo "La distribution publique demande signature et notarisation Apple."
