#!/usr/bin/env bash
#NAME=Installer les sources Debian 13 / VirtuaOS / AuxinuxOS AuxiNux
#DESC=Remplace proprement les sources Debian 13, VirtuaOS ou AuxinuxOS par le miroir AuxiNux /DEBIAN, après sauvegarde des sources existantes, puis lance apt update.
set -euo pipefail

MIRROR_URL="${MIRROR_URL:-https://dep.auxinux.ca/DEBIAN}"
SOURCE_FILE="/etc/apt/sources.list.d/auxinux-debian.sources"
BACKUP_ROOT="/etc/apt/auxinux-sources-backup-$(date +%Y%m%d-%H%M%S)"

info() { printf '[INFO] %s\n' "$*"; }
ok() { printf '[OK] %s\n' "$*"; }
warn() { printf '[WARN] %s\n' "$*" >&2; }
die() { printf '[ERR] %s\n' "$*" >&2; exit 1; }

is_supported_debian_base() {
  case "${ID:-}" in
    debian|virtuaos|auxinux|auxinuxos|auxinux-virtua|virtua) return 0 ;;
  esac
  case " ${ID_LIKE:-} " in
    *" debian "*) return 0 ;;
  esac
  case "${PRETTY_NAME:-} ${NAME:-}" in
    *VirtuaOS*|*AuxinuxOS*|*AuxiNuxOS*) return 0 ;;
  esac
  return 1
}

[[ "${EUID}" -eq 0 ]] || die "Lancez ce script en root: curl -fsSL https://dep.auxinux.ca/scripts/install-auxinux-sources-DEB.sh | sudo bash"

if [[ -r /etc/os-release ]]; then
  . /etc/os-release
else
  die "/etc/os-release introuvable."
fi

is_supported_debian_base || die "Ce script est réservé à Debian 13 / VirtuaOS / AuxinuxOS. OS détecté: ${PRETTY_NAME:-inconnu}."
if [[ "${VERSION_CODENAME:-}" != "trixie" && "${VERSION_ID:-}" != "13" ]]; then
  die "Ce script est réservé à Debian 13 / VirtuaOS / AuxinuxOS trixie. OS détecté: ${PRETTY_NAME:-inconnu}."
fi

if [[ ! -r /usr/share/keyrings/debian-archive-keyring.gpg ]]; then
  die "Keyring Debian manquant: /usr/share/keyrings/debian-archive-keyring.gpg"
fi

info "Sauvegarde des sources APT existantes vers ${BACKUP_ROOT}"
install -d -m 0755 "${BACKUP_ROOT}/sources.list.d"
[[ -f /etc/apt/sources.list ]] && cp -a /etc/apt/sources.list "${BACKUP_ROOT}/sources.list"
if [[ -d /etc/apt/sources.list.d ]]; then
  find /etc/apt/sources.list.d -maxdepth 1 -type f -exec cp -a {} "${BACKUP_ROOT}/sources.list.d/" \;
fi

disable_if_debian_source() {
  local file="$1"
  [[ -f "${file}" ]] || return 0
  [[ "${file}" == *.disabled ]] && return 0
  [[ "${file}" == "${SOURCE_FILE}" ]] && return 0

  if grep -Eqi 'debian\.org|debian-security|security\.debian\.org|ftp\.[a-z0-9.-]*debian' "${file}"; then
    info "Désactivation source Debian existante: ${file}"
    mv "${file}" "${file}.disabled"
  fi
}

disable_if_debian_source /etc/apt/sources.list
if [[ -d /etc/apt/sources.list.d ]]; then
  while IFS= read -r -d '' file; do
    disable_if_debian_source "${file}"
  done < <(find /etc/apt/sources.list.d -maxdepth 1 -type f \( -name '*.list' -o -name '*.sources' \) -print0)
fi

info "Écriture de ${SOURCE_FILE}"
cat > "${SOURCE_FILE}" <<EOF
Types: deb
URIs: ${MIRROR_URL}
Suites: trixie trixie-updates trixie-security
Components: main contrib non-free non-free-firmware
Architectures: amd64
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF

chmod 0644 "${SOURCE_FILE}"

info "Mise à jour de l'index APT"
apt-get update

ok "Sources Debian 13 / VirtuaOS / AuxinuxOS AuxiNux installées."
ok "Sauvegarde disponible: ${BACKUP_ROOT}"
