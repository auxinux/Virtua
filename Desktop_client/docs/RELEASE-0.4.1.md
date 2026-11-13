# Version 0.4.1

Création rapide Windows 11 : pilotes VirtIO sur ARM64 (Mac Apple Silicon),
et une ISO publiée avant une build Insider.

- **ARM64** : Windows 11 sortait de l'installation automatique avec des
  périphériques inconnus (carte réseau, etc.). Les pilotes ARM64 sont bien sur
  le disque virtio-win, mais l'étape du premier login ne lançait que
  `virtio-win-guest-tools.exe`, qui n'existe qu'en x64. Le premier login
  installe maintenant **tous les pilotes `w11\<architecture>`** du disque
  virtio-win avec `pnputil`, quelle que soit sa lettre, sur x64 comme sur
  ARM64. Sur ARM64, l'agent invité QEMU (qui n'existe qu'en x64) est installé
  et tourne sous l'émulation x64 de Windows 11.
- **ISO** : la build Insider 26300 (la plus grosse du dépôt, donc choisie)
  bloque l'installation automatique à l'écran « Un problème s'est produit —
  OOBEZDP ». Une ISO publiée (`…24h2…`, `…25H2…`) est désormais prise avant
  une Insider, dans la bibliothèque puis sur le dépôt. Sur ARM64, le dépôt
  n'a aujourd'hui qu'une Insider : déposez une ISO ARM64 publiée
  (microsoft.com/software-download/windows11arm64) dans la bibliothèque ISO.

VM ARM64 déjà installée : dans une invite de commandes administrateur, avec
le disque virtio-win monté :

```bat
for %d in (D E F G H I J) do @for /d %p in (%d:\*) do @if exist %p\w11\ARM64\*.inf pnputil /add-driver %p\w11\ARM64\*.inf /install
```
