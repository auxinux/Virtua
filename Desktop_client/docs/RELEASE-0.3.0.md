# Version 0.3.0

Virtua Desktop gère d'abord cet ordinateur, devient nettement plus rapide en
local, et ouvre les applications Windows d'une VM comme des applications
natives (mode Unifié).

## Local par défaut

- Au premier lancement, l'application ouvre directement le mode local (et
  l'assistant QEMU s'il manque). Le choix Local / Cloud reste mémorisé ; le
  Cloud se rejoint en un clic depuis l'assistant ou « Changer de mode ».
- AuxiNux OS est reconnu (noyau `*-auxinux-*` ou `ID=auxinux`) et affiché dans
  Configuration → Moteurs locaux.
- Linux : si `/dev/kvm` existe mais n'est pas accessible, l'application le dit
  (au lieu de tourner en émulation logicielle sans prévenir) et propose
  « Autoriser KVM » (ajout au groupe `kvm`). La préparation de QEMU le fait
  aussi.

## Performances des VM locales

Chaque démarrage tente d'abord une configuration optimisée, puis la même sans
optimisation si la version de QEMU en refuse une option : aucune VM ne perd de
fonction à cause des réglages.

- Windows sur KVM (AuxiNux, Linux) : « enlightenments » Hyper-V (`hv_*`),
  HPET coupé, horloge locale avec rattrapage, PIT `delay`.
- Windows 11 sur WHPX (Windows x64) : processeur x86-64-v2 (SSE4.2, POPCNT),
  exigé par Windows 11 24H2.
- Disque virtio servi par un thread d'E/S dédié (Linux, macOS), `io_uring`
  sur KVM, `detect-zeroes=unmap` partout.
- Une seule « socket » processeur : Windows Famille n'utilisait qu'un vCPU sur
  les QEMU anciens qui créaient une socket par vCPU.
- `virtio-rng` pour toutes les VM, `virtio-balloon` avec restitution de la
  mémoire libérée sur KVM.
- Démarrage : la VM est considérée lancée dès que QEMU répond (QMP), au lieu
  d'une attente fixe de 2,5 s.

Configurations vérifiées avec QEMU 10.0 (Debian 13 / AuxiNux).

## Fluidité de l'interface

- Inventaire local : un seul passage dans la table des processus pour toutes
  les VM (jusqu'à quatre par VM auparavant) ; Docker et LXC interrogés en
  parallèle ; QEMU et le contexte Docker ne sont plus re-sondés à chaque
  rafraîchissement ; rien n'est lancé pour un moteur absent.
- Un rafraîchissement qui ne change rien ne redessine plus l'interface.
- Rafraîchissement plus lent quand la fenêtre n'est pas au premier plan,
  immédiat au retour.
- LXC : l'adresse IP des conteneurs Incus est affichée.

## Cloud

- Correction : deux requêtes qui renouvelaient le jeton en même temps
  fermaient la session (le serveur révoque un jeton de renouvellement dès son
  usage). Un seul renouvellement est désormais en cours à la fois.
- Serveur injoignable : les rafraîchissements s'espacent (jusqu'à une minute)
  au lieu d'insister toutes les trois secondes.

## Mode Unifié (nouveau)

Une application installée dans une VM Windows s'ouvre dans sa propre fenêtre
sur l'ordinateur hôte, avec son icône, à la manière de Parallels Coherence.
Menu « Mode Unifié ».

- Prérequis : Windows 10/11 Professionnel, Entreprise ou Éducation (l'édition
  Famille n'a pas de Bureau à distance), QEMU Guest Agent installé
  (`virtio-win-guest-tools`), un compte Windows avec mot de passe.
- Activation en un clic : Virtua active le Bureau à distance et RemoteApp dans
  Windows via l'agent invité, puis liste les applications du menu Démarrer
  avec leurs icônes.
- Le port RDP de chaque VM Windows (réseau NAT) est redirigé vers
  `127.0.0.1` uniquement, jamais vers le réseau.
- Clients : Connexion Bureau à distance intégrée sur Windows ; FreeRDP 3
  (`xfreerdp3`) sur Linux/AuxiNux, installable depuis la page ; FreeRDP +
  XQuartz sur macOS. Le mot de passe reste dans le trousseau du système et
  n'apparaît pas dans la liste des processus (FreeRDP 3).
- « Ajouter au menu de cet ordinateur » crée un lanceur par application
  (`.desktop` sur Linux, menu Démarrer sur Windows, `~/Applications/Virtua
  Apps` sur macOS). Un lanceur démarre la VM si besoin, attend Windows puis
  ouvre l'application.
- Presse-papiers partagé, son, dossier personnel de l'hôte visible dans
  Windows (FreeRDP).

Limites connues : sur macOS les fenêtres passent par XQuartz (aspect X11) ;
une VM démarrée avant la mise à jour doit être redémarrée une fois pour ouvrir
son port RDP ; sur les éditions client de Windows, ouvrir une application
déconnecte la console graphique du même utilisateur.

## Windows

- La version publiée n'ouvre plus de fenêtre de console à côté de
  l'application.
