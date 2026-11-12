# Version 0.3.8

Linux : Virtua Desktop est publié dans le dépôt apt AuxiNux
(`auxinux-virtua-desktop`), pour être intégré à AuxiNux OS.

- **Mode Cloud** : quand le serveur Virtua est trop ancien pour les nouvelles
  options de VM (type de machine, modèle de processeur, bus de disque, création
  rapide, VM jetables — serveur antérieur à 0.8.12), la fenêtre de création le
  dit et demande de mettre le nœud à jour en 0.8.12 ou plus, au lieu de
  revenir silencieusement à l'ancien formulaire.
- Reprend les nouveautés Windows de la 0.3.7 (QEMU et Docker sans winget).

Installation sur Debian 13 / AuxiNux OS (amd64) :

```sh
sudo curl -fsSL https://dep.auxinux.ca/VIRTUA/virtua.sources -o /etc/apt/sources.list.d/virtua.sources
sudo apt update && sudo apt install auxinux-virtua-desktop
```
