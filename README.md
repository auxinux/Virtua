# Virtua

Virtua est le plan de contrôle de virtualisation AuxiNux. Ce monorepo contient
l'API HTTP/WebSocket, le runner privilégié, les interfaces Web, la CLI, le
gestionnaire multi-nœuds VDM et les outils de packaging Debian.

Le client desktop, l'image VirtuaOS et les noyaux sont des projets séparés. Ils
ne doivent pas être ajoutés à ce dépôt.

## Composants

| Chemin | Rôle |
|---|---|
| `apps/api` | API Fastify, authentification, RBAC, tâches et relais de consoles |
| `apps/runner` | Opérations système privilégiées via un socket Unix |
| `apps/ui` | Interface d'administration React/Vite |
| `apps/cli` | Client en ligne de commande `virtua` |
| `apps/vdm` | Orchestrateur multi-nœuds et haute disponibilité |
| `apps/vdm-ui` | Interface du VDM |
| `packages/shared` | Types, schémas Zod et utilitaires partagés |
| `INSTALL` | Installation et mise à jour sur Debian 13 |
| `packaging` | Construction des paquets Debian et du dépôt APT |

Le détail des responsabilités et des flux est décrit dans
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Les constats de l'audit de transfert sont conservés dans
[`docs/AUDIT_TRANSFERT.md`](docs/AUDIT_TRANSFERT.md).

## Prérequis de développement

- Node.js 22;
- npm 10 ou plus récent;
- macOS ou Linux pour le développement;
- Debian 13 x86_64 avec KVM pour valider l'installation complète.

## Installation locale

```bash
npm ci
cp apps/api/.env.example apps/api/.env
npm run dev
```

Services de développement par défaut :

- interface Web : URL affichée par Vite;
- API : `http://127.0.0.1:3001`;
- runner : socket `/run/auxinuxvirtual.sock`.

Le runner effectue des opérations privilégiées. Pour les changements qui
touchent KVM, LXC, Docker, le réseau ou le stockage, utilisez une machine de
test dédiée.

## Commandes de qualité

```bash
npm run build       # compile tous les workspaces
npm test            # tests partagés et VDM
npm run check       # build complet puis tests
bash scripts/git-preflight.sh
```

La commande `git-preflight.sh` vérifie les fichiers candidats au commit, leur
taille et les motifs courants de secrets.

## Configuration

Les valeurs de développement documentées se trouvent dans :

- [`apps/api/.env.example`](apps/api/.env.example);
- [`apps/vdm/.env.example`](apps/vdm/.env.example).

Ne commitez jamais les fichiers `.env`, bases SQLite, clés privées, certificats,
archives de release ou sorties de compilation. L'installateur génère les
secrets de production et les conserve sur l'hôte cible.

## Installation et publication

- installation d'un nœud : [`INSTALL/README.md`](INSTALL/README.md);
- installation VDM : [`INSTALL/VDM-README.md`](INSTALL/VDM-README.md);
- paquet Debian : [`packaging/deb/README.md`](packaging/deb/README.md);
- transfert vers un Git privé :
  [`docs/GIT_PRIVATE_SERVER.md`](docs/GIT_PRIVATE_SERVER.md).

## Organisation des dépôts associés

La disposition recommandée utilise des clones frères :

```text
ProjetWeb/
├── Virtua/
├── Client_Desktop/
├── VirtuaOS/
└── Kernel/
    ├── VirtuaOS/
    └── AuxiNuxOS/
```

Les scripts de release acceptent les chemins explicitement documentés afin de
garder chaque historique Git indépendant.
