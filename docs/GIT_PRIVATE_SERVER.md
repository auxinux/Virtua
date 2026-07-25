# Transfert vers un serveur Git privé

Ce guide part d'un dépôt privé vide déjà créé sur le serveur. Remplacez
`git.example.net`, `groupe` et `virtua.git` par les valeurs réelles.

## 1. Vérifier la copie locale

Depuis la racine de Virtua :

```bash
npm ci
npm run check
bash scripts/git-preflight.sh
git status --short
```

Les sorties `dist`, `node_modules`, bases SQLite, fichiers `.env`, paquets,
images ISO et le dépôt desktop séparé ne doivent pas apparaître dans la liste.

## 2. Créer le premier commit

```bash
git add --all
git diff --cached --stat
git diff --cached --check
git commit -m "Initial private import of Virtua"
```

Le dépôt actuel n'ayant pas d'historique, cette étape crée le commit racine.
Inspectez impérativement le contenu indexé avant de valider.

## 3. Ajouter le serveur privé

Connexion SSH recommandée :

```bash
git remote add origin git@git.example.net:groupe/virtua.git
git remote -v
git push -u origin main
```

Variante HTTPS :

```bash
git remote add origin https://git.example.net/groupe/virtua.git
git push -u origin main
```

Utilisez un gestionnaire d'identifiants ou un jeton à portée minimale. Ne placez
jamais un mot de passe ou un jeton dans l'URL du remote.

## 4. Réglages recommandés côté serveur

- visibilité privée;
- branche `main` protégée;
- fusion par demande de changement;
- validation de `npm run check` avant fusion;
- authentification multifacteur pour les comptes humains;
- clés SSH distinctes et révocables;
- sauvegarde régulière du dépôt et de sa configuration;
- interdiction des force-push sur `main`;
- taille maximale de fichier adaptée aux sources, pas aux images ou paquets.

Les binaires de release doivent être publiés dans un registre de paquets ou une
zone d'artefacts, pas dans l'historique Git.

## 5. Cloner et déployer

```bash
git clone git@git.example.net:groupe/virtua.git
cd virtua
npm ci
npm run check
sudo bash INSTALL/install.sh
```

Pour une mise à jour :

```bash
git pull --ff-only
npm ci
npm run check
sudo bash INSTALL/install.sh -update
```

En production, déployez de préférence un tag ou un commit précis plutôt qu'une
branche mouvante.
