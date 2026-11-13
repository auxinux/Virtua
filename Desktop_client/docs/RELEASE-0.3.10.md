# Version 0.3.10

Création rapide Windows 11 (mode local) : l'installation automatique va au bout.

Elle échouait à la fin de la copie des fichiers (« Échec de l'installation de
Windows 11 »), après un écran « Sélectionner l'emplacement d'installation »
qui n'aurait jamais dû apparaître.

- Le fichier de réponses (autounattend.xml) était présenté comme une clé USB.
  Windows la voyait avant le disque de la VM et en faisait le **Disque 0**,
  celui que le fichier de réponses efface et sur lequel il installe. Sur x86,
  il est maintenant servi par une disquette (lecteur A:), qui n'est jamais un
  disque pour l'installation de Windows — comme sur le serveur Virtua.
  ARM64 (pas de lecteur de disquette) garde la clé USB.
- « Press any key to boot from CD » reçoit F12 au lieu d'Entrée : sur un
  portable rapide, l'installation copiait déjà ses fichiers pendant ces
  25 secondes, et un Entrée appuyait sur « Annuler ».

Vérifié avec QEMU 10 + KVM, l'ISO Windows 11 du dépôt et virtio-win 0.1.302 :
avec la clé USB, l'écran de choix du disque apparaît (la panne signalée) ;
avec la disquette, partitionnement automatique, copie à 100 %, redémarrage.
