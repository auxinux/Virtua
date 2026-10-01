# Version 0.2.3

Windows 11 sur Mac Apple Silicon, une console qui laisse toute la place à
l'écran de la VM, et un mode local plus léger sur Mac ARM.

## Windows 11 ARM : les disques et les pilotes

L'installeur Windows ne voyait aucun disque et réclamait un pilote. Deux causes :

- Sur ARM64, `-cdrom` devient un disque virtio-blk sur la machine `virt` —
  invisible pour Windows. Les lecteurs CD d'une VM ARM64 sont maintenant des
  **périphériques de stockage USB**, lus par tous les installeurs ARM64.
- Le disque était toujours virtio, sans pilote dans Windows. Nouveau bus
  **NVMe**, reconnu par Windows sans pilote, proposé sur ARM64 et x86.

Et :

- **Second lecteur CD « ISO pilotes »** : l'installeur et `virtio-win.iso`
  sont montés en même temps. Bouton « Pilotes VirtIO pour Windows » dans
  Configuration de la VM; à la création, case « Insérer les pilotes VirtIO »
  (téléchargés une seule fois dans le Storage).
- **Système invité** (Linux / autre, Windows), deviné depuis le nom de l'ISO.
  Pour Windows sur ARM64 : disque NVMe, affichage `ramfb` (Windows n'a pas de
  pilote virtio-gpu et son écran figeait après le démarrage), carte réseau
  virtio **PCI** (le pilote NetKVM ne gère pas la variante MMIO).
- **TPM 2.0 réel** via `swtpm` (Windows 11 l'exige). L'option était jusqu'ici
  ignorée. `swtpm` est installé avec QEMU par l'assistant; sur une installation
  existante : `brew install swtpm`. Indisponible sur un hôte Windows.
- **Variables UEFI persistantes** sur ARM64 (firmware en pflash + fichier
  `.efivars.fd` à côté du disque) : les entrées de démarrage survivent au
  redémarrage. Repli automatique sur l'ancien mode si QEMU refuse.

## Console : replier toutes les barres

- Boutons pour replier la **liste des machines** et les **barres
  d'information** (une ligne fine garde le nom, l'état et le mode).
- **Mode console** : barre latérale, en-tête, liste et barres disparaissent;
  il ne reste que l'écran (graphique ou texte).
- **Masquer la barre d'actions** (Ctrl+Alt+Del, Redémarrer, Plein écran) :
  option à activer dans la barre elle-même. Elle n'apparaît alors qu'en
  amenant le pointeur en haut de l'écran de la VM. « Épingler la barre »
  revient à l'affichage permanent. Préférences conservées sur le poste.

## Mac ARM : performances

- VM x86 émulées : TCG multi-thread (`thread=multi`). Une VM x86 à 4 vCPU
  n'utilisait qu'un seul cœur du Mac.
- Le rafraîchissement des métriques n'énumère plus tous les processus du Mac
  à chaque passage (`System::new_all()` remplacé par CPU + mémoire seuls).
- Télécharger une ISO ne bloque plus le démarrage ni l'arrêt des VM pendant
  toute la durée du transfert.

## Limites connues

- Secure Boot reste non émulé en mode local.
- Les VM Linux ARM64 existantes gardent leur carte réseau virtio MMIO (le nom
  d'interface ne change pas); seules les VM marquées Windows passent en PCI.
