# AuxiNux Virtua — Debian packaging (`.deb` + APT repo)

Distribute AuxiNux Virtua as a `.deb` served from your APT repository
(`https://dep.auxinux.ca/VIRTUA/`) so clients install and update with plain apt:

```bash
sudo apt install auxinux-virtua      # first install
sudo apt update && sudo apt upgrade  # later updates
```

## How it works

The `.deb` ships the project **source** to `/opt/auxinux-virtua` and a systemd
unit `auxinux-virtua-setup.service`. It deliberately does **not** run `apt-get`
from the maintainer scripts (that would deadlock the dpkg lock). Instead:

- `postinst` picks the mode (`install` on first install, `update` on upgrade),
  writes it to `/run/auxinux-virtua-setup.env`, and starts the setup unit
  **non-blocking**.
- The setup unit waits for the apt lock to free, then runs
  `bash /opt/auxinux-virtua/INSTALL/install.sh [-update]`.

So a `.deb` install/upgrade behaves **exactly** like
`tar xzf release.tar.gz && bash INSTALL/install.sh [mode]` — same Node/Docker
bootstrap, KVM/libvirt stack, systemd services, `vmbr0` bridge and token
generation you already trust.

Watch the provisioning:

```bash
journalctl -fu auxinux-virtua-setup
```

## Build the package

```bash
cd packaging/deb
./build-deb.sh            # auto: Docker on macOS, native dpkg-deb on Debian
# → out/auxinux-virtua_<version>_amd64.deb   (version comes from package.json)
```

## Emergency bootstrap kit when the AuxiNux repo is offline

If the APT repository is unavailable, build a local `.tar.gz` kit containing the
two local packages needed to start a fresh Debian 13 host:

```bash
cd packaging/deb
./build-bootstrap-kit.sh --build --docker
# → out/virtua-bootstrap_<version>_amd64.tar.gz
```

Copy the archive to the new physical Debian 13 server:

```bash
tar xzf virtua-bootstrap_<version>_amd64.tar.gz
cd virtua-bootstrap_<version>_amd64
sudo bash bootstrap-local.sh
```

This bypasses the AuxiNux repo only for the initial install. The server still
needs access to Debian/NodeSource/Docker repositories while Virtua provisions
KVM/libvirt, Docker, LXC and the system services.

## Publish / refresh the repo

```bash
cd packaging/deb
GPG_KEY_ID=<your-signing-key> ./publish-repo.sh
# → repo/VIRTUA/  (Packages, Release, InRelease, Release.gpg, public key, *.deb)

# Upload to the web root behind dep.auxinux.ca:
rsync -av --delete repo/VIRTUA/ user@dep.auxinux.ca:/var/www/dep.auxinux.ca/VIRTUA/
```

The `repo/VIRTUA/` tree collects the two application packages built in
`packaging/deb/out/`:

- `auxinux-virtua_<version>_amd64.deb`
- `virtuaos-cli_<version>_amd64.deb`

The kernel artifacts are published separately by
`../Kernel/VirtuaOS/build-depot-kernel.sh` under the `/VIRTUA` repository root:

- `KERNEL/*.deb`
- `dists/kernel/...`
- `virtua-archive-keyring.asc` and `virtua-archive-keyring.gpg`

## Prepare a fresh repo server

All public repositories should live under a single web root:

```text
/var/www/dep.auxinux.ca/
```

Bootstrap a fresh Debian 13 LXC with:

```bash
sudo bash packaging/deb/setup-depot-server.sh
```

The script creates:

```text
/var/www/dep.auxinux.ca/VIRTUA/
/var/www/dep.auxinux.ca/VIRTUAOS/
/var/www/dep.auxinux.ca/KERNEL/
/var/www/dep.auxinux.ca/DEBIAN/
/var/www/dep.auxinux.ca/UBUNTU/
/var/www/dep.auxinux.ca/TEMPLATES/
/var/www/dep.auxinux.ca/DOWNLOAD/
/var/www/dep.auxinux.ca/scripts/
```

## Sync Debian / Ubuntu mirrors

The repo server can also maintain partial Debian and Ubuntu mirrors under:

```text
/var/www/dep.auxinux.ca/DEBIAN/
/var/www/dep.auxinux.ca/UBUNTU/
```

Install the sync script on the repo server:

```bash
sudo install -m 0755 packaging/deb/sync-os-mirrors.sh /usr/local/sbin/auxinux-sync-os-mirrors
sudo /usr/local/sbin/auxinux-sync-os-mirrors
```

Defaults are intentionally scoped for speed and disk usage:

```text
Debian: trixie, trixie-updates, trixie-security
Ubuntu: resolute, resolute-updates, resolute-security
Architectures: amd64
Sources: disabled
```

Override with environment variables such as `ARCHES`, `DEBIAN_SUITES`,
`UBUNTU_CODENAME`, `UBUNTU_SUITES`, or `DEPOT_ROOT`.

On a configured repo server, systemd runs the sync every 6 hours:

```bash
systemctl status auxinux-depot-sync.timer
journalctl -fu auxinux-depot-sync.service
```

## Public helper scripts

The repo server also exposes helper scripts at:

```text
https://dep.auxinux.ca/scripts/
```

Each script has metadata comments:

```bash
#NAME=Human readable name
#DESC=Short description
```

Current shared links:

```text
Debian 13:    https://dep.auxinux.ca/scripts/?highlight=install-auxinux-sources-DEB.sh
Ubuntu 26.04: https://dep.auxinux.ca/scripts/?highlight=install-auxinux-sources-UB.sh
VIRTUA:       https://dep.auxinux.ca/scripts/?highlight=install-auxinux-sources-VIRTUA.sh
KERNEL:       https://dep.auxinux.ca/scripts/?highlight=install-auxinux-sources-KERNEL.sh
```

The scripts install APT sources only. They use the same public key published by
`/VIRTUA/` for both the VIRTUA and KERNEL suites, back up existing APT source
files when relevant, write an AuxiNux `.sources` file, then run
`apt-get update`.

## Client setup (each Debian 13 server) — modern deb822

The repo is a proper suite/component repository (`dists/` + `pool/`), consumed
via a single self-contained **deb822** `.sources` file (signing key inlined):

```bash
sudo curl -fsSL https://dep.auxinux.ca/VIRTUA/virtua.sources \
  -o /etc/apt/sources.list.d/virtua.sources
sudo apt update && sudo apt install auxinux-virtua
```

`auxinux.sources` looks like:

```
Types: deb
URIs: https://dep.auxinux.ca/VIRTUA
Suites: trixie
Components: main
Architectures: amd64
Signed-By:
 -----BEGIN PGP PUBLIC KEY BLOCK-----
 …(inlined public key)…
 -----END PGP PUBLIC KEY BLOCK-----
```

Alternative (keyring file instead of inlined key):

```
Types: deb
URIs: https://dep.auxinux.ca/VIRTUA
Suites: trixie
Components: main
Architectures: amd64
Signed-By: /usr/share/keyrings/auxinux-archive-keyring.gpg
```

## Releasing a new version

1. Bump `version` in the root `package.json`.
2. `./build-deb.sh` → new `out/*.deb`.
3. `GPG_KEY_ID=… ./publish-repo.sh` → regenerates signed metadata.
4. Upload `repo/VIRTUA/`.
5. Clients get it via `apt update && apt upgrade` (runs `install.sh -update`).

## Notes

- `apt purge auxinux-virtua` removes panel data (`/var/lib/auxinuxvirtual`) and
  the service user; guest VMs/LXC/Docker are never touched.
- `apt remove` keeps data, only stops/removes the panel services.
- The signing key is yours; generate one with `gpg --full-generate-key` and use
  its id/email as `GPG_KEY_ID`.
