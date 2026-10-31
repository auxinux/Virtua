# Version 0.3.1

Virtua Desktop prend l'apparence d'AuxiNux Shell et tient sur un écran de
portable (1366×768).

## Apparence AuxiNux Shell

- Palettes claire et sombre d'AuxiNux Shell (mêmes couleurs que ses fenêtres),
  navigation à la manière des Paramètres : lignes de 36 px, pastille d'accent
  sur l'élément choisi, rayons de 4 et 8 px, police Inter.
- En automatique (par défaut), Virtua suit la session en direct : clair ou
  sombre (y compris le mode lever/coucher du soleil du Shell), couleur
  d'accent, contraste élevé — lus dans le portail XDG que le Shell publie —
  ainsi que la police, la taille du texte et les animations de sa
  configuration. Hors AuxiNux Shell : le mode clair/sombre du système.
- En clair, l'accent est assombri (comme Windows 11 et le Shell) pour rester
  lisible ; le texte posé sur l'accent est blanc ou foncé selon le contraste.
- Configuration → Apparence : Automatique, Clair, Sombre ou « Virtua
  classique » (l'apparence d'avant).

## Petits écrans

- La fenêtre s'ouvre agrandie sur un écran de moins de 1440×900 ; taille
  minimale ramenée à 800×520 (elle était de 1100×720 et dépassait sous la
  barre des tâches sur un écran de 768 px).
- Barre latérale plus compacte, repliée automatiquement sous 1200 px de large
  (le choix manuel est retenu) ; la liste des nœuds laisse la place au menu
  sur les écrans de moins de 820 px de haut.
- Console : hauteur minimale réduite (elle forçait un défilement) ;
  tableau de bord : les colonnes ne s'empilent plus trop tôt.
