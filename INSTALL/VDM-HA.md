# VDM high availability for Virtua 0.7.32

HA is managed with `vos` or from **VDM → Settings → High Availability**:

```bash
sudo VDM_HA_LXC_PATH=/srv/virtua-ha/lxc vos vdm ha enable
sudo vos vdm movenode node2
sudo vos vdm ha status
sudo vos vdm ha disable
```

Activation is refused unless Pacemaker has at least two members, quorum,
STONITH/fencing, root SSH between members, and the same supported cluster
filesystem mounted on every member. NFS/CIFS are rejected for the VDM database.

VDM supports application roles through these variables:

```ini
AUXINUX_VDM_CLUSTER_ID=production
AUXINUX_VDM_INSTANCE_ID=vdm-01
AUXINUX_VDM_ROLE=active
```

Only the `active` instance accepts mutating requests. A `standby` instance remains read-only and reports its role through `/api/vdm/health`.

## Supported production topology

Use one movable VDM LXC protected by the integrated Pacemaker resource agent:

1. Store the complete VDM LXC on replicated block storage.
2. Use Corosync/Pacemaker or an equivalent Virtua infrastructure service for quorum and fencing.
3. Start the LXC on exactly one node at a time.
4. Move a virtual IP with the LXC.
5. Fence the failed primary before starting the LXC elsewhere.
6. Keep `/var/lib/auxinux-vdm` on the movable block volume.
7. Verify `/api/vdm/health` before advertising the virtual IP.

SQLite must not be placed directly on NFS and must never be opened by two active VDM processes. The current HA model is active/passive LXC failover, not active/active application clustering.

## Required failover checks

- quorum is present;
- failed node is fenced;
- replicated block volume is promoted on the target;
- VDM LXC starts successfully;
- `/api/vdm/health` returns the expected cluster and active role;
- interrupted tasks appear as `recovery-required`;
- virtual IP is announced only after the healthcheck succeeds.

Pacemaker performs the move after a host failure. Quorum and fencing prevent
split-brain before the LXC is started elsewhere.
