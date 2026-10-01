# Version 0.2.11

Windows 11 ARM démarre sous l'accélération du Mac (HVF) avec Secure Boot.

## Cause

Le firmware Secure Boot ARM64 de la 0.2.6 venait de Debian (AAVMF 2025.02).
Sous HVF sur un Mac M4 (macOS 27), il restait bloqué sur « Start boot option »
au lancement du CD Windows, avec un pointeur très lent. Le firmware fourni par
QEMU démarrait le même ISO sans problème — mais sans Secure Boot.

## Correctif

Le firmware ARM64 embarqué est maintenant compilé à partir des mêmes sources
et options que celui de QEMU 11.1.2 (`roms/edk2`), avec Secure Boot en plus et
sans shell UEFI. Son magasin de variables reçoit le même jeu de clés que celui
d'un PC Windows 11 (Microsoft 2011 et 2023, dbx compris). Recette
reproductible : `src-tauri/firmware/build-aarch64.sh`.

Les VM ARM64 existantes reçoivent un nouveau magasin de variables
(`<disque>.secboot-vars-q11.fd`) : celui de la 0.2.6 venait du firmware Debian
et n'est plus utilisé. Le firmware x86 (OVMF de Debian) ne change pas.

## Pour la VM Windows bloquée

Remettre « Système invité : Windows » et cocher Secure Boot et TPM 2.0, puis
redémarrer la VM.
