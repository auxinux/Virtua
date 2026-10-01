# Version 0.2.6

Windows 11 installé comme sur un vrai PC : **Secure Boot réel** et TPM 2.0
émulé, sans contournement.

## Secure Boot avec les clés Microsoft

Ni le QEMU de Homebrew (ARM64) ni les builds QEMU pour Windows ne fournissent
un firmware UEFI capable de Secure Boot avec les clés Microsoft. Virtua Desktop
embarque maintenant le sien (3 Mo compressés) :

- Firmware EDK2 Secure Boot de Debian (`AAVMF` pour ARM64, `OVMF` 4M pour x86).
- Magasin de variables avec le jeu de clés d'un PC Windows 11 : PK « Windows
  OEM Devices », KEK Microsoft 2011 **et 2023**, db Windows Production PCA
  2011 **et** Windows UEFI CA 2023, UEFI CA 2011/2023. Les médias Windows
  récents, signés par la CA 2023, démarrent aussi.
- Secure Boot actif dès le premier démarrage. Sur x86, les variables sont
  protégées par SMM, comme sur un vrai PC : le système invité ne peut pas
  réécrire les clés.

Utilisé pour toute VM **Windows** (x86 : UEFI au lieu de SeaBIOS) et pour toute
VM avec l'option Secure Boot. Chaque VM a son propre magasin
(`<disque>.secboot-vars.fd`); les autres VM gardent le firmware de QEMU.
Choisir « Système invité : Windows » coche Secure Boot et TPM 2.0.

## Le contournement devient un repli

L'`autounattend.xml` de 0.2.5 n'est plus monté quand TPM 2.0 et Secure Boot
sont réellement émulés : Windows passe ses contrôles normalement. Il ne sert
plus que si l'un des deux est impossible sur l'ordinateur hôte.

## Limites

- **Hôte Windows** : QEMU n'y émule pas de TPM (son émulateur TPM n'existe que
  sur macOS et Linux). Secure Boot fonctionne, mais un Windows 11 « comme en
  production » sur un hôte Windows demande Hyper-V, qui a son propre TPM
  virtuel.
- **Hôte Windows, VM x86** : le Secure Boot x86 exige SMM; si l'accélération
  WHPX le refuse, la VM démarre en émulation logicielle (le bandeau le dit).
- Changer l'option Secure Boot crée un nouveau magasin de variables : les
  entrées de démarrage sont recréées par le firmware.
