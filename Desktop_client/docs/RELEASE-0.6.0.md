# Version 0.6.0

**Presse-papiers partagé et résolution qui suit la fenêtre**, par l'Agent
Virtua 0.2.0 (VM Windows locales, x64 et ARM64).

- **Presse-papiers** : copiez sur l'ordinateur, collez dans Windows, et
  inversement (texte, accents, emoji, plusieurs lignes). Il n'est partagé
  qu'avec la VM dont la console est affichée : une VM en arrière-plan ne
  reçoit pas votre presse-papiers et ne peut pas le modifier.
- **Résolution** : Windows prend le plus grand mode d'affichage qui tient
  dans la console, et suit quand vous agrandissez ou réduisez la fenêtre (avec
  la carte graphique virtio ; la carte de base n'offre qu'un mode).
- L'agent lance pour cela un assistant dans la session de l'utilisateur
  (`virtua-agent.exe session`), relié au service par un tube nommé réservé au
  système et aux utilisateurs connectés.

**Mettre à jour une VM** : Mode Unifié → « Mettre à jour l'Agent Virtua »
(VM démarrée ; l'agent QEMU fait la copie). Les nouvelles créations rapides
Windows 11 ont directement la 0.2.0.

Testé dans un vrai Windows 11 25H2 x64 : texte posé depuis l'hôte puis relu
(accents, emoji, sauts de ligne), copie Ctrl+C dans le Bloc-notes reçue par
l'hôte, résolutions 1360×768, 1920×1080, 1440×900 et 800×600 appliquées
d'après la taille de la console (vérifiées sur l'écran de la VM). ARM64 :
même source, non testé ici.
