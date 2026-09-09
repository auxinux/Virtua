# Version 0.2.0

## Changements

- Conservation de l’interface React, des consoles et du connecteur serveur Virtua.
- Assistant QEMU obligatoire à l’entrée du mode local, cloud indépendant.
- Installation optionnelle et diagnostics Docker/LXC dans Configuration.
- Adaptation des chemins, exécutables `.exe`, métriques système et détection des
  processus aux trois OS. Accélérateurs QEMU HVF/KVM/WHPX selon OS et architecture;
  TCG pour les architectures différentes ou sans accélérateur disponible.
- Le diagnostic d’accélération confirme sa présence dans QEMU et les droits
  `/dev/kvm`; le lancement réel reste le test final du matériel/firmware/Windows.
- Moteur LXC unifié via Incus; profil/réseau/pool dédiés `virtua`, `virtuabr0`.
  Les profils existants ne sont pas réinitialisés. L’ancien client utilisait les
  commandes LXD `lxc`; une installation LXD préexistante n’est pas migrée automatiquement.
- VM auxiliaire Debian 13 native ARM64/AMD64, image vérifiée SHA512, cloud-init,
  clés SSH dédiées et vérification stricte du serveur. Disque conservé, reprise
  des préparations interrompues, arrêt explicite et consultation des journaux.
- Les installations concurrentes sont empêchées et les erreurs restent visibles.
- Docker local vérifie l’endpoint puis le fixe pour chaque commande; aucun
  serveur distant sélectionné dans le CLI n’est piloté comme un nœud local.
- Identifiants stockés avec les backends natifs de keyring pour chaque OS.
- Icône Windows ICO et configurations de build/CI multiplateformes.

## Limites connues

- Windows et Linux nécessitent leurs tests natifs et la validation des dialogues
  d’installation/élévation avant publication. La CI est fournie, pas encore exécutée.
- Windows ARM64 reste expérimental; WHPX est proposé ici uniquement pour AMD64.
- L’installation QEMU sur macOS utilise Terminal/Homebrew. Docker conserve son
  propre assistant utilisateur; Linux peut nécessiter une reconnexion de session.
- Le réseau LXC est NATé dans Debian; pas de publication de ports vers l’hôte dans
  cette version. Consoles et opérations de gestion passent par SSH local.
- Le pool LXC `dir` n’offre pas de quota de disque individuel. Les VM QEMU
  conservent leurs propres tailles de disque. Les champs de quotas LXC locaux
  sont masqués plutôt que d’afficher une limite non appliquée.
- Les fonctions héritées TPM/Secure Boot ne sont pas implémentées dans le lanceur
  QEMU local; ne pas les considérer comme garanties par leurs anciens champs.
- Le QEMU Guest Agent via socket Unix fonctionne sur Mac/Linux; son transport
  Windows reste à compléter. Les consoles VNC et le contrôle QMP utilisent TCP local.
  *(Corrigé en 0.2.1 : l'agent invité passe par un chardev TCP sur les trois OS.)*
- Les paquets ne sont ni signés ni notarisés et aucune publication n’est effectuée.
