#!/usr/bin/env bash
# Convenience entrypoint from the project root.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/packaging/deb/sync-os-mirrors.sh" "$@"
