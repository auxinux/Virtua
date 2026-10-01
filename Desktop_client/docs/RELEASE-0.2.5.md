# Version 0.2.5

Windows 11 s'installe sur une VM locale, et le bandeau de démarrage dit
enfin pourquoi l'accélération matérielle est refusée.

## Installer Windows 11 malgré l'absence de Secure Boot

Le firmware ARM de QEMU (Homebrew) ne fournit pas Secure Boot, et l'installeur
Windows 11 s'arrêtait sur « L'ordinateur personnel doit prendre en charge le
démarrage sécurisé ».

Pour une VM **Windows** dont l'ISO d'installation est montée, Virtua Desktop
présente maintenant un petit disque FAT en lecture seule contenant un
`autounattend.xml` — la méthode de Rufus. L'installeur le lit tout seul :

- clés `LabConfig` : contrôles TPM, Secure Boot, RAM, stockage et processeur
  levés;
- `BypassNRO` : la configuration initiale peut se terminer sans réseau, avant
  l'installation du pilote NetKVM depuis le lecteur des pilotes VirtIO.

Option « Contourner les exigences de Windows 11 », active par défaut, dans
Configuration de la VM. Elle ne s'applique que tant que l'ISO d'installation
est montée. Redémarrer la VM pour relancer l'installeur avec le contournement.

## Diagnostic du démarrage

- Le QEMU de Homebrew est compilé sans SPICE. Une fois QEMU l'a signalé, les
  autres tentatives SPICE sont sautées (démarrage plus rapide) et le bandeau
  l'indique : console VNC, pas de son.
- Quand la VM finit en émulation logicielle (TCG), le bandeau cite l'erreur de
  la dernière tentative accélérée (HVF), et non plus l'erreur SPICE qui la
  masquait.
