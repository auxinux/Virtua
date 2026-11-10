# Version 0.3.7

Windows : QEMU et Docker s'installent même quand winget est bloqué.

Sur beaucoup de PC Windows, winget est désactivé par une stratégie ou absent
(« 0x80070001 : Fonction incorrecte »), et Virtua Desktop ne savait installer
QEMU qu'avec lui.

- **QEMU** : winget d'abord ; s'il est absent ou échoue, Virtua télécharge le
  dernier installateur officiel (qemu.weilnetz.de/w64, celui vers lequel
  pointe qemu.org), vérifie sa somme SHA-512 publiée à côté, et le lance en
  silencieux — une seule demande d'autorisation administrateur de Windows.
- **« J'ai déjà QEMU : choisir son dossier »** : pour un QEMU installé par
  l'informatique ou une version portable (dossier contenant `qemu-img` et
  `qemu-system-x86_64`, ou son sous-dossier `bin`). Virtua le cherche ensuite
  en premier. Proposé aussi quand l'installation n'est pas possible (pas de
  droits administrateur, téléchargement bloqué).
- **Docker Desktop** : même repli, installateur officiel de docker.com.
- Le code Windows de Virtua Desktop est maintenant vérifié à la compilation
  pour la cible Windows à chaque modification.
