# Architecture de Virtua

## Vue d'ensemble

Virtua sépare l'API non privilégiée des opérations système. Cette frontière est
essentielle : l'API valide l'identité, les permissions et les données, puis le
runner exécute uniquement une action connue avec les paramètres reçus.

```text
Navigateur / CLI / client desktop
                 │ HTTP, WebSocket
                 ▼
        API Fastify (`apps/api`)
          │                 │
          │ JSONL           └── SQLite : utilisateurs, RBAC, tâches
          │ socket Unix
          ▼
 Runner privilégié (`apps/runner`)
          │
          ├── libvirt / QEMU
          ├── LXC
          ├── Docker
          ├── réseau
          └── stockage
```

Le VDM ajoute une couche d'orchestration. Il contacte les API des nœuds avec
des jetons dédiés, maintient son propre état SQLite et relaie les tickets de
console sans exposer les secrets inter-nœuds.

## Responsabilités par module

### API

`apps/api/src/server.ts` compose le serveur : plugins Fastify, sessions,
contrôles CSRF, routes, tâches de fond et relais WebSocket. Les fonctions
spécialisées vivent dans des modules séparés :

- `db.ts` : ouverture SQLite, migrations et journal d'audit;
- `runnerClient.ts` : protocole JSON par ligne vers le runner;
- `desktop.ts` : surface d'API à jetons pour le client desktop;
- `mfa.ts` : second facteur par courriel ou SMS;
- `quota.ts` : limites et permissions de création;
- `ssl.ts` : certificats et renouvellement.

`server.ts` reste le principal point de dette technique en raison de sa taille.
Les futures routes doivent être extraites par domaine fonctionnel sans modifier
les contrôles transversaux : authentification, RBAC, CSRF, audit et gestion des
erreurs.

### Runner

`apps/runner/src/runner.ts` possède le socket Unix et distribue les actions aux
gestionnaires de `apps/runner/src/handlers`. Le runner doit :

- refuser toute action inconnue;
- valider les chemins et identifiants avant une commande système;
- utiliser des arguments séparés plutôt qu'une commande shell construite;
- renvoyer une réponse finale pour chaque identifiant de requête;
- émettre des événements de progression pour les opérations longues.

### Modèles partagés

`packages/shared` est la source de vérité des contrats entre services et
clients. Un champ exposé par l'API doit d'abord être typé et, pour une entrée
externe, validé par un schéma Zod. Les tests de schémas servent de protection
contre les changements de contrat involontaires.

### Interfaces Web

Les deux interfaces React utilisent TanStack Query pour l'état serveur. Les
clients HTTP centralisés ajoutent le jeton CSRF aux mutations. Les pages ne
doivent pas dupliquer les règles d'autorisation du serveur : elles peuvent
masquer une action, mais l'API reste l'autorité.

### VDM

Le VDM orchestre plusieurs nœuds Virtua. `nodeClient.ts` limite les délais,
classe les erreurs et ne retente automatiquement que les lectures idempotentes.
En haute disponibilité, SQLite utilise le journal classique plutôt que WAL sur
le stockage partagé.

## Flux critiques

### Mutation d'une ressource

1. L'API authentifie la session et valide le jeton CSRF.
2. Le schéma partagé valide le corps de la requête.
3. Le contrôle RBAC et le quota sont évalués.
4. Une tâche traçable est créée.
5. L'action est envoyée au runner ou au nœud distant.
6. La progression et le résultat sont enregistrés dans l'audit.

### Console

1. L'API vérifie le droit `console` sur la ressource.
2. Elle émet un ticket court, contextualisé et à usage limité.
3. Le WebSocket consomme le ticket.
4. Le relais connecte la console locale ou le nœud distant.
5. Aucun port de console hyperviseur n'est exposé directement au client.

## Conventions de maintenance

- TypeScript strict; éviter `any` sur les frontières externes.
- Une fonction porte une responsabilité et utilise un nom métier explicite.
- Les commentaires expliquent une contrainte, un invariant ou une décision,
  jamais une simple répétition du code.
- Les secrets proviennent de l'environnement ou sont générés à l'installation.
- Toute nouvelle entrée externe reçoit une validation et un test.
- Toute modification du runner est testée sur un hôte jetable avant production.
