# Firmware UEFI embarqué

Windows 11 exige un firmware UEFI avec Secure Boot et les clés Microsoft.
Le QEMU de Homebrew (ARM64) et les builds QEMU pour Windows n'en fournissent
pas : ces images sont donc intégrées à l'application (`src/firmware.rs`) et
extraites au premier usage dans `Local/Firmware/<version>/`.

| Fichier | Origine |
| --- | --- |
| `aarch64-code.secboot.fd.gz` | ArmVirtQemu compilé par `build-aarch64.sh` : sources EDK2 de QEMU v11.1.2 (`roms/edk2` @ `4dfdca63`), options du `edk2-aarch64-code.fd` de QEMU + `SECURE_BOOT_ENABLE`, sans shell UEFI |
| `aarch64-vars.fd.gz` | `QEMU_VARS.fd` du même build (vide, Secure Boot désactivé) |
| `aarch64-vars.windows.fd.gz` | ce même magasin + clés Microsoft et dbx, Secure Boot activé (voir ci-dessous) |
| `x86_64-code.secboot.fd.gz` | `OVMF_CODE_4M.secboot.fd` (exige SMM) — Debian `ovmf` 2025.02-8+deb13u1 |
| `x86_64-vars.fd.gz` | `OVMF_VARS_4M.fd` (vide) — même paquet |
| `x86_64-vars.windows.fd.gz` | `OVMF_VARS_4M.fd` + clés Microsoft, Secure Boot activé |

Pourquoi ne pas reprendre l'AAVMF de Debian sur ARM64 : sous HVF sur un Mac
M4 (macOS 27), il laissait Windows bloqué sur « Start boot option », alors que
le firmware de QEMU démarrait le même ISO. Le firmware ARM64 est donc compilé
depuis exactement les sources et options de celui de QEMU (DEBUG silencieux,
politique NX `nx.broken.shim.grub`), avec Secure Boot en plus.

Paquet source x86 (SHA-256 du `.deb`) :

- `ovmf_2025.02-8+deb13u1_all.deb` —
  `78e0d54df11fc77406cb7a0bc9a39e5bca6d1cbe06556b91d9a73491c52decdf`

Les magasins `*.windows.fd` portent le jeu de clés d'un PC Windows 11 :
PK « Windows OEM Devices PK », KEK Microsoft 2011 et 2023, db Windows
Production PCA 2011, Windows UEFI CA 2023, UEFI CA 2011/2023 et Option ROM
UEFI CA 2023. Ils ont été générés avec `virt-firmware` (Red Hat) :

```sh
virt-fw-vars -i edk2-aarch64-secure-vars.fd -o vars.windows.fd \
  --enroll-microsoft --microsoft-db all --microsoft-kek all --sb
virt-fw-vars -i OVMF_VARS_4M.fd   -o OVMF_VARS_4M.win.fd \
  --enroll-microsoft --microsoft-db all --microsoft-kek all --sb
gzip -9c vars.windows.fd > aarch64-vars.windows.fd.gz   # etc.
```

Après toute mise à jour d'une image, changer `BUNDLE_VERSION` dans
`src/firmware.rs`. EDK2 est sous licence BSD-2-Clause-Patent; le détail est
dans `COPYRIGHT.edk2-debian`.
