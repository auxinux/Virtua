# Construire Virtua Desktop 0.2.0

Construire chaque application sur son OS cible. Le mode local installe QEMU et
les moteurs optionnels à l’utilisation, pas pendant la compilation du client.

## macOS

```sh
npm ci
npm run tauri -- build --bundles app,dmg
```

La cible native est utilisée (ARM64 sur Apple Silicon, AMD64 sur Intel).
Résultats : `src-tauri/target/release/bundle/`. La distribution publique nécessite
la signature et la notarisation avec un compte Apple configuré par le mainteneur.

## Windows

Depuis PowerShell, avec Rust MSVC et le workload C++ de Visual Studio :

```powershell
npm ci
npm run tauri -- build --bundles nsis
```

Le script `scripts/build-windows.ps1` aide à préparer une machine de build AMD64.
Windows ARM64 est une cible expérimentale : validation de QEMU et de son
accélération nécessaire. L’installation de Docker peut nécessiter WSL2 et un
redémarrage demandé par son propre assistant. Le client OpenSSH Windows est
activé à la demande pour la VM Debian LXC.

## Linux

Bibliothèques requises notamment : GTK3, WebKitGTK 4.1, OpenSSL, DBus, librsvg.

```sh
npm ci
npm run tauri -- build --bundles deb,appimage
```

`scripts/build-linux.sh` prépare les dépendances sur apt/dnf/pacman. Choisir une
cible Rust correspondant au processeur de la machine de compilation.

L’installation automatique des moteurs couvre apt, dnf et pacman lorsque les
paquets sont disponibles dans les dépôts configurés. Debian 13 dispose d’Incus
nativement. Pour une autre distribution/version, le diagnostic indique si une
installation manuelle est nécessaire; aucun dépôt tiers n’est ajouté implicitement.

## Archive des sources

```sh
./prepare-to-build.sh
```

Archive sous `build-transfer/`, sans dépendances, compilations ni résultats de tests.
La CI `.github/workflows/desktop.yml` vérifie compilation et tests sur les trois
OS lorsqu’elle est exécutée depuis le dépôt autonome de ce dossier.
