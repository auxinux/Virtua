#!/usr/bin/env bash
#NAME=Installer les sources Ubuntu 26.04 AuxiNux
#DESC=Remplace proprement les sources Ubuntu 26.04 par le miroir AuxiNux /UBUNTU, après sauvegarde des sources existantes, puis lance apt update.
set -euo pipefail

MIRROR_URL="${MIRROR_URL:-https://dep.auxinux.ca/UBUNTU}"
SOURCE_FILE="/etc/apt/sources.list.d/auxinux-ubuntu.sources"
BACKUP_ROOT="/etc/apt/auxinux-sources-backup-$(date +%Y%m%d-%H%M%S)"

info() { printf '[INFO] %s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
die() { printf '[ERR] %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "Lancez ce script en root: curl -fsSL https://dep.auxinux.ca/scripts/install-auxinux-sources-UB.sh | sudo bash"

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
else
  die "/etc/os-release introuvable."
fi

[[ "${ID:-}" == "ubuntu" ]] || die "Ce script est réservé à Ubuntu 26.04. OS détecté: ${PRETTY_NAME:-inconnu}."
if [[ "${VERSION_CODENAME:-}" != "resolute" && "${VERSION_ID:-}" != "26.04" ]]; then
  die "Ce script est réservé à Ubuntu 26.04 resolute. OS détecté: ${PRETTY_NAME:-inconnu}."
fi

if [[ ! -r /usr/share/keyrings/ubuntu-archive-keyring.gpg ]]; then
  die "Keyring Ubuntu manquant: /usr/share/keyrings/ubuntu-archive-keyring.gpg"
fi

info "Sauvegarde des sources APT existantes vers ${BACKUP_ROOT}"
install -d -m 0755 "${BACKUP_ROOT}/sources.list.d"
[[ -f /etc/apt/sources.list ]] && cp -a /etc/apt/sources.list "${BACKUP_ROOT}/sources.list"
if [[ -d /etc/apt/sources.list.d ]]; then
  find /etc/apt/sources.list.d -maxdepth 1 -type f -exec cp -a {} "${BACKUP_ROOT}/sources.list.d/" \;
fi

disable_if_ubuntu_source() {
  local file="$1"
  [[ -f "${file}" ]] || return 0
  [[ "${file}" == *.disabled ]] && return 0
  [[ "${file}" == "${SOURCE_FILE}" ]] && return 0

  if grep -Eqi 'ubuntu\.com|archive\.canonical\.com|ports\.ubuntu\.com|security\.ubuntu\.com' "${file}"; then
    info "Désactivation source Ubuntu existante: ${file}"
    mv "${file}" "${file}.disabled"
  fi
}

disable_if_ubuntu_source /etc/apt/sources.list
if [[ -d /etc/apt/sources.list.d ]]; then
  while IFS= read -r -d '' file; do
    disable_if_ubuntu_source "${file}"
  done < <(find /etc/apt/sources.list.d -maxdepth 1 -type f \( -name '*.list' -o -name '*.sources' \) -print0)
fi

info "Écriture de ${SOURCE_FILE}"
cat > "${SOURCE_FILE}" <<EOF
Types: deb
URIs: ${MIRROR_URL}
Suites: resolute resolute-updates resolute-security
Components: main restricted universe multiverse
Architectures: amd64
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF

chmod 0644 "${SOURCE_FILE}"

info "Mise à jour de l'index APT"
apt-get update

ok "Sources Ubuntu 26.04 AuxiNux installées."
ok "Sauvegarde disponible: ${BACKUP_ROOT}"
