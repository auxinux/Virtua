# Virtua

Virtua est une plateforme de virtualisation permettant de gérer des machines virtuelles (QEMU/KVM), des conteneurs LXC et Docker via une interface web et une API REST.

## Architecture

Le projet suit une architecture **séparation des privilèges** :

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
├── INSTALL/          # Documentation d'installation
├── packaging/        # Paquets Debian
└── docs/             # Documentation technique
```

## Fonctionnalités

- **Gestion de VMs** : Création, suppression, contrôle (start/stop/reboot), consoles SPICE/VNC
- **Conteneurs** : Support LXC et Docker
- **Stockage** : Pools de stockage, volumes, snapshots
- **Réseau** : Configuration réseau, bridges, NAT
- **Templates** : Templates de VMs et ISOs
- **RBAC** : Rôles et permissions utilisateurs
- **MFA** : Authentification multi-facteurs (email, SMS)
- **VDM** : Orchestration multi-nœuds avec haute disponibilité

## Développement

### Prérequis

- Node.js 22+
- npm 10+
- Linux avec KVM activé (pour tester le runner)
- SQLite3

### Installation

```bash
npm ci
cp apps/api/.env.example apps/api/.env
# Éditer apps/api/.env avec vos paramètres
```

### Démarrage

```bash
# Mode développement (api + runner + ui)
npm run dev

# Ou séparément
npm run dev:api
npm run dev:runner
npm run dev:ui

# VDM (multi-nœuds)
npm run dev:vdm
```

### Build

```bash
npm run build    # Compile tout
npm test         # Lance les tests
npm run check    # Build + tests
```

## Production

### Installation via paquet Debian

Voir [INSTALL/README.md](INSTALL/README.md) pour les instructions détaillées.

### Scripts utilitaires

- `sync-os-mirrors.sh` - Synchronisation des miroirs OS (usage interne)

## Sécurité

- **Séparation des privilèges** : L'API ne tourne pas en root, seul le runner a besoin de privilèges
- **Validation des entrées** : Toutes les entrées externes sont validées via Zod
- **Audit** : Journalisation des actions dans SQLite
- **CSRF** : Protection contre les attaques CSRF
- **Rate limiting** : Limitation des requêtes par IP/utilisateur

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - Vue d'ensemble technique
- [Templates](docs/templates.md) - Gestion des templates VM/ISO

## Licence

MIT - Auxinux
