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

## Méthode recommandée — Via le dépôt APT (`.deb`)

La façon la plus simple d'installer Virtua est d'utiliser le paquet Debian `auxinux-virtua` :

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

---

## Méthode alternative — Depuis les sources

Si vous souhaitez installer directement depuis les sources (sans paquet Debian) :

```bash
# Sur le serveur Debian 13
git clone https://git.auxinux.ca/Auxinux/Virtua.git /opt/auxinuxvirtual
cd /opt/auxinuxvirtual
sudo bash INSTALL/install.sh
```

`install.sh` installe les dépendances système, Node.js 22, compile le projet et configure les services systemd.

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
