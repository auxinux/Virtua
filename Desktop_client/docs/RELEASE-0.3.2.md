# Version 0.3.2

Création rapide : Windows 11 ou Debian 13 prêts à l'emploi, en un clic.

Dans « Créer une machine » (mode local), deux propositions :

| | vCPU | RAM | Disque |
|---|---|---|---|
| Windows 11 | 4 | 4 Go | 80 Go |
| Debian 13 | 2 | 4 Go | 60 Go |

(jamais plus de vCPU que l'ordinateur n'a de cœurs logiques). Virtua
télécharge l'installateur, crée la VM avec la configuration optimale, la
démarre et installe le système sans aucune question. Compte : **virtua /
virtua**. La console s'ouvre directement sur l'installation.

## Debian 13

- Installateur réseau officiel (noyau + initrd, ~50 Mo), toujours celui de
  la dernière version publiée, vérifié avec le SHA256SUMS de Debian ; il
  n'est retéléchargé que lorsque Debian en publie un nouveau.
- Réponses automatiques (preseed) : français (Canada), clavier canadien
  français, fuseau horaire de l'ordinateur, disque entier, serveur SSH,
  agent invité QEMU, sudo pour `virtua`, mises à jour appliquées.
- À la fin, l'installateur éteint la VM ; Virtua la redémarre aussitôt sur
  son disque.
- Configuration : virtio-blk sur thread d'E/S, réseau NAT, accélération
  KVM/HVF/WHPX.

## Windows 11

- ISO : celle déjà présente dans la bibliothèque, sinon celle du dépôt
  AuxiNux (amd64, 25H2 français canadien). Windows 11 ARM64 (Mac) : Microsoft
  ne publie pas de lien direct, l'ISO doit être placée dans la bibliothèque
  ISO (le message indique le dossier).
- Fichier de réponses complet : disque GPT, édition Pro (clé d'installation
  générique, sans activation), compte local `virtua` avec ouverture de
  session automatique, OOBE et compte Microsoft passés, pilotes VirtIO chargés
  pendant l'installation (disque virtio-blk sur x64, NVMe sur ARM64).
- Au premier démarrage : outils invités VirtIO, Bureau à distance et
  RemoteApp activés — le **mode Unifié est prêt** sans autre réglage.
- UEFI + Secure Boot + TPM 2.0 ; le « Press any key to boot from CD » du
  premier démarrage est validé automatiquement.
- Une fois l'agent invité actif (installation terminée), l'ISO et le fichier
  de réponses sont détachés de la VM.
- Espace disque vérifié avant de télécharger l'ISO (8,4 Go).

## Téléchargements

- Un téléchargement interrompu reprend là où il s'était arrêté (ISO,
  templates, pilotes).
