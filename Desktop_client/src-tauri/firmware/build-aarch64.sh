#!/usr/bin/env bash
# Rebuilds the ARM64 Secure Boot firmware bundled with Virtua Desktop.
#
# Same sources and options as the edk2-aarch64-code.fd that QEMU ships (and
# that boots Windows under HVF on Apple Silicon), plus SECURE_BOOT_ENABLE and
# without the built-in UEFI shell. Debian's AAVMF 2025.02 left Windows stuck
# on "Start boot option" under HVF on an M4.
#
# Needs a Debian/Ubuntu host with: gcc-aarch64-linux-gnu acpica-tools uuid-dev
# python3 python3-setuptools git make. Output: ./out/
set -euo pipefail

QEMU_TAG="${QEMU_TAG:-v11.1.2}"
WORK="${WORK:-$PWD/fwbuild}"
OUT="$PWD/out"
mkdir -p "$WORK" "$OUT"

if [ ! -d "$WORK/qemu" ]; then
  git clone -q --depth 1 --branch "$QEMU_TAG" https://gitlab.com/qemu-project/qemu.git "$WORK/qemu"
fi
cd "$WORK/qemu"
git submodule update --init --depth 1 roms/edk2
(cd roms/edk2 && git submodule update --init --depth 1 --recursive)
EDK2_SHA="$(git -C roms/edk2 rev-parse --short=8 HEAD)"

cd roms
if ! grep -q '^\[build.armvirt.aa64.secure\]' edk2-build.config; then
  cat >> edk2-build.config <<'CFG'

[opts.armvirt.sb]
SECURE_BOOT_ENABLE       = TRUE
BUILD_SHELL              = FALSE

[build.armvirt.aa64.secure]
desc = ArmVirt build, 64-bit (arm v8), secure boot
conf = ArmVirtPkg/ArmVirtQemu.dsc
arch = AARCH64
opts = common
       armvirt.silent
       armvirt.sb
pcds = nx.broken.shim.grub
plat = ArmVirtQemu-AARCH64
dest = ../pc-bios-virtua
cpy1 = FV/QEMU_EFI.fd  edk2-aarch64-secure-code.fd
cpy2 = FV/QEMU_VARS.fd edk2-aarch64-secure-vars.fd
pad1 = edk2-aarch64-secure-code.fd  64m
pad2 = edk2-aarch64-secure-vars.fd  64m
CFG
fi
mkdir -p ../pc-bios-virtua
# The C tools build; only their self-tests want a `python` binary.
make -s -C edk2/BaseTools -j"$(nproc)" >/dev/null 2>&1 || true
python3 edk2-build.py --config edk2-build.config --match armvirt.aa64.secure \
  -j "$(nproc)" --core edk2 \
  --version-override "edk2-${EDK2_SHA}-qemu-${QEMU_TAG}-virtua-sb" \
  --release-date "$(git -C edk2 log -1 --format=%cd --date=format:%m/%d/%Y)"

cp ../pc-bios-virtua/edk2-aarch64-secure-code.fd ../pc-bios-virtua/edk2-aarch64-secure-vars.fd "$OUT/"
echo "Built into $OUT. Enroll the Microsoft keys with:"
echo "  virt-fw-vars -i $OUT/edk2-aarch64-secure-vars.fd -o $OUT/vars.windows.fd \\"
echo "    --enroll-microsoft --microsoft-db all --microsoft-kek all --sb"
