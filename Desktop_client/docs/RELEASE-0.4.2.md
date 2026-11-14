# Version 0.4.2

Création rapide Windows 11 ARM64 (Mac Apple Silicon) : tous les pilotes
VirtIO s'installent au premier login.

En 0.4.1, seuls les dossiers `w11\ARM64` du disque virtio-win étaient lus :
la carte réseau marchait, mais d'autres périphériques restaient inconnus,
alors que « Rechercher automatiquement » sur le disque virtio-win, appareil
par appareil, leur trouvait un pilote. Le premier login fait maintenant la
même chose pour tous les appareils d'un coup :

```bat
pnputil /add-driver <disque virtio-win>:\*.inf /subdirs /install
```

Le disque virtio-win est reconnu par son fichier `virtio-win_license.txt`
(jamais l'ISO Windows). Le détail de l'installation des pilotes est écrit dans
`C:\Windows\Temp\virtua-drivers.log` (x64 et ARM64).

VM déjà installée : invite de commandes administrateur dans la VM, puis
(remplacez F: par la lettre du disque virtio-win) :

```bat
pnputil /add-driver F:\*.inf /subdirs /install
```
