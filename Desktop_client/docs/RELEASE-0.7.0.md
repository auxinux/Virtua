# Version 0.7.0

Création rapide de Windows 11 : l'ISO officielle, directement chez Microsoft,
en français ou en anglais (Canada).

- La carte Windows 11 demande la langue : **Français (Canada)** ou
  **English (Canada)**. Microsoft n'a pas d'ISO anglaise canadienne : c'est
  l'ISO « English » (États-Unis), réglée par le fichier de réponses en formats
  et clavier canadiens.
- L'ISO est téléchargée chez Microsoft, comme le fait Parallels : même
  interface publique que la page microsoft.com/software-download/windows11,
  empreinte SHA-256 vérifiée contre celle que Microsoft publie (une ISO qui
  ne correspond pas est supprimée). Plus rien ne vient du dépôt AuxiNux.
  Une ISO de la même langue déjà dans la bibliothèque sert telle quelle.
- Si le téléchargement automatique est impossible (bloqueur de publicités ou
  Pi-hole qui bloque vlscppe.microsoft.com / ov-df.microsoft.com, refus de
  Microsoft), le message donne la page officielle et le dossier où déposer
  l'ISO.
- Windows 11 26H2 (26300.9457, la seule ISO que Microsoft distribue
  maintenant) s'installe jusqu'au bureau : l'installation s'arrêtait sur
  « Un problème s'est produit » (OOBEZDP, OOBESETTINGSSELECTOR), des pages
  du premier démarrage qui dépassaient leur délai dans une VM. Le fichier de
  réponses les saute (SkipMachineOOBE, SkipUserOOBE) ; le compte, la
  connexion automatique et la préparation du mode Unifié s'appliquent
  toujours. Vérifié sous KVM jusqu'au bureau, agent démarré, RemoteApp actif.
