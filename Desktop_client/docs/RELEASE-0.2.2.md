# Version 0.2.2

Connexion à un **VDM (Virtua Datacenter Manager)**, et une page Connexion qui
dit enfin la vérité.

## Se connecter à un VDM

Le VDM n'exposait aucune API Desktop : sa protection CSRF renvoyait
« Missing csrf secret » à toute tentative, et il n'y avait aucune fonction
d'appairage comme sur un nœud Virtua. Les deux sont corrigés côté serveur
(Virtua 0.8.2). Côté client :

- Le champ **Serveur** rappelle les deux formes attendues : `https://hote:8441`
  pour un nœud Virtua, `http://hote:8440` pour un VDM. Sans schéma explicite,
  `https` reste supposé — c'est ce qui faisait échouer une saisie `hote:8440`.
- L'onglet **Code pairing** fonctionne avec les codes générés depuis
  Configuration → Virtua Desktop Client du panneau VDM.
- Connecté à un VDM, l'inventaire couvre tous les nœuds gérés et chaque machine
  affiche son nœud. Consoles terminal, VNC et SPICE relayées par le VDM :
  le poste n'a besoin d'une route que vers le port du VDM.
- Un compte `viewer` du VDM voit l'inventaire et ouvre les consoles; les
  actions restent réservées à un compte `admin`, comme dans le panneau web.

## Page Connexion

C'était un formulaire factice — champs sans effet, faux mot de passe,
boutons « Tester » et « Sauvegarder » morts. Elle affiche maintenant le serveur,
son type (nœud Virtua ou Datacenter Manager), le compte, le rôle, l'appareil
enregistré et la dernière synchronisation, et permet de renommer l'appareil
(le nom transmis au serveur à la prochaine connexion).

## Détails

- Le bandeau d'erreur de session précédente ne survit plus à une nouvelle
  tentative de connexion.
- `/api/desktop/me` peut désormais annoncer `capabilities.manager`; le client
  s'en sert pour distinguer un nœud d'un gestionnaire.

## Limites connues

- La gestion des appareils appairés (révocation, codes) reste dans le panneau
  web du serveur : ces routes exigent une session navigateur.
- Le reste des limites de 0.2.1 est inchangé.
