# Version 0.3.5

Correctifs de la préparation des bases Debian (VM jetables) et de
l'installation Debian sur ARM64 (Mac).

- **Base Debian bloquée en fin d'installation** : l'étape qui généralise la
  base (machine-id, clés SSH) écrivait sur le canal interne de
  l'installateur Debian (`systemctl enable` affiche un message) ; le menu
  devenait illisible et l'installation s'arrêtait sur « Continuer sans
  programme de démarrage ». Ses messages vont maintenant au journal de
  l'installateur.
- **Debian sur ARM64** : avec UEFI + ACPI, le port série restait la console
  préférée (table ACPI SPCR) malgré `console=tty0` ; l'installateur y
  tournait, ne proposait que la langue « C » et s'arrêtait sur « Select a
  language ». Il démarre avec `acpi=nospcr console=tty0` et s'affiche à
  l'écran.
