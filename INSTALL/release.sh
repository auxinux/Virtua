#!/usr/bin/env bash
# =============================================================================
# AuxiNux Release Script - Node & VDM Packaging
# Creates deployable .tar.gz archives for Debian 13 servers.
#
# Usage:
#   bash INSTALL/release.sh        # Build Node archive
#   bash INSTALL/release.sh -vdm   # Build VDM archive
#   bash INSTALL/release.sh -all   # Build Node + VDM archives
# =============================================================================
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
step()    { echo -e "\n${BOLD}${BLUE}== $* ${NC}"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PARENT_DIR="$(dirname "$PROJECT_DIR")"

cd "$PROJECT_DIR"

MODE="node"
VERSION=""
BUILD_DONE=0

node_ver="0.7.46"
vdm_ver="0.7.46"

show_help() {
    cat <<'EOF'
AuxiNux Release Script - Node & VDM Packaging

Usage:
  bash INSTALL/release.sh          Build AuxiNux Node release archive
  bash INSTALL/release.sh -vdm     Build VDM release archive
  bash INSTALL/release.sh -all     Build Node + VDM release archives
  bash INSTALL/release.sh -h       Show this help

Output archives:
    ../auxinuxvirtual-v<NODE_VERSION>.tar.gz  - AuxiNux Node
    ../auxinux-vdm-v<VDM_VERSION>.tar.gz      - VDM service
EOF
}

parse_args() {
    local arg
    for arg in "$@"; do
        case "$arg" in
            -vdm|--vdm)
                MODE="vdm"
                ;;
            -all|--all)
                MODE="all"
                ;;
            -h|--help|help)
                show_help
                exit 0
                ;;
            *)
                error "Unknown argument: $arg. Use -h for help."
                ;;
        esac
    done
}

require_build_toolchain() {
    command -v node >/dev/null 2>&1 || error "Node.js is required for build (npm run build)"
    command -v npm >/dev/null 2>&1 || error "npm is required"
}

configure_mode() {
    local target_mode="$1"

    if [[ "$target_mode" == "vdm" ]]; then
        VERSION="$vdm_ver"
        RELEASE_TYPE="VDM"
        ARCHIVE_NAME="auxinux-vdm-v${VERSION}.tar.gz"
        ARCHIVE_PATH="${PARENT_DIR}/${ARCHIVE_NAME}"
        DEST_DIR_NAME="auxinux-vdm"

        REQUIRED_SOURCE_FILES=(
            "apps/vdm/src/server.ts"
            "apps/vdm/src/db.ts"
            "apps/vdm/package.json"
            "apps/vdm/tsconfig.json"
            "apps/vdm-ui/src/App.tsx"
            "apps/vdm-ui/package.json"
            "packages/shared/src/types/vm.ts"
            "packages/shared/src/types/user.ts"
            "INSTALL/vdm-install.sh"
            "INSTALL/vdm-ha-agent"
            "INSTALL/VDM-README.md"
        )

        REQUIRED_DIST_DIRS=(
            "packages/shared/dist"
            "apps/vdm/dist"
            "apps/vdm-ui/dist"
        )
    else
        VERSION="$node_ver"
        RELEASE_TYPE="AuxiNux Node"
        ARCHIVE_NAME="auxinuxvirtual-v${VERSION}.tar.gz"
        ARCHIVE_PATH="${PARENT_DIR}/${ARCHIVE_NAME}"
        DEST_DIR_NAME="auxinuxvirtual"

        REQUIRED_SOURCE_FILES=(
            "apps/ui/src/pages/NodeOverviewPage.tsx"
            "apps/ui/src/pages/CreateWizardPage.tsx"
            "apps/ui/src/components/Layout/TopBar.tsx"
            "apps/ui/src/components/Layout/Sidebar.tsx"
            "apps/api/src/server.ts"
            "apps/api/src/db.ts"
            "apps/cli/src/cli.ts"
            "apps/vdm/src/server.ts"
            "apps/vdm-ui/src/App.tsx"
            "INSTALL/vdm-install.sh"
            "INSTALL/vdm-ha-agent"
            "lang/FR.json"
            "lang/EN.json"
        )

        REQUIRED_DIST_DIRS=(
            "packages/shared/dist"
            "apps/runner/dist"
            "apps/api/dist"
            "apps/ui/dist"
            "apps/cli/dist"
        )
    fi
}

validate_sources() {
    local file
    for file in "${REQUIRED_SOURCE_FILES[@]}"; do
        [[ -f "$file" ]] || error "Required source file missing: $file"
    done
}

build_monorepo_if_needed() {
    if [[ "$BUILD_DONE" -eq 1 ]]; then
        info "Build already done in this run, skipping rebuild"
        return 0
    fi

    step "Build TypeScript + Vite"
    info "Full monorepo build..."
    AUXINUX_NODE_VERSION="$node_ver" AUXINUX_VDM_VERSION="$vdm_ver" npm run build 2>&1 | tail -20
    BUILD_DONE=1
}

validate_dist_outputs() {
    local d
    for d in "${REQUIRED_DIST_DIRS[@]}"; do
        [[ -d "$d" ]] || error "Distribution folder missing after build: $d"
    done
}

update_package_version() {
    local package_file="$1"
    local new_version="$2"

    [[ -f "$package_file" ]] || return 0

    node -e '
const fs = require("fs");
const file = process.argv[1];
const version = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.version = version;
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
' "$package_file" "$new_version"
}

stamp_archive_versions() {
    local dest_root="$1"
    local target_version="$2"

    update_package_version "$dest_root/package.json" "$target_version"
    update_package_version "$dest_root/packages/shared/package.json" "$target_version"

    if [[ "$RELEASE_TYPE" == "VDM" ]]; then
        update_package_version "$dest_root/apps/vdm/package.json" "$target_version"
        update_package_version "$dest_root/apps/vdm-ui/package.json" "$target_version"
    else
        update_package_version "$dest_root/apps/api/package.json" "$target_version"
        update_package_version "$dest_root/apps/ui/package.json" "$target_version"
        update_package_version "$dest_root/apps/runner/package.json" "$target_version"
        update_package_version "$dest_root/apps/cli/package.json" "$target_version"
    fi
}

create_archive() {
    local tmp_dir dest archive_size file d

    step "Create deployable archive (${RELEASE_TYPE})"

    tmp_dir="$(mktemp -d)"

    dest="$tmp_dir/$DEST_DIR_NAME"
    mkdir -p "$dest"

    info "Copy files (excluding node_modules/.git/.env)..."

    if command -v rsync >/dev/null 2>&1; then
        rsync -a \
            --exclude="node_modules" \
            --exclude=".git" \
            --exclude=".gitignore" \
            --exclude="*.env" \
            --exclude="*.env.local" \
            --exclude="*.log" \
            --exclude=".DS_Store" \
            --exclude="*.swp" \
            --exclude="*.tmp" \
            --exclude=".turbo" \
            --exclude=".vite" \
            --exclude="OS/" \
            --exclude="*.iso" \
            --exclude="*.img" \
            --exclude="Client_Desktop/" \
            --exclude="target/" \
            --exclude="packaging/deb/out/" \
            --exclude="packaging/deb/repo/" \
            --exclude="*.deb" \
            --exclude="*.dmg" \
            --exclude="*.tar.gz" \
            "$PROJECT_DIR/" \
            "$dest/"
    else
        cp -r "$PROJECT_DIR/." "$dest/"
        rm -rf "$dest/node_modules" "$dest/.git" "$dest/Client_Desktop" "$dest/OS" \
               "$dest/packaging/deb/out" "$dest/packaging/deb/repo"
        find "$dest" -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null || true
        find "$dest" -name "target" -type d -prune -exec rm -rf {} + 2>/dev/null || true
        find "$dest" -name "*.env" -delete 2>/dev/null || true
        find "$dest" -name "*.log" -delete 2>/dev/null || true
        find "$dest" -name ".DS_Store" -delete 2>/dev/null || true
    fi

    find "$dest" -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null || true
    # Belt-and-braces: drop heavy non-server artifacts even if rsync excludes were bypassed.
    rm -rf "$dest/Client_Desktop" "$dest/OS" 2>/dev/null || true
    find "$dest" -type d -name "target" -prune -exec rm -rf {} + 2>/dev/null || true
    stamp_archive_versions "$dest" "$VERSION"
    success "Copy complete"

    step "Validate archive content (${RELEASE_TYPE})"

    for file in "${REQUIRED_SOURCE_FILES[@]}"; do
        [[ -f "$dest/$file" ]] || error "File missing in release package: $file"
    done

    for d in "${REQUIRED_DIST_DIRS[@]}"; do
        [[ -d "$dest/$d" ]] || error "Directory missing in release package: $d"
    done

    printf '%s\n' "$VERSION" > "$dest/.auxinux-release-version"

    info "Compressing to $ARCHIVE_NAME..."
    tar czf "$ARCHIVE_PATH" -C "$tmp_dir" "$DEST_DIR_NAME"

    archive_size="$(du -sh "$ARCHIVE_PATH" | cut -f1)"
    success "Archive created: $ARCHIVE_PATH ($archive_size)"

    rm -rf "$tmp_dir"
}

print_deploy_instructions() {
    local target_mode="$1"
    local server_example="root@192.168.1.10"

    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║                  Deploy to the server                        ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""

    if [[ "$target_mode" == "vdm" ]]; then
        echo -e "${BOLD}Step 1 - Upload archive:${NC}"
        echo ""
        echo "  scp \"${ARCHIVE_PATH}\" ${server_example}:/tmp/"
        echo ""
        echo -e "${BOLD}Step 2 - On Debian 13 host:${NC}"
        echo ""
        echo "  ssh ${server_example}"
        echo "  cd /tmp"
        echo "  tar xzf ${ARCHIVE_NAME}"
        echo "  sudo bash auxinux-vdm/INSTALL/vdm-install.sh"
        echo ""
        echo "  # Update / repair / reset"
        echo "  sudo bash auxinux-vdm/INSTALL/vdm-install.sh -update"
        echo "  sudo bash auxinux-vdm/INSTALL/vdm-install.sh -repair"
        echo "  sudo bash auxinux-vdm/INSTALL/vdm-install.sh -reset"
    else
        echo -e "${BOLD}Step 1 - Upload archive:${NC}"
        echo ""
        echo "  scp \"${ARCHIVE_PATH}\" ${server_example}:/opt/"
        echo ""
        echo -e "${BOLD}Step 2 - On Debian 13 host:${NC}"
        echo ""
        echo "  ssh ${server_example}"
        echo "  mkdir -p /opt/auxinuxvirtual"
        echo "  tar xzf /opt/${ARCHIVE_NAME} -C /opt/auxinuxvirtual --strip-components=1"
        echo "  sudo bash /opt/auxinuxvirtual/INSTALL/install.sh -update"
    fi

    echo ""
}

run_mode() {
    local target_mode="$1"

    configure_mode "$target_mode"

    echo -e "\n${BOLD}${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}${BLUE}║  ${RELEASE_TYPE} - Release Build                             ║${NC}"
    echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}\n"

    info "Mode             : $target_mode"
    info "Project dir      : $PROJECT_DIR"
    info "Version          : $VERSION"
    info "Node version     : $node_ver"
    info "VDM version      : $vdm_ver"
    info "Target archive   : $ARCHIVE_PATH"

    step "Validate release sources (${RELEASE_TYPE})"
    validate_sources
    success "Expected sources are present"

    build_monorepo_if_needed

    step "Validate dist outputs (${RELEASE_TYPE})"
    validate_dist_outputs
    success "Dist outputs are present"

    create_archive
    print_deploy_instructions "$target_mode"
}

main() {
    parse_args "$@"
    require_build_toolchain

    if [[ "$MODE" == "all" ]]; then
        run_mode "node"
        run_mode "vdm"
        success "Release ready (node v${node_ver} + vdm v${vdm_ver})!"
    elif [[ "$MODE" == "vdm" ]]; then
        run_mode "vdm"
        success "Release v${vdm_ver} ready (vdm)!"
    else
        run_mode "node"
        success "Release v${node_ver} ready (node)!"
    fi
}

main "$@"
