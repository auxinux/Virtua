# Version 0.4.0

**Nouveau : mode Proxmox VE.** Virtua Desktop se connecte directement à un
serveur Proxmox VE 9 (testé avec 9.2), sans serveur Virtua entre les deux.
Au choix du mode : **Local**, **Client (Cloud)** ou **Proxmox VE**.

## Connexion

1. L'adresse de l'interface web Proxmox (`pve.exemple.lan` suffit : https et
   le port 8006 sont supposés).
2. L'empreinte SHA-256 du certificat du serveur s'affiche : comparez-la avec
   Proxmox → nœud → Système → Certificats, puis confirmez. Proxmox utilise un
   certificat auto-signé ; plutôt que de couper la vérification, Virtua
   **épingle** ce certificat : toutes les requêtes et les consoles l'exigent.
   S'il change, la connexion est refusée et la nouvelle empreinte est montrée.
3. Le compte (`root@pam`, `alice@pve`…) avec :
   - **mot de passe** : rien n'est enregistré, reconnexion au prochain
     lancement ;
   - **jeton d'API** (Datacenter → Permissions → API Tokens) : le secret peut
     être gardé dans le trousseau du système, et Virtua se reconnecte seul.
     C'est aussi la voie pour les comptes à double authentification.

## Ce qui marche

- **Inventaire** de tout le cluster : nœuds, VM, conteneurs, templates, avec
  CPU, mémoire et durée de fonctionnement ; recherche.
- **Démarrer, éteindre, redémarrer, arrêt forcé.**
- **Consoles** dans l'application : écran des VM (VNC), et **shell** des
  conteneurs (comme « Console » dans Proxmox).
- **Créer une VM** : nœud, VMID, ISO, système invité, vCPU, mémoire, stockage,
  disque, pont réseau. Machine q35 + UEFI + disque virtio-scsi ; pour Windows,
  TPM 2.0 et clés Secure Boot.
- **Créer un conteneur** : modèle (template), mot de passe root, ressources,
  réseau en DHCP ; **non privilégié** par défaut.
- **Fiche d'une machine** : nom, vCPU, mémoire, démarrage avec le serveur,
  notes ; **agrandir un disque** ; **instantanés** (prendre, revenir,
  supprimer) ; **supprimer** la machine (il faut taper son VMID).
- **Tâches** : les dernières tâches Proxmox du cluster.

Les droits sont ceux de votre compte Proxmox : une action refusée affiche le
message de Proxmox.

## Pas encore

- La console SPICE de Proxmox (passe par son proxy) : la console VNC est
  utilisée.
- Migration entre nœuds, sauvegardes (vzdump/PBS), pare-feu, HA.
