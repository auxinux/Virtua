#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="$(basename "$ROOT_DIR")"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$ROOT_DIR/build-transfer"
STAGE_DIR="$OUT_DIR/${APP_NAME}-build-source"
ZIP_PATH="$OUT_DIR/${APP_NAME}-build-source-$STAMP.zip"

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR" "$OUT_DIR"

rsync -a "$ROOT_DIR/" "$STAGE_DIR/" \
  --exclude ".git/" \
  --exclude ".claude/" \
  --exclude ".DS_Store" \
  --exclude "node_modules/" \
  --exclude "dist/" \
  --exclude "test-results/" \
  --exclude "playwright-report/" \
  --exclude "build-transfer/" \
  --exclude "src-tauri/gen/" \
  --exclude "src-tauri/target/" \
  --exclude "*.log"

chmod +x "$STAGE_DIR/scripts/build-linux.sh" || true

(
  cd "$OUT_DIR"
  rm -f "$ZIP_PATH"
  zip -qr "$ZIP_PATH" "${APP_NAME}-build-source"
)

echo "Archive prete:"
echo "$ZIP_PATH"
echo
echo "Sur Linux:"
echo "  unzip $(basename "$ZIP_PATH")"
echo "  cd ${APP_NAME}-build-source"
echo "  ./scripts/build-linux.sh"
echo
echo "Sur Windows PowerShell:"
echo "  Expand-Archive .\\$(basename "$ZIP_PATH") -DestinationPath ."
echo "  cd .\\${APP_NAME}-build-source"
echo "  Set-ExecutionPolicy -Scope Process Bypass"
echo "  .\\scripts\\build-windows.ps1"
