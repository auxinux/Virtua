# Construire Virtua Desktop

Chaque application se construit sur son OS cible. Un script par plateforme
installe les prérequis manquants (Node.js, Rust, compilateur, bibliothèques)
avant de compiler. Le mode local, lui, installe QEMU/Docker/LXC à l'usage, pas
pendant la compilation.

| OS | Script | Cible par défaut | Paquets produits |
| --- | --- | --- | --- |
| macOS | `./scripts/build-macos.sh` | `aarch64-apple-darwin` (Apple Silicon) ou `x86_64-apple-darwin` | `.app`, `.dmg` |
| Windows 11 | `.\scripts\build-windows.ps1` | `x86_64-pc-windows-msvc` (ou `aarch64-…` sur ARM) | installeur NSIS |
| Linux | `./scripts/build-linux.sh` | `x86_64-unknown-linux-gnu` ou `aarch64-…` | `.deb`, AppImage |

Chaque script accepte une cible et une liste de bundles :

```sh
./scripts/build-macos.sh aarch64-apple-darwin app,dmg
./scripts/build-linux.sh x86_64-unknown-linux-gnu deb
```

```powershell
.\scripts\build-windows.ps1 -Target x86_64-pc-windows-msvc -Bundles nsis
```

## macOS (Apple Silicon et Intel)

Le script vérifie les outils de ligne de commande Xcode, installe Homebrew,
Node.js et Rust si nécessaire, puis compile pour l'architecture de la machine.
La cible est déduite de `uname -m` : rien à choisir sur un Mac M-series.

Si Xcode n'est jamais passé, une fenêtre système s'ouvre : terminer l'assistant
puis relancer le script. La distribution publique exige signature et
notarisation avec un compte Apple configuré par le mainteneur.

## Windows 11

Depuis PowerShell :

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\build-windows.ps1
```

Le script installe via winget ce qui manque — Node.js LTS, Rustup, WebView2 et
les outils C++ de Visual Studio Build Tools — et recharge le `PATH` machine et
utilisateur après chaque installation, pour ne pas exiger un nouveau terminal.
Il échoue explicitement si le workload « Développement Desktop en C++ » n'est
pas coché : c'est la seule étape qui demande l'interface de Visual Studio
Installer.

Windows ARM64 reste expérimental : QEMU n'y propose pas WHPX, les VM tournent
donc en émulation logicielle.

## Linux

Le script couvre apt, dnf, zypper et pacman. Il installe GTK3, WebKitGTK
(4.1, avec repli 4.0 sur les distributions plus anciennes), libsoup3, DBus,
librsvg, OpenSSL, `pkg-config`, Node.js et Rust.

Les paquets `.deb` déclarent `libwebkit2gtk-4.1-0` et `libgtk-3-0`. La
construction AppImage télécharge ses propres outils : prévoir un accès réseau,
ou se limiter à `deb`.

## Vérifications

```sh
npm run build                                   # typecheck + bundle web
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --lib
npx playwright install chromium && npm test     # tests navigateur
```

## Archive des sources

```sh
./prepare-to-build.sh
```

Archive sous `build-transfer/`, sans dépendances ni résultats de compilation, à
transférer sur la machine de build cible.

`.github/workflows/desktop.yml` exécute formatage, lints, tests Rust,
compilation et tests navigateur sur macOS ARM, macOS Intel, Windows et Ubuntu.
Le job `bundles`, déclenché manuellement depuis l'onglet Actions, produit les
installeurs et les publie en artefacts.
