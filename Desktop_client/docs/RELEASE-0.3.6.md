# Version 0.3.6

Le mode Cloud reçoit les nouveautés de Virtua 0.8.11 (serveur 0.8.12 requis).

- **Créer une machine** sur un nœud : bus disque (dont IDE), type de machine
  (q35 / pc), modèle de processeur (80286 → Pentium 4, modèles récents) avec
  « Vitesse d'époque », cartes NE2000 / PCnet, disquette de la bibliothèque du
  serveur — limités à ce que le nœud accepte (sur ARM : pas d'IDE ni de CPU
  d'époque).
- **Création rapide** Windows 11 / Debian 13 faite par le serveur ; Virtua
  Desktop ouvre « Tâches » pour suivre le téléchargement et l'installation.
- **Fiche d'une VM** : machine, processeur, vitesse d'époque et disquette
  modifiables (au prochain démarrage si la VM tourne).
- **Jetables** dans le menu Cloud : lancer une jetable sur les bases du
  serveur, puis la jeter, la remettre à neuf, la garder ou la convertir.
- Un serveur plus ancien garde le formulaire d'avant.
- Connexion : sur Mac, signature locale stable (`build-macos.sh`) pour que
  l'autorisation « Réseau local » tienne d'un build à l'autre.
