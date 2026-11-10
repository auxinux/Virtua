# Version 0.3.4

VM jetables (bac à sable) et disquettes virtuelles.

## VM jetables

Menu « Jetables ». Une VM prête en quelques secondes, copiée d'une **base**
déjà installée, puis jetée ou gardée.

- **Base** : système installé et généralisé, rangé en lecture seule dans
  `Local/Bases`. Une VM jetable n'est qu'un petit disque « copie à
  l'écriture » posé sur la base (quelques Ko au départ) : création
  instantanée, plusieurs jetables possibles sur une même base.
- **Bases Windows 11** : préparées sur cet ordinateur (« Préparer une base
  ici » : installation automatique comme la création rapide, puis le système
  devient une base). Un Windows installé ne se redistribue pas : il ne quitte
  pas l'ordinateur. Le mode Unifié est prêt dans chaque copie.
- **Bases Debian 13** : préparées ici, ou téléchargées du dépôt AuxiNux
  (fichiers `.vmtmp`, amd64 et ARM64), vérifiées par somme de contrôle.
  Chaque copie reçoit son propre machine-id et ses propres clés SSH.
- **À l'arrêt d'une jetable**, Virtua demande : *Jeter*, *Repartir à neuf*
  (retour à l'état de la base), *Garder telle quelle* (pour la relancer plus
  tard) ou *Convertir en VM normale*.
- **Sandbox stricte** : rien n'est écrit sur le disque, tout disparaît à
  l'arrêt (QEMU `-snapshot`). Option **Sans réseau**.
- **Exporter .vmtmp** : une base devient un fichier (archive tar : manifeste,
  disque qcow2 compressé, variables UEFI ; l'état TPM reste sur l'ordinateur).
- Compte : `virtua` / `virtua`.

## Disquettes

- Lecteur A: dans la configuration d'une VM locale (images `.img`, `.ima`,
  `.vfd`, `.flp` de 2,88 Mo au plus) : sélection dans la bibliothèque,
  Parcourir, Éjecter.
- x86 : contrôleur de disquette ajouté à la machine q35 ; sans ISO montée, la
  VM démarre sur la disquette (BIOS — un micrologiciel UEFI ne démarre pas
  sur une disquette). Avec une ISO, la disquette sert de lecteur A: (pilotes
  F6 de Windows XP…). ARM64 : la disquette apparaît comme disque USB amovible.
- Stockage : onglet « Disquettes » (les petites images du dossier ISO).

## Machine, processeur, vieux systèmes

- **Type de machine** (x86) : q35 (PC moderne, par défaut) ou **pc /
  i440FX** (PC classique : DOS, Windows 9x/XP, vieux Linux). Secure Boot
  exige q35 (le message le dit).
- **Modèle de CPU** : automatique (comme avant), `host`, `max`, ou un modèle
  précis — 486, Pentium, Pentium II/III, Athlon, Core 2 Duo, Nehalem…
  Skylake, EPYC ; sur ARM64 : Cortex-A53/A57/A72, Neoverse N1.
- **Bus disque IDE** (x86) : lu par DOS et les vieux installateurs sans
  pilote.
- **Cartes réseau NE2000 (PCI) et AMD PCnet** pour DOS et Windows 3.x/9x.
- Sur une machine « pc », la disquette utilise le contrôleur intégré du
  chipset.

Exemple DOS : machine pc, CPU 486, disque IDE, carte NE2000, carte
graphique VGA standard, disquette de démarrage sans ISO.

## Correctif ARM64 (Mac)

La création rapide Debian 13 (et la préparation d'une base Debian) restait
bloquée sur « Select a language » sur ARM64 : l'installateur tournait sur la
console série de la machine `virt`, qui ne propose que la langue « C » et
refusait le français préconfiguré. Il s'affiche maintenant à l'écran
(`console=tty0`), comme sur x86.

## Processeurs d'époque

- Choix 80286, 80386, 80486, 80586 / Pentium, Pentium II, III et 4.
  QEMU n'a pas de modèle 286/386 (son plus ancien est le 486) ni de
  Pentium 4 : 286 et 386 sont un 486, le Pentium 4 un Pentium III avec SSE2.
- **Vitesse d'époque** (x86) : la VM tourne à peu près à la vitesse de ce
  processeur — 286 ≈ 2 MIPS, 386 ≈ 8 MIPS, 486 ≈ 60 MIPS, Pentium ≈ 125 MIPS…
  — en émulation (QEMU `-icount`, TCG mono-fil) au lieu de l'accélération
  matérielle : les jeux et programmes DOS calés sur la vitesse du processeur
  ne vont plus dix fois trop vite.
