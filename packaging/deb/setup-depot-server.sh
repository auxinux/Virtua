#!/usr/bin/env bash
# =============================================================================
#  Prepare a fresh Debian 13 container as dep.auxinux.ca repository server.
#
#  Canonical web root:
#    /var/www/dep.auxinux.ca/
#
#  Layout:
#    /var/www/dep.auxinux.ca/VIRTUA/    APT repo for Virtua + kernel suites
#    /var/www/dep.auxinux.ca/VIRTUAOS/  ISO/images/release artifacts
#    /var/www/dep.auxinux.ca/KERNEL/    human-friendly kernel artifact area
#    /var/www/dep.auxinux.ca/DEBIAN/    Debian repo/mirror area
#    /var/www/dep.auxinux.ca/UBUNTU/    Ubuntu repo/mirror area
#    /var/www/dep.auxinux.ca/TEMPLATES/ VM/ISO template depot area:
#                                          ISO/{AMD64,ARM}, VM/{AMD64,ARM}
#    /var/www/dep.auxinux.ca/DOWNLOAD/  public downloads: ISOs, tools, files
#    /var/www/dep.auxinux.ca/scripts/   public helper scripts with index.php
#
#  Usage on the repo server:
#    sudo bash setup-depot-server.sh
#
#  Optional:
#    DEPOT_DOMAIN=dep.auxinux.ca
#    DEPOT_ROOT=/var/www/dep.auxinux.ca
#    LETSENCRYPT_EMAIL=repo@auxinux.ca
#    ENABLE_LETSENCRYPT=1
# =============================================================================
set -euo pipefail

DEPOT_DOMAIN="${DEPOT_DOMAIN:-dep.auxinux.ca}"
DEPOT_ROOT="${DEPOT_ROOT:-/var/www/dep.auxinux.ca}"
LETSENCRYPT_EMAIL="${LETSENCRYPT_EMAIL:-repo@auxinux.ca}"
ENABLE_LETSENCRYPT="${ENABLE_LETSENCRYPT:-0}"

C='\033[0;36m'; G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
info(){ echo -e "${C}[INFO]${N} $*"; }
ok(){ echo -e "${G}[OK]${N} $*"; }
warn(){ echo -e "${Y}[WARN]${N} $*"; }
die(){ echo -e "${R}[ERR]${N} $*"; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "Run as root: sudo bash setup-depot-server.sh"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

info "Installing repository server packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y nginx certbot python3-certbot-nginx php-fpm apt-utils gnupg rsync gzip curl ca-certificates dpkg-dev debmirror debian-archive-keyring ubuntu-keyring

PHP_FPM_SOCK="$(find /run/php -maxdepth 1 -type s -name 'php*-fpm.sock' 2>/dev/null | sort -V | tail -n 1 || true)"
if [[ -z "${PHP_FPM_SOCK}" ]]; then
  while read -r unit _; do
    [[ -n "${unit}" ]] || continue
    systemctl enable --now "${unit}" >/dev/null 2>&1 || true
  done < <(systemctl list-unit-files 'php*-fpm.service' --no-legend 2>/dev/null || true)
  PHP_FPM_SOCK="$(find /run/php -maxdepth 1 -type s -name 'php*-fpm.sock' 2>/dev/null | sort -V | tail -n 1 || true)"
fi
[[ -n "${PHP_FPM_SOCK}" ]] || die "PHP-FPM socket not found under /run/php"

info "Creating repository layout under ${DEPOT_ROOT}"
install -d -m 0755 \
  "${DEPOT_ROOT}/VIRTUA/dists" \
  "${DEPOT_ROOT}/VIRTUA/pool/main" \
  "${DEPOT_ROOT}/VIRTUA/KERNEL" \
  "${DEPOT_ROOT}/VIRTUAOS" \
  "${DEPOT_ROOT}/KERNEL" \
  "${DEPOT_ROOT}/DEBIAN" \
  "${DEPOT_ROOT}/UBUNTU" \
  "${DEPOT_ROOT}/TEMPLATES" \
  "${DEPOT_ROOT}/TEMPLATES/ISO/AMD64" \
  "${DEPOT_ROOT}/TEMPLATES/ISO/ARM" \
  "${DEPOT_ROOT}/TEMPLATES/VM/AMD64" \
  "${DEPOT_ROOT}/TEMPLATES/VM/ARM" \
  "${DEPOT_ROOT}/DOWNLOAD" \
  "${DEPOT_ROOT}/scripts"

write_readme() {
  local path="$1"
  local text="$2"
  [[ -f "${path}" ]] || printf '%s\n' "${text}" > "${path}"
}

write_readme "${DEPOT_ROOT}/README.txt" "AuxiNux public repository root."
write_readme "${DEPOT_ROOT}/VIRTUAOS/README.txt" "VirtuaOS images and release artifacts."
write_readme "${DEPOT_ROOT}/KERNEL/README.txt" "Kernel packages. Canonical APT suite currently lives under /VIRTUA/dists/kernel."
write_readme "${DEPOT_ROOT}/DEBIAN/README.txt" "Debian repository/mirror area."
write_readme "${DEPOT_ROOT}/UBUNTU/README.txt" "Ubuntu repository/mirror area."
write_readme "${DEPOT_ROOT}/TEMPLATES/README.txt" "Virtua VM/ISO template depot area."
write_readme "${DEPOT_ROOT}/TEMPLATES/ISO/README.txt" "ISO templates by architecture."
write_readme "${DEPOT_ROOT}/TEMPLATES/ISO/AMD64/README.txt" "AMD64 ISO files."
write_readme "${DEPOT_ROOT}/TEMPLATES/ISO/ARM/README.txt" "ARM ISO files."
write_readme "${DEPOT_ROOT}/TEMPLATES/VM/README.txt" "VM templates by architecture."
write_readme "${DEPOT_ROOT}/TEMPLATES/VM/AMD64/README.txt" "AMD64 VM templates: Nom.tar.gz plus Nom.json sidecar."
write_readme "${DEPOT_ROOT}/TEMPLATES/VM/ARM/README.txt" "ARM VM templates: Nom.tar.gz plus Nom.json sidecar."
write_readme "${DEPOT_ROOT}/DOWNLOAD/README.txt" "Public downloads: ISOs, tools and other files."

if [[ -d "${PROJECT_ROOT}/scripts" ]]; then
  info "Publishing helper scripts to ${DEPOT_ROOT}/scripts"
  rsync -a --delete --exclude '.DS_Store' "${PROJECT_ROOT}/scripts/" "${DEPOT_ROOT}/scripts/"
else
  warn "Project scripts/ directory not found; ${DEPOT_ROOT}/scripts will be empty"
fi

info "Configuring nginx virtual host ${DEPOT_DOMAIN}"
cat > "/etc/nginx/sites-available/${DEPOT_DOMAIN}" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DEPOT_DOMAIN};

    root ${DEPOT_ROOT};
    # Do not include README.txt here: repository directories should behave like
    # normal mirrors and show autoindex listings when no real index.html exists.
    index index.html index.htm;

    autoindex on;
    autoindex_exact_size off;
    autoindex_localtime on;

    location /scripts/ {
        index index.php;
        try_files \$uri \$uri/ /scripts/index.php?\$query_string;
    }

    location = /scripts/index.php {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${PHP_FPM_SOCK};
    }

    location ~ \.php$ {
        return 404;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }
}
EOF

ln -sf "/etc/nginx/sites-available/${DEPOT_DOMAIN}" "/etc/nginx/sites-enabled/${DEPOT_DOMAIN}"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl reload nginx

if ! gpg --list-secret-keys repo@auxinux.ca >/dev/null 2>&1; then
  warn "No repo@auxinux.ca secret key in root GNUPGHOME. Create/import one before signing as root, or run publish scripts with GNUPGHOME set."
fi

if [[ "${ENABLE_LETSENCRYPT}" == "1" ]]; then
  info "Requesting Let's Encrypt certificate for ${DEPOT_DOMAIN}"
  certbot --nginx -d "${DEPOT_DOMAIN}" \
    --non-interactive --agree-tos -m "${LETSENCRYPT_EMAIL}" --redirect
fi

if [[ -f "${SCRIPT_DIR}/sync-os-mirrors.sh" ]]; then
  info "Installing Debian/Ubuntu mirror sync service"
  install -m 0755 "${SCRIPT_DIR}/sync-os-mirrors.sh" /usr/local/sbin/auxinux-sync-os-mirrors
  if [[ -f "${SCRIPT_DIR}/systemd/auxinux-depot-sync.service" && -f "${SCRIPT_DIR}/systemd/auxinux-depot-sync.timer" ]]; then
    install -m 0644 "${SCRIPT_DIR}/systemd/auxinux-depot-sync.service" /etc/systemd/system/auxinux-depot-sync.service
    install -m 0644 "${SCRIPT_DIR}/systemd/auxinux-depot-sync.timer" /etc/systemd/system/auxinux-depot-sync.timer
    systemctl daemon-reload
    systemctl enable --now auxinux-depot-sync.timer
  else
    warn "Systemd units for mirror sync were not found next to setup-depot-server.sh"
  fi
else
  warn "sync-os-mirrors.sh was not found next to setup-depot-server.sh; mirror sync service not installed"
fi

chmod -R a+rX "${DEPOT_ROOT}"
ok "Depot server ready at ${DEPOT_ROOT}"
