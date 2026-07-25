import { useTranslation } from "react-i18next";

/**
 * About page: developer credit, patch notes (since 0.1.0) and a short help
 * section. Long-form content is kept bilingual in-component and switched on the
 * active language so EN stays fully EN and FR fully FR.
 */
export default function AboutPage() {
  const { i18n } = useTranslation();
  const fr = (i18n.language ?? "EN").toUpperCase().startsWith("FR");
  const L = (en: string, frStr: string) => (fr ? frStr : en);

  const releases: Array<{ v: string; items: string[] }> = [
    {
      v: "0.7.40",
      items: fr
        ? [
            "Les consoles VDM utilisent maintenant toute la fenêtre, prennent en charge le plein écran et peuvent être détachées dans une fenêtre de navigateur redimensionnable.",
            "VDM relaie maintenant les consoles SPICE et RDP des nœuds, et le résumé VM affiche les états réels des agents QEMU Guest et SPICE ainsi que les adresses IP invité.",
          ]
        : [
            "VDM consoles now use the full window, support fullscreen, and can be detached into a resizable browser window.",
            "VDM now relays node SPICE and RDP consoles, and the VM summary shows live QEMU Guest and SPICE agent states plus guest IP addresses.",
          ],
    },
    {
      v: "0.7.39",
      items: fr
        ? [
            "VDM centralisé : correction des actions VM/LXC, des erreurs d'opération invisibles et de l'authentification des consoles graphiques VNC.",
            "Le mot de passe administrateur temporaire doit maintenant être changé clairement avant d'accéder aux fonctions de gestion.",
          ]
        : [
            "Centralized VDM: fixed VM/LXC actions, invisible operation errors, and graphical VNC console authentication.",
            "The temporary administrator password must now be changed explicitly before management features can be accessed.",
          ],
    },
    {
      v: "0.7.38",
      items: fr
        ? ["Correction du démarrage VDM sous systemd : AF_NETLINK est maintenant autorisé pour que Node.js puisse lire les interfaces réseau; le diagnostic direct charge aussi les secrets du service."]
        : ["Fixed VDM startup under systemd: AF_NETLINK is now allowed so Node.js can read network interfaces; direct diagnostics also load the service secrets."],
    },
    {
      v: "0.7.37",
      items: fr
        ? [
            "Correction du service VDM inaccessible après une installation annoncée réussie : la restriction systemd incompatible avec le JIT Node.js est retirée et l'installateur exige maintenant une réponse HTTP réelle avant de terminer.",
            "Le lancement direct de diagnostic ne peut plus être tué puis présenté comme un service opérationnel; systemd et l'accès depuis l'hôte sont tous deux validés.",
          ]
        : [
            "Fixed VDM being unreachable after an installation reported as successful: the systemd restriction incompatible with the Node.js JIT is removed and the installer now requires a real HTTP response before completing.",
            "The diagnostic direct launch can no longer be killed and then reported as an operational service; both systemd and host access are validated.",
          ],
    },
    {
      v: "0.7.36",
      items: fr
        ? [
            "Correction du démarrage VDM dans son LXC : les permissions du runtime sous `/opt/auxinux-vdm` sont maintenant normalisées pour l'utilisateur système avant le démarrage du service, avec validation d'accès explicite.",
          ]
        : [
            "Fixed VDM startup in its LXC: runtime permissions under `/opt/auxinux-vdm` are now normalized for the system user before service startup, with an explicit access check.",
          ],
    },
    {
      v: "0.7.35",
      items: fr
        ? [
            "L'installation VDM configure maintenant le réseau du LXC avant tout appel APT, attend une adresse DHCP, une route par défaut et un DNS fonctionnel, puis réessaie les opérations APT transitoires.",
            "Une installation VDM interrompue après la création du LXC peut maintenant être reprise avec la même commande `vos vdm install`.",
          ]
        : [
            "VDM installation now configures LXC networking before any APT call, waits for DHCP address, default route, and working DNS, then retries transient APT operations.",
            "A VDM installation interrupted after LXC creation can now be resumed with the same `vos vdm install` command.",
          ],
    },
    {
      v: "0.7.34",
      items: fr
        ? [
            "L'installation VDM répare maintenant automatiquement un cache d'image LXC incomplet : le cache et le conteneur partiel sont nettoyés, puis l'image Debian est retéléchargée et la création réessayée une fois.",
          ]
        : [
            "VDM installation now automatically repairs an incomplete LXC image cache: the cache and partial container are cleaned, then the Debian image is downloaded again and creation is retried once.",
          ],
    },
    {
      v: "0.7.33",
      items: fr
        ? [
            "VDM devient administrable directement avec vos/virtuaos : installation unique par cluster, mise à jour, désinstallation, statut et déplacement vers un autre nœud.",
            "Mode haute disponibilité VDM optionnel : bascule Pacemaker vers un autre nœud lorsque le nœud actif tombe, avec validation du quorum, du fencing et du stockage partagé.",
            "Le panneau VDM permet d'activer ou désactiver la haute disponibilité, et l'installateur bloque désormais toute seconde instance VDM dans le même cluster.",
          ]
        : [
            "VDM can now be managed directly with vos/virtuaos: cluster-wide unique installation, update, uninstall, status, and move to another node.",
            "Optional VDM high availability mode: Pacemaker failover to another node when the active node fails, with quorum, fencing, and shared-storage validation.",
            "The VDM panel can enable or disable high availability, and the installer now blocks any second VDM instance in the same cluster.",
          ],
    },
    {
      v: "0.7.32",
      items: fr
        ? [
            "Auto-redimensionnement SPICE sous Windows : la mémoire vidéo QXL passe de 16 à 64 Mo (16 Mo plafonnait vers 1920×1080 et bloquait le resize au-delà) et QXL devient le modèle vidéo par défaut des VM Windows — le pilote virtio-gpu Windows a une liste de modes figée que l'agent SPICE ne peut pas piloter.",
          ]
        : [
            "SPICE auto-resize on Windows: QXL video memory raised from 16 to 64 MB (16 MB capped around 1920×1080 and blocked resizing beyond) and QXL becomes the default video model for Windows VMs — the Windows virtio-gpu driver has a fixed mode list the SPICE agent cannot drive.",
          ],
    },
    {
      v: "0.7.31",
      items: fr
        ? [
            "Le Résumé de VM affiche maintenant les adresses IP de l'invité (via l'agent QEMU, le bail DHCP ou l'ARP).",
            "Nouvelle section « Agents invité » dans les Statistiques en direct : état de l'agent QEMU (canal, connexion, réponse au ping) et de l'agent SPICE (canal spicevmc, connexion) — pour voir d'un coup d'œil si la communication fonctionne.",
          ]
        : [
            "The VM Summary now shows the guest's IP addresses (via QEMU agent, DHCP lease, or ARP).",
            "New \"Guest agents\" section in Live Statistics: QEMU agent status (channel, connection, ping response) and SPICE agent status (spicevmc channel, connection) — see at a glance whether communication works.",
          ],
    },
    {
      v: "0.7.30",
      items: fr
        ? [
            "Le redimensionnement automatique de l'écran (et le presse-papiers) fonctionne maintenant dans la console SPICE : le canal de l'agent invité (spicevmc) manquait dans le matériel virtuel des VM — les guest tools étaient installés mais muets. Ajouté automatiquement à chaque VM à son prochain démarrage complet.",
          ]
        : [
            "Automatic display resizing (and clipboard) now works in the SPICE console: the guest agent channel (spicevmc) was missing from the VMs' virtual hardware — guest tools were installed but mute. Added automatically to every VM on its next full start.",
          ],
    },
    {
      v: "0.7.29",
      items: fr
        ? [
            "Une VM endormie par son système invité (veille Windows, état « pmsuspended ») est maintenant réveillée par Démarrer/Reprendre, et Arrêter la réveille d'abord pour un arrêt propre.",
            "La veille S3/S4 est désormais retirée du matériel virtuel des VM : l'invité ne peut plus endormir la machine (appliqué aux VM existantes à leur prochain démarrage complet).",
          ]
        : [
            "A VM put to sleep by its guest OS (Windows idle sleep, \"pmsuspended\" state) is now woken up by Start/Resume, and Stop wakes it first for a clean shutdown.",
            "S3/S4 sleep is now removed from the VMs' virtual hardware: the guest can no longer put the machine to sleep (applied to existing VMs on their next full start).",
          ],
    },
    {
      v: "0.7.28",
      items: fr
        ? [
            "Démarrer une VM en pause la réactive maintenant (fini le blocage « Domain is already active » où ni Start ni Stop ne répondaient).",
            "Arrêter une VM en pause fonctionne : elle est réactivée pour un arrêt propre, ou éteinte immédiatement si elle ne peut pas reprendre.",
          ]
        : [
            "Starting a paused VM now resumes it (no more \"Domain is already active\" deadlock where neither Start nor Stop responded).",
            "Stopping a paused VM works: it is resumed for a clean shutdown, or powered off immediately when it cannot resume.",
          ],
    },
    {
      v: "0.7.27",
      items: fr
        ? [
            "La souris suit maintenant parfaitement dans les consoles graphiques (noVNC et SPICE) : chaque VM reçoit une tablette USB à coordonnées absolues, appliquée automatiquement aux VM existantes à leur prochain démarrage.",
            "Nouveau bouton « Guest Tools (VirtIO) » sur la page VM : insère virtio-win.iso dans le lecteur CD, en le téléchargeant automatiquement depuis le dépôt officiel Fedora s'il est absent du stockage ISO.",
          ]
        : [
            "The mouse now tracks perfectly in the graphical consoles (noVNC and SPICE): every VM gets an absolute-coordinate USB tablet, automatically applied to existing VMs on their next start.",
            "New \"Guest Tools (VirtIO)\" button on the VM page: inserts virtio-win.iso into the CD drive, downloading it automatically from the official Fedora repository when it is missing from ISO storage.",
          ],
    },
    {
      v: "0.7.26",
      items: fr
        ? [
            "Réparation automatique des bridges réseau : le nouveau service virtua-bridge-heal réassemble au démarrage et après chaque mise à jour les bridges gérés dont l'uplink a été détaché (plus de VM/LXC coupées après un update).",
            "Sous NetworkManager, les profils de bridge AuxiNux ont maintenant priorité sur le profil par défaut de la carte, qui ne peut plus voler l'uplink au démarrage.",
            "Le garde-fou réseau (netguard) ne démonte plus un bridge sain lorsque seul l'accès Internet est en panne au démarrage.",
            "La suppression d'une VM avec « effacer les disques » supprime réellement les fichiers de disque, et ne touche jamais aux ISO partagées.",
            "Le bus de disque suit maintenant le type d'OS choisi à la création d'une VM (Windows → SATA, Linux → VirtIO).",
          ]
        : [
            "Automatic network bridge repair: the new virtua-bridge-heal service reassembles managed bridges whose uplink was detached, at boot and after every update (no more VMs/LXC cut off after an update).",
            "Under NetworkManager, AuxiNux bridge profiles now take priority over the NIC's default profile, which can no longer steal the uplink at boot.",
            "The network watchdog (netguard) no longer tears down a healthy bridge when only Internet access is down at boot.",
            "Deleting a VM with \"delete disks\" checked now really removes the disk files, and never touches shared ISOs.",
            "The disk bus now follows the OS type selected at VM creation (Windows → SATA, Linux → VirtIO).",
          ],
    },
    {
      v: "0.7.25",
      items: fr
        ? [
            "Les canaux SPICE peuvent maintenant réutiliser leur ticket WebSocket afin que l'affichage, les entrées, le curseur et le son se connectent correctement.",
            "Les mises à jour de configuration QEMU conservent les mots de passe VNC et SPICE, et la gestion Secure Boot utilise maintenant un firmware OVMF adapté avec ses variables NVRAM.",
          ]
        : [
            "SPICE channels can now reuse their WebSocket ticket so display, input, cursor, and audio channels connect correctly.",
            "QEMU configuration updates now preserve VNC and SPICE passwords, and Secure Boot uses an appropriate OVMF firmware with its NVRAM variables.",
          ],
    },
    {
      v: "0.7.24",
      items: fr
        ? [
            "Les commandes SPICE Activer le son et Ctrl+Alt+Suppr sont maintenant placées dans la barre d'interface de la console plutôt que par-dessus l'écran de la VM.",
          ]
        : [
            "The SPICE Enable sound and Ctrl+Alt+Delete commands now live in the console interface toolbar instead of overlaying the VM display.",
          ],
    },
    {
      v: "0.7.23",
      items: fr
        ? [
            "Le bouton d'activation du son SPICE disparaît maintenant dès que la lecture audio fonctionne et reste affiché uniquement lorsque l'autoplay doit être débloqué.",
          ]
        : [
            "The SPICE sound activation button now disappears once audio playback works and remains visible only when autoplay must be unlocked.",
          ],
    },
    {
      v: "0.7.22",
      items: fr
        ? [
            "Le son SPICE utilise maintenant un décodeur Opus WebAssembly et Web Audio sur Safari, contournant le chemin MediaSource WebM silencieux malgré un périphérique audio fonctionnel dans la VM.",
          ]
        : [
            "SPICE sound now uses a WebAssembly Opus decoder and Web Audio on Safari, bypassing the silent WebM MediaSource path when the VM audio device is working.",
          ],
    },
    {
      v: "0.7.21",
      items: fr
        ? [
            "Correctif son SPICE web : QEMU force maintenant la compression playback Opus, seul mode audio pris en charge par le client navigateur.",
          ]
        : [
            "Web SPICE sound fix: QEMU now forces Opus playback compression, the only audio mode supported by the browser client.",
          ],
    },
    {
      v: "0.7.20",
      items: fr
        ? [
            "Correctif curseur : SPICE convertit maintenant les coordonnées de souris du canvas redimensionné vers la résolution native de la VM.",
            "Les consoles Graphique et SPICE masquent le curseur local superposé afin de ne conserver que le curseur de la VM.",
          ]
        : [
            "Cursor fix: SPICE now converts pointer coordinates from the scaled canvas to the VM's native resolution.",
            "Graphical and SPICE consoles hide the overlaid local cursor so only the VM cursor remains visible.",
          ],
    },
    {
      v: "0.7.19",
      items: fr
        ? [
            "Correctif SPICE audio : la comparaison du périphérique audio est maintenant indépendante du formatage XML de libvirt, supprimant la fausse demande de redémarrage répétée.",
          ]
        : [
            "SPICE audio fix: audio-device comparison is now independent of libvirt XML formatting, removing the repeated false restart requirement.",
          ],
    },
    {
      v: "0.7.18",
      items: fr
        ? [
            "SPICE fournit maintenant un périphérique audio ICH9 relié au backend audio SPICE de QEMU, avec lecture Opus et activation du son dans le navigateur.",
            "Le redimensionnement de la console est activé pour noVNC et SPICE; SPICE transmet la nouvelle géométrie à l'agent invité.",
            "RDP Remote désactive la compression bitmap et RDP pour éviter les déconnexions 0x407, tout en conservant la mise à l'échelle intelligente du framebuffer VNC.",
          ]
        : [
            "SPICE now provides an ICH9 audio device connected to QEMU's SPICE audio backend, with Opus playback and browser sound activation.",
            "Console resizing is enabled for noVNC and SPICE; SPICE forwards the new geometry to the guest agent.",
            "RDP Remote disables bitmap and RDP compression to prevent 0x407 disconnects while retaining smart scaling of the VNC framebuffer.",
          ],
    },
    {
      v: "0.7.17",
      items: fr
        ? [
            "La console SPICE web s'ajuste maintenant à son conteneur et prend en charge le plein écran ainsi que la fenêtre détachée.",
            "La vue Console permet de choisir Graphique ou SPICE, et le retour de SPICE vers Graphique ne provoque plus d'erreur de démontage du canvas.",
            "RDP Remote fournit directement le secret VNC à la passerelle xrdp afin d'éviter les échecs d'authentification causés par certains clients RDP.",
          ]
        : [
            "The web SPICE console now fits its container and supports fullscreen and detached-window modes.",
            "The Console view can switch between Graphical and SPICE, and returning from SPICE no longer triggers a canvas teardown error.",
            "RDP Remote now supplies the VNC secret directly to the xrdp gateway, avoiding authentication failures caused by some RDP clients.",
          ],
    },
    {
      v: "0.7.16",
      items: fr
        ? [
            "Publication des derniers correctifs locaux dans le paquet AuxiNux Virtua et le dépôt APT.",
          ]
        : [
            "Published the latest local fixes in the AuxiNux Virtua package and APT repository.",
          ],
    },
    {
      v: "0.7.15",
      items: fr
        ? [
            "Publication des derniers correctifs locaux dans le paquet AuxiNux Virtua et le dépôt APT.",
          ]
        : [
            "Published the latest local fixes in the AuxiNux Virtua package and APT repository.",
          ],
    },
    {
      v: "0.7.14",
      items: fr
        ? [
            "Publication du paquet AuxiNux Virtua avec les derniers correctifs locaux et métadonnées de version alignées pour le dépôt APT.",
          ]
        : [
            "Published the AuxiNux Virtua package with the latest local fixes and aligned version metadata for the APT repository.",
          ],
    },
    {
      v: "0.7.13",
      items: fr
        ? [
            "Correctif SPICE web : le proxy WebSocket conserve maintenant les premiers messages envoyés immédiatement à l'ouverture, ce qui évite le timeout de connexion du client SPICE.",
            "Le même tampon est appliqué au relais SPICE local et distant afin que la poignée de main soit transmise même pendant la préparation du runner ou du nœud distant.",
          ]
        : [
            "SPICE web fix: the WebSocket proxy now preserves the first messages sent immediately after opening, avoiding the SPICE client connection timeout.",
            "The same buffer is used for local and remote SPICE relays so the handshake is forwarded while the runner or remote node is being prepared.",
          ],
    },
    {
      v: "0.7.12",
      items: fr
        ? [
            "Les mots de passe console VNC et SPICE sont maintenant lus avec les informations de sécurité libvirt, ce qui les garde stables entre les tickets et évite les expirations SPICE.",
            "Les modifications XML VNC/SPICE concurrentes sont sérialisées par VM afin d'éviter qu'une définition libvirt écrase silencieusement l'autre.",
            "RDP conserve le redimensionnement xrdp côté serveur pour supporter les changements de résolution initiés par l'invité sans SIGSEGV en cours de session.",
          ]
        : [
            "VNC and SPICE console passwords are now read with libvirt security information, keeping them stable across tickets and avoiding SPICE timeouts.",
            "Concurrent VNC/SPICE XML updates are serialized per VM so one libvirt definition cannot silently overwrite another.",
            "RDP keeps xrdp server-side resizing enabled to support guest-initiated resolution changes without a mid-session SIGSEGV.",
          ],
    },
    {
      v: "0.7.11",
      items: fr
        ? [
            "RDP Remote détecte maintenant la résolution réelle de la console QEMU et l'inscrit dans le fichier `.rdp`, évitant le crash xrdp provoqué par un redimensionnement client/serveur.",
            "Nouvelle console SPICE directement dans le navigateur avec mise à l'échelle, son SPICE natif, mot de passe transparent et commande Ctrl+Alt+Suppr.",
            "La première activation SPICE sur une VM en marche indique correctement qu'un redémarrage est requis au lieu d'échouer pendant l'application du mot de passe.",
          ]
        : [
            "RDP Remote now detects the actual QEMU console resolution and writes it into the `.rdp` file, avoiding the xrdp crash caused by client/server resizing.",
            "New in-browser SPICE console with scaling, native SPICE audio, transparent password handling, and a Ctrl+Alt+Delete command.",
            "First-time SPICE activation on a running VM now correctly reports that a restart is required instead of failing while applying the password.",
          ],
    },
    {
      v: "0.7.10",
      items: fr
        ? [
            "Correctif RDP Remote : les passerelles xrdp configurées avec `security_layer=tls` déclarent maintenant explicitement `TLSv1.2` et `TLSv1.3`.",
            "Cette correction rétablit la négociation TLS et élimine l'échec immédiat de connexion RDP `0x204`.",
          ]
        : [
            "RDP Remote fix: xrdp gateways configured with `security_layer=tls` now explicitly enable `TLSv1.2` and `TLSv1.3`.",
            "This restores TLS negotiation and eliminates the immediate RDP connection failure `0x204`.",
          ],
    },
    {
      v: "0.7.9",
      items: fr
        ? [
            "Correctif de mise à jour pour npm 12 : l'installateur n'utilise plus le drapeau supprimé `--build-from-source` pendant la reconstruction des modules natifs.",
            "Les scripts d'installation vérifiés de `argon2`, `better-sqlite3`, `node-pty` et `esbuild` sont maintenant approuvés explicitement et épinglés par version.",
          ]
        : [
            "npm 12 update fix: the installer no longer uses the removed `--build-from-source` flag while rebuilding native modules.",
            "The reviewed install scripts for `argon2`, `better-sqlite3`, `node-pty`, and `esbuild` are now explicitly approved and pinned by version.",
          ],
    },
    {
      v: "0.7.8",
      items: fr
        ? [
            "Correctif RDP Remote : la passerelle xrdp rejoint maintenant QEMU par l'adresse IPv4-mappée `::ffff:127.0.0.1`, évitant la réécriture xrdp vers `::1` et les refus de connexion VNC.",
            "Le redimensionnement dynamique est désactivé entre xrdp et QEMU afin d'éliminer la boucle de resize qui figeait l'image; le fichier `.rdp` utilise maintenant une fenêtre avec mise à l'échelle intelligente.",
            "La passerelle force TLS et désactive la compression bulk MPPC pour réduire les déconnexions `data encryption error 0x407`.",
          ]
        : [
            "RDP Remote fix: the xrdp gateway now reaches QEMU through the IPv4-mapped `::ffff:127.0.0.1` address, avoiding xrdp's rewrite to `::1` and VNC connection refusals.",
            "Dynamic resizing is disabled between xrdp and QEMU to eliminate the resize loop that froze the display; the `.rdp` file now uses a window with smart sizing.",
            "The gateway enforces TLS and disables bulk MPPC compression to reduce `data encryption error 0x407` disconnects.",
          ],
    },
    {
      v: "0.7.7",
      items: fr
        ? [
            "RDP Remote utilise maintenant une passerelle xrdp dédiée par VM sur un port persistant, sans modifier ni redémarrer le service xrdp système partagé.",
            "Le profil RDP demande le mot de passe console propre à la VM avant d'ouvrir sa console QEMU/VNC; le secret est affiché uniquement après `Prepare RDP profile` aux utilisateurs autorisés.",
            "La passerelle est resynchronisée au redémarrage de la VM et nettoyée lors de sa suppression ou de son renommage.",
          ]
        : [
            "RDP Remote now uses a dedicated xrdp gateway per VM on a persistent port, without modifying or restarting the shared system xrdp service.",
            "The RDP profile requests the VM-specific console password before opening its QEMU/VNC console; the secret is shown only after `Prepare RDP profile` to authorized users.",
            "The gateway is resynchronized when the VM restarts and cleaned up when the VM is deleted or renamed.",
          ],
    },
    {
      v: "0.7.6",
      items: fr
        ? [
            "Correctif RDP Remote : le fichier `.rdp` sélectionne maintenant directement la section xrdp de la VM via le champ `domain`, ce qui évite l'écran de choix de session xrdp dans les clients compatibles.",
            "Virtua détecte maintenant les profils xrdp obsolètes quand QEMU change de port VNC après un redémarrage et demande de relancer `Prepare RDP profile` au lieu de télécharger un `.rdp` cassé.",
          ]
        : [
            "RDP Remote fix: the `.rdp` file now directly selects the VM xrdp section through the `domain` field, avoiding the xrdp session picker on compatible clients.",
            "Virtua now detects stale xrdp profiles when QEMU changes VNC port after a restart and asks to run `Prepare RDP profile` again instead of downloading a broken `.rdp`.",
          ],
    },
    {
      v: "0.7.5",
      items: fr
        ? [
            "Correctif RDP Remote : Virtua lit maintenant l'auth VNC live de QEMU (`query-vnc`) avant d'écrire le profil xrdp.",
            "Si QEMU annonce `auth:none`, le profil xrdp est généré sans mot de passe VNC, ce qui évite l'échec `VNC error 1 after security negotiation` observé avec `libvnc.so`.",
          ]
        : [
            "RDP Remote fix: Virtua now reads QEMU's live VNC auth (`query-vnc`) before writing the xrdp profile.",
            "When QEMU reports `auth:none`, the xrdp profile is generated without a VNC password, avoiding the `VNC error 1 after security negotiation` failure seen with `libvnc.so`.",
          ],
    },
    {
      v: "0.7.4",
      items: fr
        ? [
            "Correctif RDP Remote : Virtua applique maintenant le mot de passe VNC en live via QMP (`set_password` + `expire_password never`) avec fallback HMP, pour que QEMU utilise réellement le même secret que le profil xrdp.",
            "Après mise à jour, le bouton Prepare RDP profile régénère un profil cohérent entre libvirt, QEMU et xrdp.",
          ]
        : [
            "RDP Remote fix: Virtua now applies the VNC password live through QMP (`set_password` + `expire_password never`) with an HMP fallback, so QEMU actually uses the same secret as the xrdp profile.",
            "After upgrading, Prepare RDP profile regenerates a consistent profile across libvirt, QEMU, and xrdp.",
          ],
    },
    {
      v: "0.7.3",
      items: fr
        ? [
            "Correctif console : le mot de passe VNC interne généré pour RDP Remote respecte maintenant la limite libvirt/QEMU de 8 caractères, ce qui répare la console Graphical/noVNC cassée par `unsupported configuration: VNC password is 24 characters long`.",
            "Le panneau RDP Remote affiche maintenant clairement les erreurs de préparation/téléchargement au lieu de donner l'impression que le bouton ne fait rien.",
          ]
        : [
            "Console fix: the internal VNC password generated for RDP Remote now respects libvirt/QEMU's 8-character limit, fixing Graphical/noVNC failures with `unsupported configuration: VNC password is 24 characters long`.",
            "The RDP Remote panel now clearly displays prepare/download errors instead of making the button look inactive.",
          ],
    },
    {
      v: "0.7.2",
      items: fr
        ? [
            "Correctif RDP Remote : Virtua protège maintenant la console VNC QEMU avec un mot de passe interne par VM lors de la préparation RDP, puis injecte ce mot de passe dans le profil xrdp.",
            "La console web noVNC reçoit le même mot de passe via son ticket console authentifié, afin de continuer à fonctionner après l'activation du mode RDP Remote.",
          ]
        : [
            "RDP Remote fix: Virtua now protects the QEMU VNC console with an internal per-VM password during RDP preparation, then injects that password into the xrdp profile.",
            "The web noVNC console receives the same password through its authenticated console ticket, so it keeps working after RDP Remote is enabled.",
          ],
    },
    {
      v: "0.7.1",
      items: fr
        ? [
            "Correctif RDP Remote : les profils xrdp écrivent maintenant un nom de module valide (`libxrdp-vnc.so` ou `libvnc.so`) au lieu d'un chemin absolu refusé par xrdp.",
            "Le bouton Prepare RDP profile crée aussi une règle firewall Virtua liée à la VM pour le port xrdp, et l'installateur ouvre `3389/tcp` pour les firewalls système simples.",
          ]
        : [
            "RDP Remote fix: xrdp profiles now write a valid module name (`libxrdp-vnc.so` or `libvnc.so`) instead of an absolute path rejected by xrdp.",
            "Prepare RDP profile also creates a VM-linked Virtua firewall rule for the xrdp port, and the installer opens `3389/tcp` for simple host firewalls.",
          ],
    },
    {
      v: "0.7.0",
      items: fr
        ? [
            "Console majeure : les consoles texte LXC/Docker restent en xterm.js, les consoles graphiques web VM restent en noVNC, et les VM gagnent un mode RDP Remote.",
            "RDP Remote prépare un profil xrdp côté host vers la console QEMU/VNC de la VM et télécharge un fichier `.rdp`, sans serveur RDP à installer dans l'invité.",
            "Le panneau RDP vérifie les prérequis du host (`xrdp`, module VNC, service actif, VM en marche) et affiche les limites clairement.",
          ]
        : [
            "Major console update: LXC/Docker text consoles stay on xterm.js, VM web graphics stay on noVNC, and VMs gain an RDP Remote mode.",
            "RDP Remote prepares a host-side xrdp profile to the VM's QEMU/VNC console and downloads an `.rdp` file, without installing an RDP server in the guest.",
            "The RDP panel checks host prerequisites (`xrdp`, VNC module, active service, running VM) and surfaces limitations clearly.",
          ],
    },
    {
      v: "0.6.27",
      items: fr
        ? [
            "LXC GPU partagé : ajout de la détection des GPU du host et d'un panneau d'attache/détache dans l'onglet Resources des conteneurs.",
            "Support initial de /dev/dri pour Intel/AMD et de /dev/nvidia* pour NVIDIA, utile pour Ollama et les workloads GPU en conteneur.",
          ]
        : [
            "Shared LXC GPU: added host GPU detection plus an attach/detach panel in the container Resources tab.",
            "Initial support for /dev/dri on Intel/AMD and /dev/nvidia* on NVIDIA, useful for Ollama and GPU workloads in containers.",
          ],
    },
    {
      v: "0.6.26",
      items: fr
        ? [
            "Sécurité LXC : correction d'une faille où certaines écritures dans le rootfs pouvaient suivre des symlinks contrôlés par le conteneur.",
            "Les mises à jour hostname, DNS, réseau et sources APT des LXC passent maintenant par des helpers anti-symlink, avec validation stricte des serveurs DNS.",
          ]
        : [
            "LXC security: fixed a flaw where some rootfs writes could follow symlinks controlled by the container.",
            "LXC hostname, DNS, network, and APT source updates now use anti-symlink helpers, with strict DNS server validation.",
          ],
    },
    {
      v: "0.6.25",
      items: fr
        ? [
            "Interface : ajout du bouton Renommer sur les pages détail VM et LXC.",
            "Le renommage met à jour le nom réel de la VM/LXC ainsi que les ACL, snapshots, backups et règles firewall liées.",
          ]
        : [
            "Interface: added a Rename button on VM and LXC detail pages.",
            "Renaming updates the real VM/LXC name plus linked ACLs, snapshots, backups, and firewall rules.",
          ],
    },
    {
      v: "0.6.24",
      items: fr
        ? [
            "LXC : le hostname interne du conteneur est maintenant synchronisé avec le nom choisi à la création, au restore et au renommage.",
            "Les fichiers `/etc/hostname` et `/etc/hosts` du rootfs ne restent plus bloqués à la valeur générique `lxcname` des templates.",
          ]
        : [
            "LXC: the container's internal hostname is now synchronized with the chosen name on create, restore, and rename.",
            "The rootfs `/etc/hostname` and `/etc/hosts` files no longer stay stuck on the template's generic `lxcname` value.",
          ],
    },
    {
      v: "0.6.23",
      items: fr
        ? [
            "Bridge réseau : correction de la création persistante via NetworkManager qui échouait avec `bridge.forward-delay value '0' is out of range`.",
            "Virtua ne force plus `bridge.forward-delay=0` dans `nmcli`; NetworkManager conserve sa valeur valide par défaut selon l’état STP.",
          ]
        : [
            "Network bridge: fixed persistent bridge creation through NetworkManager failing with `bridge.forward-delay value '0' is out of range`.",
            "Virtua no longer forces `bridge.forward-delay=0` in `nmcli`; NetworkManager keeps its valid default value based on STP state.",
          ],
    },
    {
      v: "0.6.22",
      items: fr
        ? [
            "Bridge réseau : correction du rollback automatique quand un bridge avec uplink physique est créé en IPv4 statique sans gateway saisie.",
            "En mode Static IPv4 + Physical Uplink, Virtua réutilise maintenant automatiquement la gateway actuelle de l’uplink avant de déplacer l’IP sur le bridge.",
            "L’interface précise que la gateway peut rester vide dans ce cas; si aucune gateway n’est fournie ni détectable, une erreur claire est affichée.",
          ]
        : [
            "Network bridge: fixed automatic rollback when creating a bridge with a physical uplink in static IPv4 mode without entering a gateway.",
            "In Static IPv4 + Physical Uplink mode, Virtua now automatically reuses the uplink's current gateway before moving the IP onto the bridge.",
            "The UI now explains that the gateway may be left empty in this case; if no gateway is provided or detectable, a clear error is shown.",
          ],
    },
    {
      v: "0.6.21",
      items: fr
        ? [
            "USB persistant : les imprimantes USB passées à une VM ou un LXC ne dépendent plus du Bus/Device volatile après redémarrage ou rebranchement.",
            "CUPS en LXC : le montage USB persistant expose `/dev/bus/usb`, ce qui évite de devoir rattacher l’imprimante quand son adresse USB change.",
            "Paramètres SSH : nouveau panneau Accès SSH avec modes clé uniquement, clé + login/mot de passe ou login/mot de passe uniquement, génération de clé administrateur et téléchargement de la clé privée.",
          ]
        : [
            "Persistent USB: USB printers passed through to a VM or LXC no longer depend on the volatile Bus/Device address after reboot or replug.",
            "CUPS in LXC: persistent USB mounting exposes `/dev/bus/usb`, avoiding manual re-attach when the printer USB address changes.",
            "SSH settings: new SSH Access panel with key-only, key + password login, or password-only login modes, admin key generation, and private-key download.",
          ],
    },
    {
      v: "0.6.20",
      items: fr
        ? [
            "Périphériques USB host : ajout de la détection USB et de l'attache/détache vers VM QEMU/libvirt et conteneurs LXC.",
            "Cas imprimante/CUPS : un LXC peut recevoir une imprimante USB du host via `/dev/bus/usb`, avec affichage des périphériques déjà assignés.",
          ]
        : [
            "Host USB devices: added USB discovery plus attach/detach actions for QEMU/libvirt VMs and LXC containers.",
            "Printer/CUPS workflow: an LXC can receive a host USB printer through `/dev/bus/usb`, with attached-device status shown in the UI.",
          ],
    },
    {
      v: "0.6.19",
      items: fr
        ? [
            "Boot UEFI : correction du boot primaire sur les VM dont le XML libvirt utilise `<os firmware='efi'>`; le choix CD-ROM/ISO est maintenant réellement écrit et relu après refresh.",
            "Correction post-déploiement : les VM UEFI déjà existantes peuvent maintenant passer de `hd` à `cdrom` via l'édition des ressources ou l'insertion ISO.",
          ]
        : [
            "UEFI boot: fixed primary boot updates for VMs whose libvirt XML uses `<os firmware='efi'>`; CD-ROM/ISO selection is now actually written and read back after refresh.",
            "Post-deploy fix: existing UEFI VMs can now switch from `hd` to `cdrom` through resource edit or ISO insertion.",
          ],
    },
    {
      v: "0.6.18",
      items: fr
        ? [
            "Boot ISO : correction de l'écriture persistante du périphérique de démarrage; le choix manuel CD-ROM/ISO est maintenant appliqué sur le XML libvirt inactif relu après refresh.",
            "Attache ISO : les nouveaux lecteurs CD-ROM utilisent maintenant un target SATA libre au lieu de forcer `sda`, ce qui évite les conflits et les états ambigus avec les disques existants.",
          ]
        : [
            "ISO boot: fixed persistent boot-device writes; manual CD-ROM/ISO selection is now applied to the inactive libvirt XML that the UI reads after refresh.",
            "ISO attach: new CD-ROM devices now use a free SATA target instead of forcing `sda`, avoiding conflicts and ambiguous states with existing disks.",
          ],
    },
    {
      v: "0.6.17",
      items: fr
        ? [
            "Disques VM : l'ajout d'un disque existant liste maintenant seulement les disques VM disponibles et non attachés, avec résolution serveur par pool.",
            "Boot ISO : insérer un ISO force maintenant le démarrage primaire sur CD-ROM/ISO et l'affichage lit la configuration persistante pour respecter les changements manuels après refresh.",
          ]
        : [
            "VM disks: attaching an existing disk now lists only available, unattached VM disks, resolved server-side by storage pool.",
            "ISO boot: inserting an ISO now sets CD-ROM/ISO as the primary boot device, and the UI reads persistent configuration so manual boot changes survive refresh.",
          ],
    },
    {
      v: "0.6.16",
      items: fr
        ? [
            "Création et destruction de VM : possibilité d'attacher un disque existant à la création, de choisir l'effacement du disque lors de la suppression et de sélectionner un disque existant dans l'ajout de matériel.",
            "Topologie CPU et workflow de boot : correction du suivi du périphérique de boot pour éviter les valeurs visuellement figées après refresh.",
          ]
        : [
            "VM create/delete workflow: you can now attach an existing disk during creation, choose whether to delete the disk when removing a VM, and attach an existing disk from hardware edit.",
            "CPU topology and boot workflow: fixed boot device tracking so the UI no longer appears stuck after a refresh.",
          ],
    },
    {
      v: "0.6.15",
      items: fr
        ? [
            "Correctif paquet Debian : le post-installation installe maintenant le placeholder `virtua` dans `/usr/bin/virtua` et ne crée `/usr/local/bin/virtua` qu'en best-effort, évitant l'échec `Aucun fichier ou dossier de ce nom` sur des images minimales.",
            "Le paquet peut maintenant terminer sa configuration et lancer le provisioning Virtua en arrière-plan sur VirtuaOS/Debian 13.",
          ]
        : [
            "Debian package fix: post-install now installs the `virtua` placeholder in `/usr/bin/virtua` and creates `/usr/local/bin/virtua` only as best-effort, avoiding `No such file or directory` failures on minimal images.",
            "The package can now finish configuration and start Virtua provisioning in the background on VirtuaOS/Debian 13.",
          ],
    },
    {
      v: "0.6.14",
      items: fr
        ? [
            "Correctif login/CSRF : les cookies de session utilisent maintenant le mode secure automatique, ce qui évite l'erreur `Missing csrf secret` sur le port HTTP local `:8441` quand HTTPS est aussi disponible.",
            "Le paramètre `AUXINUX_SECURE_COOKIE=1|0` reste disponible pour forcer explicitement le comportement en production ou derrière un proxy.",
          ]
        : [
            "Login/CSRF fix: session cookies now use automatic secure mode, avoiding `Missing csrf secret` on the local HTTP `:8441` port when HTTPS is also available.",
            "`AUXINUX_SECURE_COOKIE=1|0` remains available to explicitly force the behavior in production or behind a proxy.",
          ],
    },
    {
      v: "0.6.13",
      items: fr
        ? [
            "Audit de sécurité : correction d'un risque critique d'attachement ISO par chemin serveur arbitraire et activation réelle de la protection CSRF sur les routes mutantes.",
            "Robustesse CLI : `virtua <type> autostart <id>` sans argument affiche maintenant le statut au lieu d'activer l'autostart par défaut.",
            "Performance VM : activation des IOThreads pour disques virtio-blk et du multiqueue virtio-net afin d'améliorer les performances disque/réseau des VM.",
          ]
        : [
            "Security audit: fixed a critical arbitrary server-path ISO attachment risk and enabled actual CSRF protection on mutating routes.",
            "CLI robustness: `virtua <type> autostart <id>` without an argument now shows status instead of enabling autostart by default.",
            "VM performance: enabled IOThreads for virtio-blk disks and virtio-net multiqueue to improve VM disk/network throughput.",
          ],
    },
    {
      v: "0.6.12",
      items: fr
        ? [
            "Virtua CLI : `autostart` est maintenant disponible pour `vm`, `lxc` et `docker` avec la forme `virtua <type> autostart <id> [on|off|status]`.",
            "`virtua gui` reste dans l'interface `dialog` après les actions simples et affiche les résultats dans une boîte de message au lieu de retomber sur l'écran terminal.",
            "Docker mappe Autostart sur la restart policy Docker (`unless-stopped` quand activé, `no` quand désactivé).",
          ]
        : [
            "Virtua CLI: `autostart` is now available for `vm`, `lxc`, and `docker` as `virtua <type> autostart <id> [on|off|status]`.",
            "`virtua gui` stays inside the `dialog` interface after simple actions and shows results in a message box instead of dropping back to the terminal screen.",
            "Docker maps Autostart to the Docker restart policy (`unless-stopped` when enabled, `no` when disabled).",
          ],
    },
    {
      v: "0.6.11",
      items: fr
        ? [
            "Virtua CLI : ajout de `virtua vm autostart <nom> [on|off|status]` pour gérer le démarrage automatique sans passer par `virsh`.",
            "`virtua gui` est maintenant branché sur une interface terminal `dialog` minimale pour consulter l'état, lister les ressources et lancer les actions courantes.",
          ]
        : [
            "Virtua CLI: added `virtua vm autostart <name> [on|off|status]` to manage VM autostart without using `virsh` directly.",
            "`virtua gui` is now wired to a minimal `dialog` terminal UI for status, resource listing, and common actions.",
          ],
    },
    {
      v: "0.6.10",
      items: fr
        ? [
            "VM : l'option Autostart peut maintenant être modifiée après création depuis la fenêtre Edit Resources.",
            "Le changement applique directement `virsh autostart` ou `virsh autostart --disable` via le serveur Virtua existant.",
          ]
        : [
            "VM: Autostart can now be changed after creation from the Edit Resources dialog.",
            "The change applies `virsh autostart` or `virsh autostart --disable` through the existing Virtua server path.",
          ],
    },
    {
      v: "0.6.9",
      items: fr
        ? [
            "Correctif performance VM : Virtua force maintenant une topologie CPU libvirt cohérente `1 socket, N cores, 1 thread` au lieu de laisser QEMU/libvirt exposer une topologie socket/core ambiguë.",
            "Les VM créées, importées ou restaurées utilisent `host-passthrough` avec une topologie alignée sur le nombre de vCPU choisi.",
            "Changer le nombre de vCPU dans la configuration réécrit aussi la topologie CPU pour éviter les configurations héritées sous-optimales.",
          ]
        : [
            "VM performance fix: Virtua now forces a coherent libvirt CPU topology `1 socket, N cores, 1 thread` instead of leaving QEMU/libvirt to expose an ambiguous socket/core layout.",
            "Created, imported, or restored VMs use `host-passthrough` with a topology aligned to the selected vCPU count.",
            "Changing the vCPU count in VM configuration also rewrites CPU topology to avoid suboptimal legacy layouts.",
          ],
    },
    {
      v: "0.6.8",
      items: fr
        ? [
            "Correctif libvirt : les disques VM et ISO gérés par Virtua sont maintenant accessibles par le processus QEMU/libvirt.",
            "Les pools de stockage héritent du groupe `libvirt-qemu` quand disponible; les qcow2 et les ISO sont normalisés en permissions sûres pour éviter `Permission non accordée` au démarrage.",
            "L'install/upgrade répare aussi les permissions et les règles AppArmor libvirt pour `/var/lib/auxinuxvirtual/pools`, ainsi que les dossiers ISO `/var/lib/libvirt/images/isos`.",
          ]
        : [
            "Libvirt fix: VM disks and ISO media managed by Virtua are now accessible to the QEMU/libvirt process.",
            "Storage pools inherit the `libvirt-qemu` group when available; qcow2 files and ISOs are normalized with safe permissions to avoid `Permission denied` on VM start.",
            "Install/upgrade also repairs permissions and libvirt AppArmor rules for `/var/lib/auxinuxvirtual/pools`, plus ISO folders under `/var/lib/libvirt/images/isos`.",
          ],
    },
    {
      v: "0.6.7",
      items: fr
        ? [
            "Support serveur SPICE pour Desktop NG : nouveau ticket `/api/desktop/resources/:id/console/spice-ticket` et WebSocket public `/api/ws/spice`.",
            "Les VM créées ou importées reçoivent maintenant une console SPICE libvirt liée à `127.0.0.1`, avec VNC conservé en fallback.",
            "Transport SPICE expérimental : Virtua relaie le socket QEMU via WebSocket authentifié, sans clipboard/USB/audio/resize avancé pour l'instant.",
          ]
        : [
            "Server-side SPICE support for Desktop NG: new `/api/desktop/resources/:id/console/spice-ticket` ticket and public `/api/ws/spice` WebSocket.",
            "Created or imported VMs now receive a libvirt SPICE console bound to `127.0.0.1`, while VNC remains available as fallback.",
            "Experimental SPICE transport: Virtua relays the QEMU socket through an authenticated WebSocket, without clipboard/USB/audio/advanced resize yet.",
          ],
    },
    {
      v: "0.6.6",
      items: fr
        ? [
            "Correctif console Desktop NG : les WebSockets `/api/ws/term` et `/api/ws/vnc` sont maintenant relayés aussi sur le listener HTTPS public.",
            "Diagnostic plus clair : un accès HTTP normal aux endpoints WebSocket retourne `426 Upgrade Required` au lieu d'un 404 ambigu.",
            "Documentation ajoutée pour vérifier le reverse proxy WebSocket et les en-têtes `Upgrade` / `Connection`.",
          ]
        : [
            "Desktop NG console fix: `/api/ws/term` and `/api/ws/vnc` WebSockets are now forwarded on the public HTTPS listener too.",
            "Clearer diagnostics: a plain HTTP request to WebSocket endpoints now returns `426 Upgrade Required` instead of an ambiguous 404.",
            "Documentation added for checking WebSocket reverse proxy forwarding and `Upgrade` / `Connection` headers.",
          ],
    },
    {
      v: "0.6.5",
      items: fr
        ? [
            "Alignement de l'API Desktop serveur avec le nouveau client Rust NG.",
            "Tickets console Desktop renforcés : contexte utilisateur, appareil, ressource et mode conservé côté serveur.",
            "URLs WebSocket Desktop sécurisées : refus des liens localhost non joignables sans `AUXINUX_PUBLIC_HOST`.",
            "Validation confirmée côté serveur avant toute ouverture VM, LXC ou Docker depuis le client desktop.",
          ]
        : [
            "Server Desktop API aligned with the new Rust NG client.",
            "Hardened Desktop console tickets: user, device, resource and mode context kept server-side.",
            "Safer Desktop WebSocket URLs: localhost links are rejected unless `AUXINUX_PUBLIC_HOST` is configured.",
            "Server-side validation confirmed before opening any VM, LXC or Docker from the desktop client.",
          ],
    },
    {
      v: "0.6.4",
      items: fr
        ? [
            "Correctif création VM : évite le conflit de périphérique SDA quand un disque SATA et un ISO/CD-ROM sont utilisés ensemble.",
            "Sélection du bridge réseau corrigée : la liste des bridges est disponible sans dépendre de l'activation de la section Réseau.",
            "Stabilisation post-déploiement de la création VM avec disque, ISO et choix du bus.",
          ]
        : [
            "VM creation fix: avoids the SDA device conflict when a SATA disk and an ISO/CD-ROM are used together.",
            "Network bridge selection fixed: the bridge list is available without depending on the Network section being enabled.",
            "Post-deploy stabilization for VM creation with disk, ISO and bus selection.",
          ],
    },
    {
      v: "0.6.3",
      items: fr
        ? [
            "Téléchargement admin des templates depuis la page Templates.",
            "Export/partage de template VM plus complet : le téléchargement VM inclut l'archive .tar.gz et son JSON sidecar.",
            "Correctifs VM hardware : switch UEFI/BIOS, détachement disque, ajout disque, disque optionnel et choix du bus disque.",
            "Modernisation visuelle UI/CLI : Mode Simple, animations et rendu CLI plus lisible.",
          ]
        : [
            "Admin template downloads from the Templates page.",
            "More complete VM template export/sharing: VM downloads include the .tar.gz archive and its JSON sidecar.",
            "VM hardware fixes: UEFI/BIOS switch, disk detach, disk attach, optional disk and disk bus selection.",
            "UI/CLI visual modernization: Simple Mode, animations and a clearer CLI output.",
          ],
    },
    {
      v: "0.6.2",
      items: fr
        ? [
            "Vue Stockage dans la barre latérale : affiche maintenant les pools, les ISO/Templates et la section Templates.",
            "Clonage de VM directement depuis la page de détail (bouton Copier).",
            "Export d'une VM en template (admin) : génère un archive .tar.gz + JSON sidecar au format dépôt.",
            "Version unique : le CLI, l'interface web et le paquet lisent tous la même source (package.json).",
          ]
        : [
            "Storage sidebar: now shows pools, ISO/Templates and the Templates section.",
            "Clone VM directly from the detail page (Copy button).",
            "Export VM as template (admin): generates a .tar.gz archive + JSON sidecar in depot format.",
            "Single version source: CLI, web UI and package all read from the same source (package.json).",
          ],
    },
    {
      v: "0.6.1",
      items: fr
        ? [
            "Catalogue de templates depuis le dépôt (VM Templates + ISO) avec modal de prévisualisation.",
            "Boutons Reset forcé (hard reset) et Forcer l'arrêt (virsh destroy) sur la page VM.",
            "Statistiques CPU/RAM collapsibles dans la console — affichées inline quand réduites.",
            "Lien Templates dans la barre latérale (section Stockage).",
            "Section source de création de VM toujours visible (même avec ?node=).",
          ]
        : [
            "Template catalog from depot (VM Templates + ISO) with preview modal.",
            "Force Reset (hard reset) and Force Stop (virsh destroy) buttons on the VM detail page.",
            "Collapsible CPU/RAM stats strip in console — shown inline when collapsed.",
            "Templates link in the sidebar (Storage section).",
            "VM creation source section always visible (even with ?node= param).",
          ],
    },
    {
      v: "0.6.0",
      items: fr
        ? [
            "Rafraîchissement visuel de l'interface Virtua.",
            "Amélioration de la page détail VM avec cartes de synthèse réseau et stockage.",
            "Correctifs packaging Debian pour la publication du dépôt VIRTUA.",
          ]
        : [
            "Visual refresh of the Virtua interface.",
            "Improved VM detail page with network and storage summary cards.",
            "Debian packaging fixes for publishing the VIRTUA repository.",
          ],
    },
    {
      v: "0.5.0",
      items: fr
        ? [
            "CLI bilingue (anglais / français) avec « virtua setlang FR | EN ».",
            "Nouvelles commandes CLI : version, health, list, set, console, clone, et une interface interactive (gui / menu).",
            "Correctif majeur : le pont réseau de l'hôte survit désormais aux redémarrages sur toutes les piles (ifupdown, netplan, NetworkManager), avec préservation de l'IPv6.",
            "Cette page « À propos » avec les notes de version et l'aide.",
          ]
        : [
            "Bilingual CLI (English / French) with “virtua setlang FR | EN”.",
            "New CLI commands: version, health, list, set, console, clone, and an interactive interface (gui / menu).",
            "Major fix: the host network bridge now survives reboots on every stack (ifupdown, netplan, NetworkManager), with IPv6 preserved.",
            "This “About” page with patch notes and help.",
          ],
    },
    {
      v: "0.4.0",
      items: fr
        ? [
            "Sauvegardes et snapshots à chaud (LXC / VM) sans gel de la machine.",
            "Sauvegardes compressées en zstd (plus petites et plus rapides) avec restauration souple (telle quelle ou modifiée).",
            "Barres de progression de sauvegarde réelles (octets réellement traités).",
            "Page Journaux avec onglets Tâches, Audit et Sécurité (évènements de sécurité immuables).",
            "Templates de VM et d'ISO.",
          ]
        : [
            "Hot backups and snapshots (LXC / VM) without freezing the machine.",
            "Backups compressed with zstd (smaller and faster) with flexible restore (as-is or modified).",
            "Real backup progress bars (actual bytes processed).",
            "Logs page with Tasks, Audit and Security tabs (immutable security events).",
            "VM and ISO templates.",
          ],
    },
    {
      v: "0.3.0",
      items: fr
        ? [
            "Réseau OVH / cloud : IP failover, pont avec MAC épinglée et garde-fous anti-lockout.",
            "Gestion du pare-feu.",
            "Vue multi-nœuds / datacenter.",
          ]
        : [
            "OVH / cloud networking: failover IP, bridge with pinned MAC and anti-lockout safeguards.",
            "Firewall management.",
            "Multi-node / datacenter view.",
          ],
    },
    {
      v: "0.2.0",
      items: fr
        ? [
            "Renforcement de la sécurité : journal d'audit, accès par rôles (ACL), MFA.",
            "Comptes et permissions par utilisateur.",
          ]
        : [
            "Security hardening: audit log, role-based access (ACL), MFA.",
            "Per-user accounts and permissions.",
          ],
    },
    {
      v: "0.1.0",
      items: fr
        ? [
            "Première version : gestion des machines virtuelles (KVM/QEMU), conteneurs LXC et Docker.",
            "Interface web avec console live (noVNC / SPICE).",
            "Pools de stockage et bibliothèque d'ISO.",
          ]
        : [
            "First release: manage virtual machines (KVM/QEMU), LXC containers and Docker.",
            "Web interface with live console (noVNC / SPICE).",
            "Storage pools and ISO library.",
          ],
    },
  ];

  const help: Array<{ title: string; body: string }> = fr
    ? [
        { title: "Machines", body: "Créez, démarrez, arrêtez et clonez vos VM, conteneurs LXC et Docker depuis le menu de gauche." },
        { title: "Console", body: "Ouvrez une console texte ou graphique sur n'importe quelle machine pour y travailler directement." },
        { title: "Stockage", body: "Gérez les pools de stockage, la bibliothèque d'ISO/templates et les disques virtuels." },
        { title: "Réseau", body: "Configurez les ponts, le NAT et le pare-feu de l'hôte." },
        { title: "Sauvegardes & snapshots", body: "Protégez et restaurez vos machines, à chaud, avec compression zstd." },
        { title: "Tout en terminal", body: "Tout est aussi accessible via la commande « virtua ». Essayez « virtua --help » ou l'interface « virtua gui »." },
      ]
    : [
        { title: "Machines", body: "Create, start, stop and clone your VMs, LXC containers and Docker from the left menu." },
        { title: "Console", body: "Open a text or graphical console on any machine to work on it directly." },
        { title: "Storage", body: "Manage storage pools, the ISO/template library and virtual disks." },
        { title: "Network", body: "Configure the host bridges, NAT and firewall." },
        { title: "Backups & snapshots", body: "Protect and restore your machines, hot, with zstd compression." },
        { title: "Everything in the terminal", body: "Everything is also available through the “virtua” command. Try “virtua --help” or the “virtua gui” interface." },
      ];

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-8">
      <header>
        <h1 className="text-2xl font-semibold text-text-100">{L("About", "À propos")}</h1>
        <p className="text-sm text-text-500 mt-1">AuxiNux Virtua Control · v{__APP_VERSION__}</p>
      </header>

      {/* Developer */}
      <section className="rounded-lg border border-surface-600 bg-surface-800/50 p-5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-500 mb-2">{L("Developer", "Développeur")}</h2>
        <p className="text-text-100 font-medium">André Porlier <span className="text-text-500">(AuxiNux)</span></p>
      </section>

      {/* Patch notes */}
      <section>
        <h2 className="text-lg font-semibold text-text-100 mb-3">{L("Patch notes", "Notes de version")}</h2>
        <div className="space-y-4">
          {releases.map((r) => (
            <div key={r.v} className="rounded-lg border border-surface-600 bg-surface-800/50 p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-sm font-semibold text-accent-400">v{r.v}</span>
              </div>
              <ul className="list-disc list-inside space-y-1 text-sm text-text-300">
                {r.items.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Help */}
      <section>
        <h2 className="text-lg font-semibold text-text-100 mb-1">{L("Help", "Aide")}</h2>
        <p className="text-sm text-text-500 mb-3">
          {L(
            "Virtua manages virtualization on your server from one place — virtual machines, LXC containers and Docker, with their storage, network, backups and consoles.",
            "Virtua gère la virtualisation de votre serveur depuis un seul endroit — machines virtuelles, conteneurs LXC et Docker, avec leur stockage, réseau, sauvegardes et consoles.",
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {help.map((h) => (
            <div key={h.title} className="rounded-lg border border-surface-600 bg-surface-800/50 p-4">
              <h3 className="text-sm font-semibold text-text-100 mb-1">{h.title}</h3>
              <p className="text-sm text-text-400">{h.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
