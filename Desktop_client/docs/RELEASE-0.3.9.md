# Version 0.3.9

La console tient dans la fenêtre, sur Linux, Windows et macOS.

Sur un portable (écran de 768 px de haut), le haut du panneau console
disparaissait : la barre de la machine (nom, démarrer / arrêter) et les cartes
d'information étaient coupées, il ne restait que le bas de la jauge RAM.

- L'écran de la VM qui prend le focus (SPICE, VNC, terminal) ne fait plus
  défiler le panneau vers le bas.
- La console n'impose plus 384 px de hauteur minimale : l'image se réduit avec
  la fenêtre au lieu de pousser les barres hors de vue.
- Fenêtre basse (moins de 820 px) : les quatre cartes (adresse, propriétaire,
  durée, agent) s'effacent, CPU et RAM tiennent sur une ligne.
- Sous 1024 px de large, la liste des machines reste à côté de la console au
  lieu de passer au-dessus.
