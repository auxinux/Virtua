# Version 0.2.4

Suite des retours sur l'installation de Windows 11 ARM et sur la console.

## Console : des boutons de repli là où on les cherche

- La liste **Consoles** a son propre bouton de repli dans son en-tête. Repliée,
  elle devient une colonne étroite d'icônes (point vert si la machine tourne) :
  on change encore de VM en un clic, et le bouton du haut la rouvre.
- Replier les **barres d'information** les retire entièrement — plus de ligne
  résiduelle. Le bouton pour les rouvrir, le mode console et le choix
  graphique/texte passent dans la barre d'actions de la console (ou dans un
  coin de la console texte).

## Comprendre un démarrage dégradé

- Le journal QEMU (`Logs/<VM>-qemu.log`) garde maintenant **chaque tentative**
  de démarrage : ses réglages, la ligne de commande (mot de passe SPICE masqué)
  et ce que QEMU a répondu. Avant, il était vidé à chaque échec et la raison
  pour laquelle l'accélération matérielle (HVF) était refusée disparaissait.
- Quand une VM démarre après un repli, le bandeau jaune cite aussi l'erreur de
  la première tentative refusée.
- Secure Boot activé sur une VM locale est signalé comme non émulé au lieu
  d'être ignoré en silence.

## Windows sur ARM

- Passer une VM ARM64 en **Système invité : Windows** règle aussi le bus
  disque en NVMe et la carte graphique en VGA standard (ramfb). Les deux
  restent modifiables avant de sauvegarder.
- Une VM Windows ARM encore en virtio affiche un avertissement sur son
  Sommaire : sans NVMe l'installeur ne voit aucun disque, sans ramfb l'écran
  fige après le démarrage.
