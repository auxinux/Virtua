# Virtua

Virtua est une plateforme de virtualisation **auto-hébergeable** permettant de gérer des machines virtuelles (QEMU/KVM), des conteneurs LXC et Docker via une interface web et une API REST.

- **Interface web** moderne (React) pour piloter VMs, LXC et Docker
- **API REST** complète avec authentification, RBAC et MFA
- **Runner privilégié** séparé de l'API (séparation des privilèges)
- **VDM** : mode datacenter multi-nœuds avec haute disponibilité
- **Docker avancé** : édition complète des conteneurs, Docker Compose persistant, volumes, exec, nettoyage

## Fonctionnalités

- **VMs (QEMU/KVM)** : création, suppression, contrôle (start/stop/reboot), consoles SPICE/VNC, snapshots, templates
- **Conteneurs LXC** : gestion complète, réseaux, snapshots
- **Docker** : édition complète des conteneurs (ports, volumes, env, image, commande, réseau, CPU/RAM), Docker Compose avec fichiers `.yml` persistants, volumes, `docker exec`, nettoyage (`prune`)
- **Stockage** : pools, volumes, snapshots
- **Réseau** : bridges, NAT, configuration
- **RBAC** : rôles et permissions par utilisateur
- **MFA** : authentification multi-facteurs (email, SMS)
- **VDM** : orchestration multi-nœuds, migration, sauvegardes, haute disponibilité

## Architecture

Le projet suit une architecture **séparation des privilèges** : l'API ne tourne pas en root, seul le runner exécute les opérations système.

```
┌─────────────────┐
│  Navigateur/CLI │
└────────┬────────┘
         │ HTTP/WebSocket
         ▼
┌─────────────────┐     ┌─────────────┐
│   API Fastify   │────▶│   SQLite    │
│   (apps/api)    │     │ (users,     │
└────────┬────────┘     │  RBAC, ...) │
         │ JSONL socket └─────────────┘
         ▼
┌─────────────────┐     ┌─────────────┐
│ Runner (root)   │────▶│ libvirt/QEMU│
│ (apps/runner)   │     │ LXC         │
└─────────────────┘     │ Docker      │
                        │ Réseau      │
                        │ Stockage    │
                        └─────────────┘
```

## Structure du projet

```
├── apps/
│   ├── api/          # API HTTP/WebSocket (Fastify)
│   ├── runner/       # Exécution privilégiée (KVM, LXC, Docker)
│   ├── ui/           # Interface web (React/Vite)
│   ├── cli/          # Client en ligne de commande
│   ├── vdm/          # Orchestrateur multi-nœuds
│   └── vdm-ui/       # Interface VDM
├── packages/
│   └── shared/       # Types et schémas Zod partagés
├── INSTALL/          # Scripts et documentation d'installation
├── packaging/        # Paquets Debian
└── docs/             # Documentation technique
```

## Build depuis les sources

### Prérequis

- **Node.js 22+** (recommandé : 22.x LTS)
- **npm 10+**
- **Linux** avec KVM activé (pour tester le runner)
- **SQLite3**

### Installer les dépendances

```bash
npm ci
```

### Compiler

```bash
npm run build
```

Ceci compile tous les workspaces (API, runner, UI, CLI, VDM) et produit les artefacts dans `apps/*/dist/`.

### Lancer les tests

```bash
npm test
```

### Mode développement

```bash
# API + runner + UI ensemble
npm run dev

# Ou séparément
npm run dev:api
npm run dev:runner
npm run dev:ui

# VDM (multi-nœuds)
npm run dev:vdm
```

### Construire un paquet Debian (`.deb`)

```bash
cd packaging/deb
./build-deb.sh
# → out/auxinux-virtua_<version>_amd64.deb
```

## Installation

<a id="install-depot"></a>
### Installation via le dépôt APT (`.deb`)

La façon la plus simple d'installer Virtua sur un serveur Debian 13 est d'utiliser le paquet Debian `auxinux-virtua` :

```bash
# 1. Ajouter la source APT (clé de signature incluse)
sudo curl -fsSL https://dep.auxinux.ca/VIRTUA/virtua.sources \
  -o /etc/apt/sources.list.d/virtua.sources

# 2. Mettre à jour et installer
sudo apt update
sudo apt install auxinux-virtua
```

Le paquet provisionne automatiquement l'hôte (Node.js, Docker, la pile KVM/libvirt, les services systemd et le pont réseau) via un service systemd en arrière-plan. Suivez la progression :

```bash
journalctl -fu auxinux-virtua-setup
```

Une fois terminé, le panneau est disponible sur :

```
https://<IP-SERVEUR>
http://<IP-SERVEUR>:8441
```

### Mise à jour

```bash
sudo apt update && sudo apt upgrade
```

### Installation depuis les sources

Si vous préférez installer directement depuis les sources (sans paquet Debian) :

```bash
# Sur le serveur Debian 13
git clone https://git.auxinux.ca/Auxinux/Virtua.git /opt/auxinuxvirtual
cd /opt/auxinuxvirtual
sudo bash INSTALL/install.sh
```

`install.sh` installe les dépendances système, Node.js 22, compile le projet et configure les services systemd.

## Sécurité

- **Séparation des privilèges** : l'API ne tourne pas en root, seul le runner a besoin de privilèges
- **Validation des entrées** : toutes les entrées externes sont validées via Zod
- **Audit** : journalisation des actions dans SQLite
- **CSRF** : protection contre les attaques CSRF
- **Rate limiting** : limitation des requêtes par IP/utilisateur

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — vue d'ensemble technique
- [Templates](docs/templates.md) — gestion des templates VM/ISO
- [Installation](INSTALL/README.md) — instructions détaillées
- [VDM](INSTALL/VDM-README.md) — mode datacenter multi-nœuds

## Licence

MIT — Auxinux
