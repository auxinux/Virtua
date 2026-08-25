# xrdp-virtua — xrdp patché pour VirtuaOS

## Pourquoi

Le mode « RDP Remote » de Virtua lance une **instance xrdp dédiée par VM**
(port dédié, une seule session `[vm]` pointant sur la console QEMU/VNC,
sélectionnée par `autorun=vm`). Objectif : comportement type Hyper-V
vmconnect — double-clic sur le `.rdp` → écran de la VM, sans mire de login.

Problème : xrdp stock ne saute sa mire de login **que si le client RDP envoie
l'autologon** (`INFO_AUTOLOGON`, vérifié dans `xrdp_wm.c` / `xrdp_sec.c`).
Les clients Microsoft n'envoient ce flag que si un mot de passe est
enregistré. Un `.rdp` fraîchement téléchargé retombe donc toujours sur la
mire xrdp. Aucune option de configuration ne contourne cela.

## Le patch

`skip-login-with-autorun.patch` — une condition modifiée dans
`xrdp_wm_init()` : si `[Globals] autorun=` est configuré, connexion directe
(même chemin de code que l'autologon client). En cas d'échec du module
(ex. VNC injoignable), xrdp retombe sur la mire comme avant — pas de boucle.
Les configurations sans `autorun` (xrdp de bureau classique) sont inchangées.

## Construire et publier

```bash
sudo apt-get install -y devscripts quilt dpkg-dev
sudo apt-get build-dep -y xrdp     # nécessite deb-src dans sources.list
bash build-xrdp-virtua.sh
```

Le paquet produit est versionné `<version>+virtua1` (apt le préfère au paquet
Debian). Publier sur votre dépôt APT via `publish-repo.sh`, puis sur les hôtes :
`apt update && apt upgrade`.

## Sécurité (important)

Chaque passerelle exige le mot de passe console VNC propre à la VM. Le fichier
`.rdp` ne contient pas ce secret : le client le demande à la connexion et xrdp
le transmet au backend VNC. Les règles firewall Virtua créées par « Prepare
RDP profile » doivent malgré tout rester limitées aux réseaux de confiance.
