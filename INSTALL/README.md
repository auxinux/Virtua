# Installation — AuxiNux Contrôle Virtua

## Prérequis du serveur cible

| Élément | Requis |
|---|---|
| OS | Debian 13 (Trixie) minimal |
| Architecture | x86_64 |
| Droits | root (`sudo`) |
| RAM minimale | 2 Go |
| Espace disque | 10 Go (OS + projet) |
| Accès Internet | Pour télécharger les paquets |

---

## Méthode recommandée — Via `release.sh`

Cette méthode crée une archive autonome depuis votre machine de développement,
contenant le projet déjà compilé. Le serveur n'a pas besoin de TypeScript.

### 1. Sur la machine de développement

```bash
# Depuis la racine du projet
bash INSTALL/release.sh
```

Le script :

1. Build tout le projet (`npm run build`, CLI incluse)
2. Vérifie que les nouveaux fichiers critiques sont bien présents
3. Crée `../auxinuxvirtual-v<NODE_VERSION>.tar.gz` (sources + dist, sans node_modules)
4. Affiche les commandes de déploiement prêtes à copier-coller

### 2. Envoyer l'archive sur le serveur

```bash
scp ../auxinuxvirtual-v<NODE_VERSION>.tar.gz root@<IP-SERVEUR>:/opt/
```

### 3. Installer sur le serveur Debian 13

```bash
ssh root@<IP-SERVEUR>
mkdir -p /opt/auxinuxvirtual
tar xzf /opt/auxinuxvirtual-v<NODE_VERSION>.tar.gz -C /opt/auxinuxvirtual --strip-components=1
sudo bash /opt/auxinuxvirtual/INSTALL/install.sh -update
```

---

## Méthode alternative — Depuis les sources

Si vous souhaitez installer directement depuis les sources (sans pré-compilation) :

```bash
# Option A : via rsync depuis la machine de dev
rsync -avz --exclude node_modules \
  'Virtua/' \
  root@<IP-SERVEUR>:/opt/auxinuxvirtual/

# Option B : via Git (si le projet est hébergé)
git clone https://github.com/votre-repo/auxinuxvirtual /opt/auxinuxvirtual

# Puis sur le serveur :
ssh root@<IP-SERVEUR>
sudo bash /opt/auxinuxvirtual/INSTALL/install.sh
```

Dans ce cas, `install.sh` effectue lui-même le build TypeScript
(Node.js 22 et les outils de compilation sont installés automatiquement), et vérifie aussi
que l'arborescence extraite contient bien les nouveaux fichiers attendus avant d'installer.

---

## Ce que fait `install.sh`

1. **Vérifie** l'architecture (x86_64) et les droits root
2. **Met à jour** `apt` et le système
3. **Installe** les dépendances système :
   - `qemu-system-x86`, `qemu-utils`, `libvirt-daemon-system` → QEMU/KVM
   - `lxc`, `lxc-utils`, `lxc-templates` → LXC
   - `docker-ce` (via dépôt officiel Docker) → Docker
   - `mdadm` → RAID logiciel
   - `bridge-utils`, `iproute2`, `iptables` → Réseau
   - `build-essential`, `python3`, `g++` → Compilation des modules natifs Node.js
4. **Installe Node.js 22.x LTS** via NodeSource
5. **Lance `npm install`** avec les flags x64 (compile argon2, better-sqlite3, node-pty)
6. **Build TypeScript** si pas de dist/ pré-compilés — ignoré si release pré-compilée
7. **Génère** un secret de session aléatoire (dans `apps/api/.env`)
8. **Crée** les services systemd :
   - `auxinuxvirtual-runner` — daemon root (socket Unix `/run/auxinuxvirtual.sock`)
   - `auxinuxvirtual-api` — serveur Fastify sur le port **8441**
9. **Ouvre** le port 8441 dans ufw / iptables
10. **Démarre** les services et affiche l'URL d'accès

---

## Accès après installation

```
http://<IP-SERVEUR>:8441
```

**Identifiants par défaut :** `admin` / `admin123`
> Changez le mot de passe immédiatement à la première connexion !

---

## Fichiers créés

| Chemin | Description |
|---|---|
| `apps/api/.env` | Configuration (port, secret, chemins) |
| `/var/lib/auxinuxvirtual/` | Données applicatives (pools, DB) |
| `/var/lib/libvirt/images/isos/` | ISOs QEMU |
| `/etc/systemd/system/auxinuxvirtual-runner.service` | Service systemd runner |
| `/etc/systemd/system/auxinuxvirtual-api.service` | Service systemd API |

---

## Gestion des services

```bash
# Statut
systemctl status auxinuxvirtual-runner auxinuxvirtual-api

# Logs en temps réel
journalctl -fu auxinuxvirtual-runner
journalctl -fu auxinuxvirtual-api

# Redémarrer
systemctl restart auxinuxvirtual-runner auxinuxvirtual-api

# Stopper
systemctl stop auxinuxvirtual-api auxinuxvirtual-runner

# Désactiver au démarrage
systemctl disable auxinuxvirtual-runner auxinuxvirtual-api
```

---

## Mise à jour du projet

```bash
# 1. Sur la machine de dev : générer une nouvelle release
bash INSTALL/release.sh

# 2. Envoyer sur le serveur
scp ../auxinuxvirtual-v<NODE_VERSION>.tar.gz root@<IP-SERVEUR>:/opt/

# 3. Sur le serveur : extraire puis lancer l'update complet
tar xzf /opt/auxinuxvirtual-v<NODE_VERSION>.tar.gz -C /opt/auxinuxvirtual --strip-components=1
sudo bash /opt/auxinuxvirtual/INSTALL/install.sh -update
```

Pendant l'update, `install.sh` affiche aussi la version détectée de Virtua pour confirmer
que le serveur rebuild bien le bon code.

---

## Dépannage

### L'API ne démarre pas

```bash
journalctl -u auxinuxvirtual-api --no-pager -n 50
```

### Le socket runner n'existe pas

```bash
journalctl -u auxinuxvirtual-runner --no-pager -n 20
ls -la /run/auxinuxvirtual.sock
```

### Libvirt ne fonctionne pas

```bash
systemctl status libvirtd
virsh list --all
```

### KVM non disponible

```bash
kvm-ok
# Si "KVM acceleration can be used" → OK
# Sinon : activer la virtualisation dans le BIOS
```

### Port déjà utilisé

```bash
ss -tlnp | grep 8441
# Modifier AUXINUX_PORT dans apps/api/.env puis redémarrer l'API
```
