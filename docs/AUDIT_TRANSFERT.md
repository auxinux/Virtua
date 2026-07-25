# Audit de préparation au transfert

Date du contrôle : 25 juillet 2026.

## État validé

- Les sept workspaces TypeScript compilent.
- Les 54 tests présents réussissent.
- Les scripts shell du projet passent l'analyse syntaxique de Bash.
- Les fichiers de build, dépendances, bases locales, secrets d'environnement,
  paquets et images sont exclus de Git.
- Le contrôle des fichiers candidats ne trouve ni fichier supérieur à 10 Mio
  ni motif de jeton courant.
- Les configurations et journaux de développement non destinés au produit ont
  été retirés du dépôt principal.

Ces contrôles réduisent le risque de fuite, mais ne remplacent pas une revue
humaine du premier `git diff --cached` ni un analyseur de secrets côté serveur.

## Dépendances

Les dépendances compatibles ont été actualisées. En particulier,
`@fastify/static` passe à la branche corrigée 10.1 afin de supprimer les avis de
contournement de garde de route et de chemin non canonique.

`npm audit` conserve les avis suivants :

- React Router 7.18 : avis visant le mode serveur/RSC. Les interfaces Virtua
  utilisent uniquement `BrowserRouter`, `Routes`, `Route`, `Link` et les hooks
  de navigation dans une application SPA; elles n'activent ni RSC, ni actions,
  ni rendu serveur.
- Vite 5/esbuild : avis lié au serveur de développement. Celui-ci reste local
  et ne doit jamais être exposé sur un réseau non fiable. La migration Vite 7/8
  a été testée, mais casse actuellement la construction de noVNC; elle est donc
  reportée jusqu'à la mise à niveau de cette chaîne.

Ces exceptions doivent être réévaluées à chaque mise à jour de dépendances.

## Dette technique observée

- `apps/api/src/server.ts` concentre plus de dix mille lignes. Les nouvelles
  routes devraient être extraites par domaine fonctionnel.
- Les gestionnaires QEMU et LXC sont également volumineux et nécessitent des
  tests d'intégration sur un hôte jetable.
- La couverture automatisée porte surtout sur les contrats partagés et le
  client de nœud VDM; l'API, le runner et les interfaces manquent de tests.
- Les bundles de console SPICE dépassent 500 Ko après minification. Ils sont
  chargés à la demande, mais une séparation plus fine reste souhaitable.

## Priorités après import

1. Activer une vérification de secrets et `npm run check` dans l'intégration
   continue.
2. Protéger `main` et exiger une revue avant fusion.
3. Ajouter des tests d'intégration API/runner sur une machine Debian dédiée.
4. Extraire progressivement les routes de `server.ts`.
5. Reprendre la mise à niveau Vite avec une version de noVNC compatible.
