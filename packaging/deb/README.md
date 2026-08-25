# AuxiNux Virtua — Debian packaging (`.deb` + APT repo)

Distribute AuxiNux Virtua as a `.deb` served from an APT repository so clients
install and update with plain apt:

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

## Publish / refresh the repo

```bash
cd packaging/deb
GPG_KEY_ID=<your-signing-key> ./publish-repo.sh
# → repo/VIRTUA/  (Packages, Release, InRelease, Release.gpg, public key, *.deb)
```

The `repo/VIRTUA/` tree collects the application packages built in
`packaging/deb/out/`:

- `auxinux-virtua_<version>_amd64.deb`
- `virtuaos-cli_<version>_amd64.deb`

The kernel artifacts are published separately by
`../Kernel/VirtuaOS/build-depot-kernel.sh` under the `/VIRTUA` repository root:

- `KERNEL/*.deb`
- `dists/kernel/...`
- `virtua-archive-keyring.asc` and `virtua-archive-keyring.gpg`

## Client setup (each Debian 13 server) — modern deb822

The repo is a proper suite/component repository (`dists/` + `pool/`), consumed
via a single self-contained **deb822** `.sources` file (signing key inlined):

```bash
sudo curl -fsSL https://dep.auxinux.ca/VIRTUA/virtua.sources \
  -o /etc/apt/sources.list.d/virtua.sources
sudo apt update && sudo apt install auxinux-virtua
```

`virtua.sources` looks like:

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
4. Upload `repo/VIRTUA/` to your web root.
5. Clients get it via `apt update && apt upgrade` (runs `install.sh -update`).

## Notes

- `apt purge auxinux-virtua` removes panel data (`/var/lib/auxinuxvirtual`) and
  the service user; guest VMs/LXC/Docker are never touched.
- `apt remove` keeps data, only stops/removes the panel services.
- The signing key is yours; generate one with `gpg --full-generate-key` and use
  its id/email as `GPG_KEY_ID`.
