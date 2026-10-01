# Firmware UEFI embarqué

Windows 11 exige un firmware UEFI avec Secure Boot et les clés Microsoft.
Le QEMU de Homebrew (ARM64) et les builds QEMU pour Windows n'en fournissent
pas : ces images sont donc intégrées à l'application (`src/firmware.rs`) et
extraites au premier usage dans `Local/Firmware/<version>/`.

| Fichier | Origine |
| --- | --- |
| `aarch64-code.secboot.fd.gz` | `AAVMF_CODE.secboot.fd` — Debian `qemu-efi-aarch64` 2025.02-8+deb13u1 |
| `aarch64-vars.fd.gz` | `AAVMF_VARS.fd` (vide, Secure Boot désactivé) — même paquet |
| `aarch64-vars.windows.fd.gz` | `AAVMF_VARS.fd` + clés Microsoft, Secure Boot activé (voir ci-dessous) |
| `x86_64-code.secboot.fd.gz` | `OVMF_CODE_4M.secboot.fd` (exige SMM) — Debian `ovmf` 2025.02-8+deb13u1 |
| `x86_64-vars.fd.gz` | `OVMF_VARS_4M.fd` (vide) — même paquet |
| `x86_64-vars.windows.fd.gz` | `OVMF_VARS_4M.fd` + clés Microsoft, Secure Boot activé |

Paquets source (SHA-256 des `.deb`) :

- `qemu-efi-aarch64_2025.02-8+deb13u1_all.deb` —
  `a00b2411a79c8aeafd95a7c868ac3cd1aab592f1af9fff965f02d81a625276ed`
- `ovmf_2025.02-8+deb13u1_all.deb` —
  `78e0d54df11fc77406cb7a0bc9a39e5bca6d1cbe06556b91d9a73491c52decdf`

Les magasins `*.windows.fd` portent le jeu de clés d'un PC Windows 11 :
PK « Windows OEM Devices PK », KEK Microsoft 2011 et 2023, db Windows
Production PCA 2011, Windows UEFI CA 2023, UEFI CA 2011/2023 et Option ROM
UEFI CA 2023. Ils ont été générés avec `virt-firmware` (Red Hat) :

```sh
virt-fw-vars -i AAVMF_VARS.fd     -o AAVMF_VARS.win.fd \
  --enroll-microsoft --microsoft-db all --microsoft-kek all --sb
virt-fw-vars -i OVMF_VARS_4M.fd   -o OVMF_VARS_4M.win.fd \
  --enroll-microsoft --microsoft-db all --microsoft-kek all --sb
gzip -9c AAVMF_VARS.win.fd > aarch64-vars.windows.fd.gz   # etc.
```

Après toute mise à jour d'une image, changer `BUNDLE_VERSION` dans
`src/firmware.rs`. EDK2 est sous licence BSD-2-Clause-Patent; le détail est
dans `COPYRIGHT.edk2-debian`.
