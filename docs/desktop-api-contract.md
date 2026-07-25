# Contrat d'intégration du client desktop

Ce document décrit le contrat attendu entre Virtua et le nouveau client
desktop `Client_Desktop/NouvelGeneration`.

Objectif : garder le serveur Virtua et le nouveau client Rust alignes, surtout pour l'API Desktop, les consoles, la securite et les liens `virtua://`.

## Contexte

Le nouveau client desktop est developpe dans :

```text
Client_Desktop/NouvelGeneration
```

Il ne doit pas utiliser le mode local de l'ancien client. Il se connecte uniquement a un serveur Virtua.

Le serveur reste toujours l'autorite pour :

- l'identite de l'utilisateur;
- les permissions;
- la liste des VM/LXC/Docker visibles;
- les actions autorisees;
- l'emission des tickets console;
- la validation des liens `virtua://`.

## Consignes principales pour l'orchestrateur Virtua

### 1. Endpoints attendus par le client NG

Le client Rust NG attend ces endpoints :

```text
POST /api/desktop/auth/login
POST /api/desktop/devices/pair
POST /api/desktop/auth/refresh
GET  /api/desktop/me
GET  /api/desktop/resources
GET  /api/desktop/resources/{id}
POST /api/desktop/resources/{id}/actions/{action}
POST /api/desktop/resources/{id}/console/{mode}-ticket
```

Notes :

- `{id}` est URL-encode par le client.
- `{action}` est passe tel quel.
- Le serveur doit accepter au minimum : `start`, `stop`, `restart`.
- Le client NG ne fait pas de mapping `shutdown -> stop`.

### 2. Reponses JSON strictes

Les reponses doivent respecter le camelCase et les champs obligatoires.

#### Login, pairing et refresh

```json
{
  "accessToken": "...",
  "expiresIn": 900,
  "refreshToken": "...",
  "device": {
    "id": "...",
    "name": "...",
    "createdAt": "...",
    "lastSeenAt": null
  }
}
```

Important :

- `expiresIn` est en secondes.
- `/auth/refresh` doit renvoyer un nouveau `refreshToken`.
- Le client sauvegarde le refresh token dans le keyring a chaque refresh.

#### Me

```json
{
  "user": {
    "id": 1,
    "username": "...",
    "displayName": "...",
    "role": "USER"
  },
  "device": {
    "id": "...",
    "name": "...",
    "createdAt": "...",
    "lastSeenAt": null
  }
}
```

Important :

- `user.id` doit etre un nombre, pas une string.

#### Resource

```json
{
  "id": "...",
  "type": "vm",
  "name": "...",
  "displayName": "...",
  "state": "running",
  "node": "...",
  "cpuPercent": 0,
  "memoryPercent": 0,
  "ipAddress": "...",
  "uptime": "...",
  "owner": "...",
  "permissions": {
    "canView": true,
    "canConsole": true,
    "canPower": true,
    "canSnapshot": true,
    "canModify": true,
    "canDelete": false,
    "canCreate": false
  }
}
```

Important :

- `type` doit etre exactement `vm`, `lxc` ou `docker`.
- Les permissions `canView`, `canConsole`, `canPower`, `canSnapshot` sont obligatoires.
- Les permissions `canModify`, `canDelete`, `canCreate` peuvent etre optionnelles.

#### Ticket console

```json
{
  "ticket": "...",
  "url": "wss://serveur.com/api/ws/vnc?ticket=...",
  "expiresInMs": 60000,
  "kind": "graphical"
}
```

Important :

- `kind` doit etre `text` ou `graphical`.
- `expiresInMs` est en millisecondes.
- Le client attend `expiresIn` en secondes pour les tokens, mais `expiresInMs` en millisecondes pour les tickets console.

#### Erreurs

```json
{
  "error": "Message clair"
}
```

ou :

```json
{
  "message": "Message clair"
}
```

Le client affiche `error`, sinon `message`, sinon `HTTP <code>`.

### 3. URL de console

Changement important par rapport a l'ancien client :

Le client NG utilise `ticket.url` tel quel.

Le serveur doit donc renvoyer une URL absolue et joignable par le client :

```text
wss://serveur.com/api/ws/vnc?ticket=...
wss://serveur.com/api/ws/term?ticket=...
wss://serveur.com/api/ws/spice?ticket=...
```

Ne pas renvoyer :

- `127.0.0.1`;
- `localhost`;
- une URL relative;
- une URL interne non accessible depuis le client.

Recommandation :

- passer le ticket dans l'URL sous forme `?ticket=...`;
- garder les tickets courts, usage unique et lies au user/device/resource.

Diagnostic confirme cote client NG le 2026-06-16 :

- le client recoit bien un ticket console texte;
- le serveur retourne une URL du type `wss://srv02.athub.ca/api/ws/term?ticket=...`;
- le client tente bien la connexion WebSocket sur cette URL;
- la reponse obtenue est `HTTP 404 Not Found`.

Interpretation probable :

- la route WebSocket `/api/ws/term` n'est pas exposee sur le serveur public;
- ou le reverse proxy ne transmet pas l'upgrade WebSocket vers l'API;
- ou le serveur genere une URL de console qui ne correspond pas a une route active;
- ou la route existe dans une ancienne API mais pas dans la version deploiyee.

Action demandee a l'orchestrateur Virtua :

- verifier que `/api/ws/term?ticket=...` existe vraiment cote serveur;
- verifier que `/api/ws/vnc?ticket=...` existe aussi pour les consoles graphiques;
- verifier que le reverse proxy laisse passer `Upgrade: websocket` et `Connection: Upgrade`;
- verifier que l'URL retournee dans le ticket pointe vers le bon host public et le bon chemin;
- refaire le test depuis le client NG apres correction.

### 3.1. Priorite SPICE pour les VM

Decision client Desktop NG du 2026-06-18 :

- RDP est abandonne pour la console hyperviseur.
- SPICE devient la direction principale pour les consoles graphiques VM QEMU/KVM.
- VNC reste un fallback de compatibilite tant que SPICE n'est pas disponible.

Contrat attendu cote serveur Virtua :

- ajouter un endpoint ticket desktop pour SPICE :
  - `POST /api/desktop/resources/:id/console/spice-ticket`;
  - memes controles que VNC : utilisateur, device, ressource, droits `can_console`, ticket court, usage limite;
  - reponse compatible `DesktopConsoleTicket`, avec `kind: "spice"` et `url` absolue.
- ajouter une route WebSocket publique :
  - `wss://serveur.com/api/ws/spice?ticket=...`;
  - le client Desktop NG utilise `ticket.url` tel quel.
- exposer/proxy la console SPICE de QEMU/libvirt via Virtua, pas directement depuis la VM invitee.
- le serveur doit rester le point de validation des droits; le client ne doit jamais ouvrir une console SPICE sans ticket serveur.
- tant que SPICE n'est pas expose, le client tente SPICE pour les VM puis retombe automatiquement sur VNC.

Notes d'implementation serveur :

- SPICE doit etre attache au domaine libvirt/QEMU de la VM, pas a un service dans l'OS invite.
- privilegier un transport relaye par Virtua ou un endpoint public ephemere securise par ticket.
- prevoir plus tard : clipboard partage, resize invite, capture souris/clavier amelioree, canaux audio/USB si souhaites.

### 4. Authentification et refresh

Comportement attendu :

- si l'access token est expire, le serveur doit renvoyer `401`;
- le client fait alors un seul refresh;
- le client retente ensuite la requete une fois;
- si le refresh echoue, le client doit demander une reconnexion.

Important :

- utiliser `401` pour access token expire ou invalide;
- ne pas utiliser `403` pour un simple token expire;
- `403` doit rester reserve aux droits insuffisants.

### 5. Protocole virtua://

Formats reconnus par le client NG :

```text
virtua://open?server=SERVEUR&resource=UUID&mode=graphical
virtua://SERVEUR/resource/UUID?mode=graphical
```

Modes reconnus :

- `text`;
- `terminal`;
- `graphical`;
- `vnc`;
- mode absent = `graphical`.

Format recommande a generer cote serveur :

```text
virtua://serveur.com/resource/UUID?mode=graphical
```

Regles de securite :

- le lien `virtua://` est seulement une demande d'ouverture;
- le client ne doit rien ouvrir sans validation serveur;
- le client appelle d'abord `GET /api/desktop/resources/{id}`;
- ensuite seulement il demande le ticket console;
- si l'utilisateur n'a pas les droits, le serveur doit refuser;
- si l'utilisateur n'est pas connecte au serveur du lien, le client demande login ou pairing;
- si le serveur du lien est different du serveur configure, le client demande une confirmation explicite;
- le client ne doit jamais envoyer le token d'un serveur a un autre serveur.

### 6. Points a surveiller par l'orchestrateur

- Confirmer que l'API serveur respecte exactement les noms camelCase attendus.
- Confirmer que les URLs console sont absolues et accessibles depuis le client.
- Confirmer que les tickets console sont usage unique, courts et lies au contexte utilisateur/device/resource.
- Confirmer que les permissions sont toujours validees cote serveur.
- Confirmer que `virtua://` utilise des UUID opaques et non des noms internes sensibles.
- Confirmer que le serveur ne depend pas de l'ancien mode local du client.

## Résumé du contrat

Le client NG attend un contrat API strict. Virtua doit rester aligné sur ce
contrat avant de finaliser l'intégration desktop.

Les points les plus importants sont :

- endpoints Desktop stables;
- reponses JSON strictes;
- refresh token renvoye a chaque refresh;
- `401` pour token expire;
- `403` pour droits insuffisants;
- tickets console courts et usage unique;
- URLs WebSocket console absolues;
- liens `virtua://` bases sur UUID et valides par le serveur.
