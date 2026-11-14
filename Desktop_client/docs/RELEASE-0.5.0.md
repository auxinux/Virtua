# Version 0.5.0

**Nouveau : l'Agent Virtua**, notre propre agent pour les VM Windows.

Jusqu'ici, Virtua Desktop parlait à Windows par l'agent QEMU, qui n'existe
qu'en x64 (émulé sur un Mac Apple Silicon), n'accepte qu'un client à la fois
et passe par PowerShell pour tout. L'Agent Virtua est un service Windows
natif, **x64 et ARM64**, écrit en Rust (`Desktop_client/agent`), qui parle à
Virtua Desktop par son propre port série virtio (`org.auxinux.virtua.0`).

- **Une seule connexion par VM, partagée** : état « Windows prêt », adresse
  IP, mode Unifié et arrêt passent tous par elle. Plus de collision sur le
  port de l'agent (l'erreur 54 du mode Unifié sur Mac).
- **Commandes** : `hello` (version, Windows, architecture), `ping`,
  `network` (adresses IP), `exec` (programmes et PowerShell, en natif, en
  parallèle : une commande longue ne bloque pas les autres), `shutdown`.
- **Création rapide Windows 11** : l'agent est posé à côté du fichier de
  réponses et installé au premier login (service `VirtuaAgent`, démarrage
  automatique, relance en cas d'arrêt).
- **VM existantes** (créées avant 0.5.0) : arrêtez puis démarrez la VM une fois
  (pour qu'elle reçoive le port de l'agent), puis Mode Unifié → **« Installer
  l'Agent Virtua »** : l'agent est copié par l'agent QEMU et installé.
- L'agent QEMU reste utilisé quand l'Agent Virtua n'est pas là.

Testé dans un vrai Windows 11 25H2 x64 : installation par la création rapide
et par l'agent QEMU, `ping` en 1 ms, PowerShell en `NT AUTHORITY\SYSTEM`,
`ping` servi pendant une commande de 3 s, redémarrage (agent de retour en
25 s). La version ARM64 est construite de la même source, non testée ici.

À venir : presse-papiers partagé, résolution qui suit la fenêtre.
