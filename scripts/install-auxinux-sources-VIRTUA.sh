#!/usr/bin/env bash
#NAME=Installer les sources VIRTUA AuxiNux
#DESC=Ajoute le dépôt APT VIRTUA (/VIRTUA) avec la clé publique partagée, puis lance apt update.
set -euo pipefail

MIRROR_URL="${MIRROR_URL:-https://dep.auxinux.ca/VIRTUA}"
SOURCE_FILE="/etc/apt/sources.list.d/auxinux-virtua.sources"
KEYRING_URL="${KEYRING_URL:-https://dep.auxinux.ca/VIRTUA/virtua-archive-keyring.gpg}"
KEYRING_FILE="${KEYRING_FILE:-/usr/share/keyrings/virtua-archive-keyring.gpg}"
EXPECTED_FINGERPRINT="${EXPECTED_FINGERPRINT:-0E277CCF3E14E49634993BC9A0424AF537AB9980}"

info() { printf '[INFO] %s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
die() { printf '[ERR] %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "Lancez ce script en root: curl -fsSL https://dep.auxinux.ca/scripts/install-auxinux-sources-VIRTUA.sh | sudo bash"

install -d -m 0755 /usr/share/keyrings
if [[ ! -s "${KEYRING_FILE}" ]] || { command -v gpg >/dev/null 2>&1 && ! gpg --show-keys --with-colons "${KEYRING_FILE}" 2>/dev/null | grep -q "fpr:::::::::${EXPECTED_FINGERPRINT}:"; }; then
  command -v curl >/dev/null 2>&1 || die "curl est requis pour récupérer la clé publique"
  info "Téléchargement de la clé publique partagée vers ${KEYRING_FILE}"
  curl -fsSL "${KEYRING_URL}" -o "${KEYRING_FILE}.tmp"
  install -m 0644 "${KEYRING_FILE}.tmp" "${KEYRING_FILE}"
  rm -f "${KEYRING_FILE}.tmp"
fi

info "Écriture de ${SOURCE_FILE}"
cat > "${SOURCE_FILE}" <<EOF
Types: deb
URIs: ${MIRROR_URL}
Suites: virtua
Components: main
Architectures: amd64
Signed-By: ${KEYRING_FILE}
EOF
chmod 0644 "${SOURCE_FILE}"

info "Mise à jour de l'index APT"
apt-get update

ok "Sources VIRTUA installées."
