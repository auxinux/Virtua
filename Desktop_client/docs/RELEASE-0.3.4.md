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
