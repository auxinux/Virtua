# Templates VM / ISO — Serveur Virtua

Le serveur Virtua (`apps/api` + `apps/runner`) est la **source officielle des
templates** en mode Cloud. Virtua Desktop Cloud et le portail web ne font que
**lister** les templates autorisés et les **utiliser** à la création d'une VM —
ils n'uploadent, ne modifient et ne suppriment **jamais** un template. Toute la
gestion (upload / édition / suppression) est réservée à l'**ADMIN** et vérifiée
côté API, pas seulement côté UI.

## Types de templates

| Type  | Fichier stocké            | Contenu                                            |
|-------|---------------------------|----------------------------------------------------|
| `iso` | `NomTemplate.iso` / `.img`| Image d'installation amorçable.                    |
| `vm`  | `NomTemplate.tar.gz`      | `config.virtua` + un disque `qcow2`/`raw`.         |

Architectures supportées : `amd64`, `arm64` (mappées en interne vers les
architectures QEMU `x86_64` / `aarch64`).

### Format de l'archive VM (`.tar.gz`)

```
NomTemplate.tar.gz
├── config.virtua
└── debian.qcow2        (ou .raw)
```

`config.virtua` (ini-style) :

```
[CONFIG VM TEMPLATE]
Name=Debian 13.5 AMD64
Desc=Debian 13.5 preconfigure pour Virtua
CPU=2
RAM=2048
DISK=debian.qcow2
ARCH=amd64
```

### Métadonnées JSON (sidecar)

Un fichier `NomTemplate.json` accompagne chaque archive VM. Il est **lu** s'il
est fourni, sinon **généré** par le serveur à partir de `config.virtua` :

```json
{
  "Name": "Debian 13.5 AMD64",
  "Desc": "Debian 13.5 preconfigure pour Virtua",
  "CPU": 2,
  "RAM": 2048,
  "DISK": "debian.qcow2",
  "ARCH": "amd64"
}
```

## Stockage

- ISO : `QEMU_ISOS_DIR` (par défaut `/var/lib/libvirt/images/isos`).
- VM  : `VM_TEMPLATES_DIR` (par défaut `<DATA_DIR>/templates/vm`).
- Un `storagePool` (pool de type `iso` ou `template`) peut être choisi à l'upload.
- Taille maximale configurable : `TEMPLATE_MAX_BYTES` (défaut 8 Gio, plafonné par
  la limite multipart globale).

## Permissions

- **ADMIN** : gère les templates (`POST` / `PATCH` / `DELETE /api/templates`).
- **USER**  : ne peut pas gérer les templates. Il ne **voit** et n'**utilise**
  que les templates `public` (visibilité) ou ceux dont il est propriétaire.
- Les contrôles sont appliqués **côté API** : `requireAdmin` pour la gestion,
  `canUseTemplate()` pour l'usage, `checkPermission(allow_vm_create)` + quota
  pour la création de VM.

## API serveur (nœud)

| Méthode & route                 | Auth   | Rôle   | Description                              |
|---------------------------------|--------|--------|------------------------------------------|
| `GET /api/templates`            | session| user   | Liste filtrable (`type`, `arch`).        |
| `GET /api/templates/:id`        | session| user   | Détail métadonnées.                      |
| `POST /api/templates`           | session| admin  | Upload (multipart) d'un template/ISO.    |
| `PATCH /api/templates/:id`      | session| admin  | Édite nom, description, visibilité, tags, métadonnées. |
| `DELETE /api/templates/:id`     | session| admin  | Supprime le template + fichiers associés.|
| `POST /api/resources`           | session| user   | Crée une VM depuis `templateId` ou `isoId` (tâche async). |

### `POST /api/templates` (champs multipart)

`file` (requis) + champs : `type` (`iso`\|`vm`), `name?`, `description?`,
`arch?`, `visibility?` (`public`\|`restricted`), `cpu?`, `memoryMb?`, `diskGb?`,
`tags?` (JSON), `storagePool?`.

### `POST /api/resources` (corps JSON)

```json
{
  "type": "vm",
  "name": "web1",
  "templateId": "…",        // OU "isoId"
  "isoId": "…",
  "cpu": 2,
  "memory": 2048,
  "disk": 40,
  "architecture": "amd64",
  "storagePool": "local",
  "network": "virbr0",
  "gpuModel": "virtio",
  "networkModel": "virtio"
}
```

- Depuis un **template VM** : le runner valide l'archive (anti path-traversal /
  symlink), lit `config.virtua`, importe le disque dans le pool choisi, définit
  la VM avec les valeurs du template comme défauts (surchargées par CPU/RAM/réseau
  si fournis).
- Depuis une **ISO** : la VM est créée avec l'ISO montée au démarrage
  (`bootDevice=cdrom`). L'état de l'ISO montée est exposé via `mountedIso` dans
  `GET /api/vms/:name`. L'ISO peut être éjectée/changée ensuite via les routes
  existantes `…/iso/attach` et `…/iso/eject`.

Réponse : `202 Accepted` + la tâche (suivable via `/api/tasks`), conforme au
fonctionnement multitâche (upload / import / création n'ont jamais lieu sur le
thread principal Fastify).

## Catalogue dépôt distant

Le serveur peut **parcourir et importer** des templates/ISO depuis un dépôt HTTP
(autoindex). URL de base configurable via `TEMPLATE_DEPOT_URL` (défaut
`https://dep.auxinux.ca/TEMPLATES/`). Arborescence attendue :

```
TEMPLATES/
├── ISO/{AMD64,ARM}/*.iso
└── VM/{AMD64,ARM}/Nom.tar.gz + Nom.json
```

| Méthode & route                       | Rôle  | Description                                        |
|---------------------------------------|-------|----------------------------------------------------|
| `GET /api/templates/depot`            | admin | Liste le catalogue distant (cache 5 min ; `?refresh=1`). |
| `POST /api/templates/depot/import`    | admin | Importe un élément (`{ id, storagePool?, visibility? }`) — téléchargement async suivi par une tâche. |

L'import télécharge le fichier dans le store, lit le sidecar JSON / `config.virtua`
pour les métadonnées, et crée l'entrée `templates`. UI : bouton **« Catalogue
dépôt »** sur la page Templates (onglets ISO/VM, bouton Import par élément, barre
de progression).

## API VDM (Cloud, relais)

VDM **agrège** les templates des nœuds et **relaie** la création. Il n'expose
aucune route d'écriture sur les templates.

| Méthode & route                       | Description                                  |
|---------------------------------------|----------------------------------------------|
| `GET /api/vdm/templates`              | Agrège les templates de tous les nœuds.      |
| `GET /api/vdm/nodes/:name/templates`  | Templates d'un nœud.                         |
| `POST /api/vdm/resources/:node`       | Crée une VM depuis un template/ISO sur le nœud. |

Côté nœud, VDM consomme les routes internes (authentifiées par le node-token) :
`GET /api/internal/templates`, `GET /api/internal/templates/:id`,
`POST /api/internal/resources`.

En mode Cloud (viewer), seuls les templates `public` sont listés ; les
templates `restricted` restent réservés aux administrateurs.

## Sécurité

- Extensions limitées (`.iso`/`.img` pour ISO ; `.tar.gz`/`.tgz` pour VM).
- Nom de fichier jamais utilisé tel quel : `sanitizeManagedFilename()`.
- Archive inspectée **avant** extraction (`tar -tzvf`) : rejet des chemins
  absolus, des segments `..` et de tout membre non régulier (symlink, hardlink,
  device).
- Extraction dans un dossier temporaire isolé (`mkdtemp`), nettoyé en `finally`.
- Disque validé par `qemu-img check` (chaîne de backing comprise) avant import.
- Taille maximale plafonnée ; corps tronqué => upload refusé et fichier supprimé.
- `config.virtua` / JSON validés ; un `Name` manquant fait échouer l'import.
