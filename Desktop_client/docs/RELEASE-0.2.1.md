# Version 0.2.1

Version de fiabilité : mêmes fonctions, mais elles tiennent sur les trois OS.
Le déclencheur est un retour terrain — « ça marche relativement bien sur macOS,
plusieurs plantages sur Windows 11 et aucune VM ne démarre ».

## Stabilité de l'application

- **Les commandes longues ne bloquent plus la fenêtre.** Tauri exécute une
  commande synchrone sur le thread principal : l'inventaire de stockage
  (qui interroge Docker), la liste des templates distants, la création et le
  rollback de snapshot (des copies de plusieurs Gio), la modification et la
  suppression de VM, le trousseau et le démarrage de VM y étaient tous. Sur
  Windows, la fenêtre passait « Ne répond pas » et pouvait être tuée par le
  système. Toutes ces commandes s'exécutent maintenant hors du thread d'UI.
- **Un seul écrivain pour l'inventaire local.** Les commandes qui modifient
  `local-vms.json` se sérialisent; l'écriture passe par un fichier temporaire.
  Un arrêt brutal ne tronque plus le fichier, et un inventaire illisible est mis
  de côté au lieu d'empêcher l'ouverture du mode local.
- **Le rafraîchissement ne s'empile plus.** Le sondage périodique enchaîne les
  cycles au lieu de les déclencher à intervalle fixe : un hôte lent ne met plus
  la file d'attente en cascade.
- **Une erreur d'affichage n'efface plus la fenêtre.** Un `ErrorBoundary`
  montre ce qui s'est passé et propose de recharger.
- **Journal de diagnostic.** `Logs/desktop.log` dans le dossier de données
  enregistre le démarrage, les panics et un arrêt fatal — sous Windows, un
  binaire empaqueté ne laissait aucune trace exploitable.

## Démarrage des VM locales

- **Le contrôleur audio manquait.** `hda-duplex` est un codec : sans son
  contrôleur `intel-hda`, QEMU refuse de démarrer avec « No 'HDA bus' bus
  found ». Aucune VM ne pouvait démarrer avec l'audio SPICE activé.
- **Repli progressif au lancement.** Si QEMU quitte au démarrage, Virtua
  réessaie en abandonnant une fonction à la fois : forme du mot de passe SPICE,
  audio, SPICE, GPU virtio, périphériques USB, puis accélération matérielle.
  La VM démarre, et l'interface indique ce qui a été abandonné.
- **Fenêtre de vérification portée à 2,5 s.** 350 ms ne suffisaient pas :
  une VM qui mourait juste après restait « démarrée » dans l'inventaire.
- **WHPX corrigé.** Sous Windows, `-machine q35,kernel-irqchip=off` et
  `-cpu qemu64,-hypervisor` — sans quoi QEMU s'arrête dès que l'invité active
  MSI.
- **Bus disque au choix.** Les VM x86 créées depuis une ISO utilisent SATA/AHCI
  par défaut : aucun installeur grand public n'embarque de pilote virtio-blk,
  et « aucun disque trouvé » était le symptôme le plus courant. Les templates
  gardent virtio. Les VM ARM64 restent virtio (la machine `virt` n'a pas d'AHCI).
- **Clavier et souris.** Un contrôleur USB et une tablette absolue sont
  ajoutés : le curseur invité suit celui de la console.
- **Démarrage ISO non bloquant.** `-boot order=dc,menu=on` retombe sur le disque
  quand l'ISO n'est pas amorçable, au lieu d'épingler la VM sur le CD-ROM.
- **PID vérifié par identité.** Un PID recyclé par l'OS ne fait plus passer une
  VM arrêtée pour démarrée; l'arrêt forcé confirme la disparition du processus.

## Portabilité

- **QEMU Guest Agent sur les trois OS.** Le transport passe du socket Unix à un
  chardev TCP local : Windows n'a plus d'agent invité désactivé, donc plus d'IP
  invité manquante.
- **Plus de dépendance à `curl`, `tar` et `ps`.** Le dépôt de templates est lu
  par le client HTTP interne (avec délais d'attente), les archives sont
  compressées et extraites en mémoire par le client — avec refus des chemins
  qui sortent du dossier d'extraction — et les métriques de processus viennent
  de `sysinfo`, en une passe pour toutes les VM.
- **Recherche des exécutables élargie.** `ProgramW6432`, `ProgramFiles(x86)`,
  `C:\qemu`, Chocolatey, Scoop, MSYS2, plus MacPorts, Snap, Flatpak et
  `~/.local/bin`. Les suffixes `.exe`, `.cmd` et `.bat` sont testés.
- **Le `PATH` est rechargé après une installation Windows.** Un outil installé
  par winget est utilisable immédiatement, sans relancer l'application.
- **Sondes mises en cache.** L'accélérateur QEMU, la résolution des exécutables
  et le diagnostic ne sont plus recalculés à chaque rafraîchissement.
- **winget.** L'interactivité n'est plus désactivée (l'installeur doit pouvoir
  afficher son invite UAC) et « déjà installé » n'est plus traité comme un échec.
- **openSUSE** rejoint apt, dnf et pacman pour l'installation de QEMU.

## Mode local : installer ce que la fonction demande

Créer une VM, un conteneur LXC ou Docker vérifie le moteur correspondant et
propose de l'installer sur place, avec une confirmation explicite avant tout
dialogue d'élévation. L'échec renvoie le diagnostic du moteur au lieu d'un
simple renvoi vers la page Configuration.

## Mode cloud / serveur VDM

- Les **tâches serveur** (`/api/desktop/tasks`) sont affichées avec l'historique
  local, chacune étiquetée « serveur » ou « ce poste ». Seul l'historique local
  est effaçable.
- Les **snapshots** sont créés depuis le client pour une machine distante.
- Les **droits de création** viennent de `/api/desktop/me`; un utilisateur
  autorisé mais sans ressource voit enfin le bouton de création.
- `getResource` permet de rafraîchir une machine seule.
- SPICE, VNC et console texte étaient déjà couverts et le restent : la console
  graphique tente SPICE puis retombe sur VNC, y compris quand le ticket SPICE
  est émis mais que la session ne s'établit jamais.
- La gestion des appareils appairés (`/api/desktop/my-devices`, révocation,
  code d'appairage, réglage « Autoriser Virtua Desktop ») reste réservée au
  panneau web : ces routes exigent une session navigateur, pas un jeton
  Desktop. Rien à faire côté client tant que l'API ne les expose pas au jeton.

## Compilation

- `scripts/build-macos.sh` (nouveau) installe Xcode CLT, Homebrew, Node et Rust,
  et choisit la cible selon `uname -m`.
- `scripts/build-windows.ps1` recharge le `PATH` après chaque installation,
  détecte le workload MSVC via `vswhere` et vérifie les codes de retour.
- `scripts/build-linux.sh` couvre apt/dnf/zypper/pacman, avec repli WebKitGTK
  4.0 et détection d'architecture.
- Les cibles de bundle sont explicites (`app`, `dmg`, `deb`, `appimage`,
  `nsis`) : plus de RPM tenté sur une machine qui ne peut pas le produire.
- CI sur macOS ARM, macOS Intel, Windows et Ubuntu, avec `cargo fmt --check`,
  clippy, tests Rust, tests navigateur, et un job manuel qui produit les
  installeurs.
- La version affichée vient de `package.json` : plus de numéro codé en dur.

## Limites connues

- TPM 2.0 n'est pas émulé en mode local; la VM démarre en le signalant plutôt
  que d'ignorer l'option en silence.
- Secure Boot local reste dépendant du firmware fourni par l'installation QEMU.
- Windows ARM64 : pas de WHPX, donc émulation logicielle.
- Le réseau LXC reste NATé dans la VM Debian sur macOS et Windows.
- Les paquets ne sont ni signés ni notarisés.
