# 🚀 VDM (Virtua Datacenter Manager) Installation & Deployment

VDM is a **vSphere-like centralized management interface** for AuxiNux nodes. It runs as an **independent LXC service** on an AuxiNux host and manages VMs, LXC containers, and Docker instances across multiple nodes via their APIs.

## 📋 Quick Facts

- **Port**: `8440` (HTTP frontend + API)
- **Type**: Systemd service in LXC container
- **Database**: SQLite3 (`/var/lib/auxinux-vdm/vdm.sqlite`)
- **Auth**: Session-based with CSRF protection
- **Default Credentials**: `admin` / `admin123` (password change is required on first login)
- **Compatible Virtua version**: `0.7.32` or newer
- **Network policy**: Host and nodes must use stable IPs (static IP or DHCP reservation)

---

## 🔧 Development Setup

### Prerequisites
- Node.js 22+
- npm workspace support

### Quick Start (Dev Mode)

```bash
# Depuis la racine du projet
npm install

# Start VDM backend + frontend together
npm run dev:vdm
```

This starts:
- **Backend**: Port `3002` (`http://localhost:3002`)
- **Frontend**: Port `5174` (`http://localhost:5174`)

### Separate Development Terminals

```bash
# Terminal 1 — Backend (port 3002)
npm run dev:vdm-backend

# Terminal 2 — Frontend (port 5174)
npm run dev:vdm-ui
```

### Access in Development
- Open browser: `http://localhost:5174`
- Login: `admin` / `admin123`

---

## 🐳 Production Deployment (One-Shot LXC Provisioning)

### Native VirtuaOS commands

The VDM payload is included with Virtua/VirtuaOS. A separate upload is no
longer required on an up-to-date host:

```bash
sudo vos vdm install
sudo vos vdm status
sudo vos vdm update
sudo vos vdm movenode node2
sudo vos vdm uninstall
```

Only one VDM is allowed per datacenter. Installation checks and locks every
known node; an unreachable or unverifiable node blocks installation.

### Step 1: Create Installation Archive (standalone deployment)

From your development machine:

```bash
# Depuis la racine du projet
bash INSTALL/release.sh -vdm
```

This generates `auxinux-vdm-v<VERSION>.tar.gz`.

### Step 2: Deploy to AuxiNux Node

Upload `auxinux-vdm-v<VERSION>.tar.gz` to the target AuxiNux host, then:

```bash
cd /tmp
tar -xzf auxinux-vdm-v<VDM_VERSION>.tar.gz

# Run installation script on host with root/sudo
sudo bash auxinux-vdm/INSTALL/vdm-install.sh
```

#### Installation Modes

```bash
# Default: Install + preserve existing data
sudo bash auxinux-vdm/INSTALL/vdm-install.sh

# Update: Rebuild app, preserve data
sudo bash auxinux-vdm/INSTALL/vdm-install.sh -update

# Repair: Clean runtime, preserve db
sudo bash auxinux-vdm/INSTALL/vdm-install.sh -repair

# Reset: Recreate LXC + reinstall from scratch
sudo bash auxinux-vdm/INSTALL/vdm-install.sh -reset

# Help
sudo bash auxinux-vdm/INSTALL/vdm-install.sh -h
```

### What the Installer Does

✅ Validates host prerequisites (LXC/debootstrap/network tools)
✅ Proposes installing/configuring missing prerequisites automatically
✅ Validates stable IP policy for host (static or DHCP reservation)
✅ Creates a Debian 13 LXC (`auxinux-vdm` by default)
✅ Configures LXC network + host boot autostart
✅ Validates stable IP policy for LXC (static or DHCP reservation)
✅ Updates Debian in the LXC and installs all VDM dependencies
✅ Runs an interactive wizard:
- Datacenter name
- Admin username/password
- Host node as Node 1 (API URL + auth token)
✅ Builds and configures VDM in the LXC
✅ Enables VDM systemd service in LXC
✅ Configures nftables firewall in LXC (allow 22 and 8440)
✅ Starts VDM service

---

## 🌐 Access VDM After Deployment

### Direct Access
The installer prints the detected LXC IP at the end. Access VDM at:
```
http://<LXC-IP>:8440
```

### Service Management

```bash
# On host: inspect/manage LXC
lxc-info -n auxinux-vdm
lxc-attach -n auxinux-vdm
lxc-stop -n auxinux-vdm
lxc-start -n auxinux-vdm

# Inside LXC: VDM service
systemctl status auxinux-vdm
journalctl -u auxinux-vdm -f
```

---

## 📝 Configuration

### Environment Variables

Create or edit `/etc/auxinux-vdm.env` inside the VDM LXC:

```bash
# Port (default: 8440)
AUXINUX_VDM_PORT=8440

# Data directory (default: /var/lib/auxinux-vdm)
AUXINUX_VDM_DATA_DIR=/var/lib/auxinux-vdm

# Session secret (change in production!)
AUXINUX_VDM_SESSION_SECRET=your-secure-random-string

# Node request reliability
AUXINUX_VDM_NODE_TIMEOUT_MS=15000
AUXINUX_VDM_NODE_RETRIES=1
AUXINUX_VDM_LONG_OPERATION_TIMEOUT_MS=14400000
AUXINUX_VDM_HEARTBEAT_CONCURRENCY=4

# VDM active/standby identity
AUXINUX_VDM_CLUSTER_ID=production
AUXINUX_VDM_INSTANCE_ID=vdm-01
AUXINUX_VDM_ROLE=active
AUXINUX_VDM_MIN_VIRTUA_VERSION=0.7.32
AUXINUX_VDM_ENCRYPTION_KEY=another-secure-random-string

# Set both to 1 only behind a trusted HTTPS reverse proxy
AUXINUX_VDM_SECURE_COOKIE=0
AUXINUX_VDM_TRUST_PROXY=0

# Optional: Override any bootstrap values later in UI settings
```

After editing, restart the service:
```bash
systemctl restart auxinux-vdm
```

### Host Installer Options

```bash
# Static IP for the VDM LXC
sudo bash auxinux-vdm/INSTALL/vdm-install.sh --lxc-ipv4=192.168.1.50/24 --lxc-gateway=192.168.1.1

# Use a different bridge
sudo bash auxinux-vdm/INSTALL/vdm-install.sh --lxc-bridge=vmbr1

# Auto-install host prerequisites (no prompt)
sudo bash auxinux-vdm/INSTALL/vdm-install.sh --auto-install-host-reqs

# Disable firewall provisioning in container
sudo bash auxinux-vdm/INSTALL/vdm-install.sh --no-firewall
```

---

## 🔌 Add AuxiNux Nodes to VDM

Node 1 is pre-added during installation by the wizard.

To add additional nodes:

1. **Open VDM web interface** → `http://node-ip:8440`
2. **Log in** with `admin` / `admin123`, then choose a new password
3. **Navigate to Nodes** section
4. **Click "+ Add Node"**
5. **Enter node details:**
   - **Name**: Unique identifier (e.g., `prod-node-1`)
   - **Display Name**: User-friendly name (e.g., `Production Node 1`)
   - **API URL**: Node's API endpoint (e.g., `http://192.168.1.10:8441`)
   - **Auth Token**: Node's authentication token (from node admin panel)
   - **Notes**: Optional description

6. **Click "Add"**
7. **Verify**: Node status should be "online" within a few seconds

---

## 📊 VDM Features Once Configured

After adding nodes to VDM, you can:

### **Inventory Management**
- View all VMs, LXC containers, and Docker instances across nodes
- Detailed resource information (CPU, RAM, storage, state)
- Live statistics and performance monitoring

### **Resource Operations**
- **Start / Stop / Reboot** VMs, LXC containers, Docker services
- **Clone** (VM/LXC) — create copies with optional name changes
- **Migrate** — move running resources between nodes
- **Backup** — create offline snapshots to shared storage
- **Delete** — safely remove resources

### **Shared Storage Management**
- Add NFS, SMB, CIFS, or GlusterFS network storage
- Mount storage on any node automatically
- Track storage usage and content

### **Task Tracking**
- Real-time monitoring of long-running operations
- Task history and status
- Error tracking and logs

### **User Management**
- Create/edit users (admin or viewer roles)
- Session-based authentication
- Change password

### **Settings**
- System configuration
- User management
- Node management

---

## 🔐 Security Considerations

### Essential for Production

1. **Change default credentials immediately**
   - Access VDM → Settings → Users
   - Change `admin` password

2. **Set strong session secret**
   ```bash
   AUXINUX_VDM_SESSION_SECRET=$(openssl rand -base64 32)
   ```
   Write to `/etc/auxinux-vdm.env` and restart

3. **Use HTTPS in front of VDM**
   - Configure nginx with SSL/TLS certificate
   - Or use a reverse proxy with SSL termination

4. **Restrict network access**
   - Deploy VDM in a private/management network
   - Use firewall rules to limit who can access port 8440
   - Consider VPN for remote access

5. **Audit logs**
   ```bash
   journalctl -u auxinux-vdm --since "1 hour ago"
   ```

---

## 🛠️ Troubleshooting

### VDM Service Won't Start

```bash
# Check logs
journalctl -u auxinux-vdm -n 50

# Verify ports
ss -tlnp | grep 8440

# Ensure data directory exists
ls -la /var/lib/auxinux-vdm/
```

### Can't Connect to Nodes

1. **Verify node API is reachable**
   ```bash
   curl -k https://node-ip:8441/api/health
   ```

2. **Check auth token validity**
   - Token from node must be up-to-date
   - Regenerate if necessary on node admin panel

3. **Check firewall between VDM and nodes**
   ```bash
   telnet node-ip 8441
   ```

### Database Corruption

```bash
# Backup current database
sqlite3 /var/lib/auxinux-vdm/vdm.sqlite ".backup '/var/lib/auxinux-vdm/vdm.sqlite.backup'"

# Verify database integrity
sqlite3 /var/lib/auxinux-vdm/vdm.db "PRAGMA integrity_check;"

# If corrupt, perform reset
sudo INSTALL/vdm-install.sh -reset
```

---

## 📚 Key Directories & Files

| Path | Purpose |
|------|---------|
| `/var/lib/auxinux-vdm/vdm.sqlite` | Main SQLite database |
| `/var/lib/auxinux-vdm/` | All persistent data |
| `/etc/systemd/system/auxinux-vdm.service` | Systemd service file |
| `/etc/auxinux-vdm.env` | Environment configuration |
| `/etc/nginx/sites-available/auxinux-vdm` | nginx reverse proxy config |
| `/opt/auxinux-vdm/` | Installed application files |

---

## 🔄 Updating VDM

```bash
# Create new release
INSTALL/release.sh

# On target node
sudo INSTALL/vdm-install.sh -update
```

The `-update` mode:
- Rebuilds backend + frontend
- Preserves database and user data
- Preserves configuration files
- Restarts service automatically

---

## 📞 Support

For issues or questions:
- Check service logs: `journalctl -u auxinux-vdm -f`
- Review `/etc/auxinux-vdm.env` configuration
- Ensure all nodes are reachable and their APIs are functional
