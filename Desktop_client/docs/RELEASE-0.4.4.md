# Version 0.4.4

Mode Unifié sur Mac, et l'affichage des VM Windows ARM64.

- **« Agent invité injoignable : Connection reset by peer (os error 54) »**
  en mode Unifié (liste des applications) : le port de l'agent invité QEMU
  n'accepte qu'un client à la fois, et le Desktop l'interrogeait aussi
  périodiquement (état « Windows prêt », adresse IP). Sur macOS, une connexion
  de trop est coupée net. Les échanges avec l'agent passent maintenant chacun
  leur tour (verrou par VM) ; les sondes périodiques sautent leur tour quand
  le mode Unifié parle à l'agent, et une connexion coupée est retentée.
- **Windows 11 ARM64** : la création rapide installe sur l'affichage de base
  (ramfb), puis passe la VM en carte graphique **virtio** une fois Windows
  prêt (pilote viogpudo installé au premier login) : résolution réglable dès
  le démarrage suivant. Vérifié sur Mac Apple Silicon.
