# AuxiNux Virtua Desktop

Client React + Tauri 2 / Rust pour gérer des ressources locales ou se connecter
à l’API Desktop d’un serveur Virtua. Ce dossier est autonome; il ne dépend ni du
monorepo Virtua ni de la réécriture `NouvelGeneration`.

## Utilisation

- **Cloud** : connexion par mot de passe ou pairing à un nœud Virtua
  (`https://hote:8441`) ou à un VDM (`http://hote:8440`), qui donne accès aux
  machines de tous ses nœuds. Ressources et consoles autorisées par le serveur.
  Aucun moteur local requis.
- **Local** : QEMU est vérifié avant d’ouvrir l’inventaire. L’assistant installe
  les composants manquants à la demande, avec les dialogues système nécessaires.
- **Docker** : activation dans Configuration → Moteurs locaux. Réutilisation
  du moteur existant ou installation de Docker Desktop (Mac/Windows), Docker
  Engine (Linux). Les contextes Docker distants sont refusés en mode local.
- **LXC** : géré avec Incus, le gestionnaire basé sur LXC. Sur Linux, installation
  sur l’hôte. Sur Mac/Windows, une unique VM Debian 13 héberge les conteneurs.
  Elle utilise le noyau Debian standard et l’architecture du poste, jamais le
  noyau VirtuaOS AMD64 sur une machine ARM.

La VM Debian dispose de 2 vCPU, 2 Gio de mémoire et d’un disque qcow2 extensible
jusqu’à 40 Gio. Elle est réutilisée entre les sessions. Sa préparation utilise
l’image officielle Debian `generic`, un contrôle SHA512, cloud-init et une clé
SSH dédiée avec identité serveur vérifiée. Le téléchargement nécessite Internet.
Les IP LXC sont internes à Debian; la publication de ports vers le poste n’est
pas encore proposée. Le stockage LXC `dir` est partagé, sans quota individuel.

## Développement

Prérequis de compilation : Node.js 22+, Rust stable, bibliothèques Tauri propres
au système. Ce sont les prérequis du développeur; les utilisateurs finaux n’ont
pas besoin de Node ou Rust. Les scripts `scripts/build-macos.sh`,
`scripts/build-windows.ps1` et `scripts/build-linux.sh` les installent tout seuls.

```sh
npm ci
npm run tauri:dev
```

`npm run dev` ouvre uniquement l’interface Web. Les fonctions locales nécessitent
l’application Tauri; les tests navigateur simulent explicitement cette interface.

```sh
npm run build
npm run test:rust
npx playwright install chromium
npm test
```

Test d’intégration réel, explicite, Mac/Windows avec QEMU et OpenSSH installés :

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib debian_lxc_lifecycle -- --ignored --nocapture
```

Ce test télécharge Debian, démarre une VM isolée, teste un conteneur LXC puis
nettoie ses données temporaires. Il ne vise pas l’inventaire de l’utilisateur.

## Données et compatibilité

- macOS : `~/Library/Application Support/AuxiNux Virtua Desktop/Local`.
  Le chemin 0.1.0 est conservé pour retrouver les VM existantes.
- Windows : `%LOCALAPPDATA%/AuxiNux Virtua Desktop/Local`.
- Linux : `$XDG_DATA_HOME/AuxiNux Virtua Desktop/Local`, ou
  `~/.local/share/AuxiNux Virtua Desktop/Local`.

La VM LXC, ses clés et ses journaux se trouvent dans `Local/Debian-LXC`.
Sauvegarder ce dossier complet; ne pas régénérer les clés d’une VM existante.
Fermer la fenêtre ne demande pas l’arrêt des VM. Pour arrêter Debian et ses
conteneurs, utiliser le bouton dédié dans Configuration.

Le stockage natif des identifiants utilise Keychain, Windows Credential Manager
ou le service de secrets Linux. Ne pas exécuter l’interface entière en root.
Les installations Linux peuvent nécessiter une reconnexion de session pour
activer les groupes `docker` et `incus-admin`.

Voir [BUILD_DESKTOP.md](BUILD_DESKTOP.md), [les notes 0.2.2](docs/RELEASE-0.2.2.md),
[0.2.1](docs/RELEASE-0.2.1.md) et [0.2.0](docs/RELEASE-0.2.0.md).
