# Version 0.7.3

Mode Unifié sur Linux (AuxiNux OS) : « Mot de passe Windows introuvable dans
le trousseau : refaites la préparation du mode Unifié » à chaque lancement
d'application après un redémarrage.

Sous Linux, le mot de passe allait dans le trousseau du noyau (keyutils,
vidé au redémarrage) et dans le Secret Service (gnome-keyring, KWallet…). Sans
Secret Service — AuxiNux OS n'en a pas —, il disparaissait au premier
redémarrage, et refaire la préparation ne le gardait pas davantage.

- Le mot de passe est aussi gardé dans un fichier privé de l'utilisateur
  (droits 0600, dans les données de Virtua Desktop), lu si le trousseau ne
  l'a plus.
- Les VM de la création rapide (compte virtua / virtua) retrouvent leur mot
  de passe d'office.
