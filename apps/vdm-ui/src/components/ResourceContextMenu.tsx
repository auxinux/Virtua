import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "@/components/ui/ContextMenu";
import { useConfirm, usePrompt } from "@/hooks/useDialog";
import { MigrateModal, CloneModal, BackupModal, DockerTransferModal } from "@/components/TransferModals";
import type { VdmNode, VdmSharedStorage, VdmTask } from "@/types/vdm";

// ── Icons ───────────────────────────────────────────────────────────────────
const ICONS = {
  power: "M5.636 5.636a9 9 0 1 0 12.728 0M12 3v9",
  stop: "M5.25 7.5A2.25 2.25 0 0 1 7.5 5.25h9a2.25 2.25 0 0 1 2.25 2.25v9a2.25 2.25 0 0 1-2.25 2.25h-9a2.25 2.25 0 0 1-2.25-2.25v-9Z",
  reboot: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99",
  snapshot: "M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z",
  clone: "M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75",
  migrate: "M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5",
  backup: "M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 11.278 3.75 9m16.5 2.625c0 2.278-3.694 4.125-8.25 4.125S3.75 13.903 3.75 11.625",
  trash: "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0",
  open: "M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25",
  console: "M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z",
};

export type ResourceKind = "vm" | "lxc" | "docker";

export interface ResourceMenuTarget {
  kind: ResourceKind;
  node: string;
  name: string; // for docker this is the container id
  displayName: string;
  state: string;
}

/**
 * Right-click context menu for a resource (VM/LXC/Docker), adapted to its
 * state: power actions, snapshot, clone/migrate/backup (with node+storage
 * target modals), console, and delete — all integrated, no native popups.
 */
export function ResourceContextMenu({ menu, onClose }: {
  menu: (ContextMenuState & { resource: ResourceMenuTarget }) | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const { prompt, dialog: promptDialog } = usePrompt();
  const [showMigrate, setShowMigrate] = useState(false);
  const [showClone, setShowClone] = useState(false);
  const [showBackup, setShowBackup] = useState(false);
  const [showTransfer, setShowTransfer] = useState<"migrate" | "duplicate" | null>(null);
  // Remember the last target resource so modals (migrate/clone/backup/transfer)
  // stay mounted after the context menu itself closes. The menu closes on
  // every click (onClose), and without this the modal that was just opened gets
  // unmounted on the same render because `if (!menu) return null` below.
  const [target, setTarget] = useState<ResourceMenuTarget | null>(null);
  if (menu?.resource && menu.resource !== target) {
    setTarget(menu.resource);
  }

  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes") });
  const storagesQuery = useQuery<VdmSharedStorage[]>({ queryKey: ["vdm-storage"], queryFn: () => api.get("/api/vdm/storage") });

  const r = target;

  const base = r ? `/api/vdm/${r.kind === "vm" ? "vms" : r.kind === "lxc" ? "lxc" : "docker"}/${encodeURIComponent(r.node)}/${encodeURIComponent(r.name)}` : "";

  const actionMut = useMutation({
    mutationFn: (action: string) => api.post(`${base}/action`, { action }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-vms-all"] }); qc.invalidateQueries({ queryKey: ["vdm-lxc-all"] }); qc.invalidateQueries({ queryKey: ["vdm-docker-all"] }); },
  });
  const snapshotMut = useMutation({
    mutationFn: (snapName: string) => api.post(`${base}/snapshot`, { snapName }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const deleteMut = useMutation({
    mutationFn: () => api.delete(r?.kind === "docker" ? `/api/vdm/docker/${encodeURIComponent(r!.node)}/${encodeURIComponent(r!.name)}` : `${base}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-vms-all"] }); qc.invalidateQueries({ queryKey: ["vdm-lxc-all"] }); qc.invalidateQueries({ queryKey: ["vdm-docker-all"] }); },
  });
  const migrateMut = useMutation({
    mutationFn: (p: { targetNode: string; sharedStorageName?: string; targetStoragePool?: string; deleteSource: boolean }) =>
      api.post<VdmTask>(`${base}/migrate`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const cloneMut = useMutation({
    mutationFn: (p: { newName: string; targetNode: string; targetStoragePool?: string; sharedStorageName?: string }) =>
      api.post(`${base}/clone`, p),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const backupMut = useMutation({
    mutationFn: (sharedStorageName: string) => api.post(`${base}/backup`, { sharedStorageName }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });
  const dockerTransferMut = useMutation({
    mutationFn: (payload: { targetNode: string; targetName: string; sharedStorageName?: string; targetStoragePool?: string; deleteSource: boolean }) =>
      api.post<VdmTask>(`/api/vdm/docker/${encodeURIComponent(r!.node)}/${encodeURIComponent(r!.name)}/transfer`, payload),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vdm-tasks-recent"] }); navigate("/tasks"); },
  });

  if (!r) return null;

  const isRunning = r.state === "running";
  const href = r.kind === "docker"
    ? `/inventory/docker/${encodeURIComponent(r.node)}/${encodeURIComponent(r.name)}`
    : `/inventory/${r.kind}/${encodeURIComponent(r.node)}/${encodeURIComponent(r.name)}`;

  const entries: ContextMenuEntry[] = [
    { label: "Open details", icon: ICONS.open, onClick: () => navigate(href) },
    { label: "Console", icon: ICONS.console, disabled: !isRunning, onClick: () => navigate(`${href}/console`) },
    { divider: true, label: "", onClick: () => {} },
  ];

  if (!isRunning) {
    entries.push({ label: "Start", icon: ICONS.power, onClick: () => actionMut.mutate("start") });
  } else {
    entries.push({ label: r.kind === "vm" ? "Shutdown" : "Stop", icon: ICONS.stop, onClick: () => actionMut.mutate(r.kind === "vm" ? "shutdown" : "stop") });
    entries.push({ label: r.kind === "vm" ? "Reboot" : "Restart", icon: ICONS.reboot, onClick: () => actionMut.mutate(r.kind === "vm" ? "reboot" : "restart") });
    entries.push({ label: "Force Off", icon: ICONS.stop, danger: true, onClick: async () => {
      if (await confirm({ title: `Force off ${r.displayName}?`, message: "This immediately cuts power. Unsaved data may be lost.", confirmLabel: "Force Off" })) actionMut.mutate("forceStop");
    } });
  }

  if (r.kind !== "docker") {
    entries.push({ divider: true, label: "", onClick: () => {} });
    entries.push({ label: "Snapshot", icon: ICONS.snapshot, onClick: async () => {
      const n = await prompt({ title: "New snapshot", label: "Snapshot name", placeholder: "snapshot-name" });
      if (n) snapshotMut.mutate(n);
    } });
    entries.push({ label: "Clone…", icon: ICONS.clone, onClick: () => setShowClone(true) });
    entries.push({ label: "Migrate…", icon: ICONS.migrate, onClick: () => setShowMigrate(true) });
    entries.push({ label: "Backup…", icon: ICONS.backup, onClick: () => setShowBackup(true) });
  } else {
    entries.push({ divider: true, label: "", onClick: () => {} });
    entries.push({ label: "Duplicate…", icon: ICONS.clone, onClick: () => setShowTransfer("duplicate") });
    entries.push({ label: "Migrate…", icon: ICONS.migrate, onClick: () => setShowTransfer("migrate") });
  }

  entries.push({ divider: true, label: "", onClick: () => {} });
  entries.push({ label: "Delete", icon: ICONS.trash, danger: true, onClick: async () => {
    if (await confirm({ title: `Delete ${r.displayName}?`, message: "This resource will be permanently removed.", confirmLabel: "Delete" })) deleteMut.mutate();
  } });

  return (
    <>
      {menu && <ContextMenu state={{ x: menu.x, y: menu.y, entries }} onClose={onClose} />}
      {confirmDialog}
      {promptDialog}
      {showMigrate && r.kind !== "docker" && (
        <MigrateModal open onClose={() => setShowMigrate(false)} resourceType={r.kind.toUpperCase()} resourceName={r.displayName} sourceNode={r.node}
          nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
          onSubmit={(t, s, p, d) => migrateMut.mutate({ targetNode: t, sharedStorageName: s, targetStoragePool: p, deleteSource: d })} />
      )}
      {showClone && r.kind === "vm" && (
        <CloneModal open onClose={() => setShowClone(false)} resourceType="VM" resourceName={r.displayName} sourceNode={r.node}
          nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
          onSubmit={(n, t, p, s) => cloneMut.mutate({ newName: n, targetNode: t, targetStoragePool: p, sharedStorageName: s })} />
      )}
      {showBackup && r.kind !== "docker" && (
        <BackupModal open onClose={() => setShowBackup(false)} resourceName={r.displayName} storages={storagesQuery.data ?? []}
          onSubmit={(s) => backupMut.mutate(s)} />
      )}
      {showTransfer && r.kind === "docker" && (
        <DockerTransferModal open onClose={() => setShowTransfer(null)} mode={showTransfer} currentName={r.displayName} sourceNode={r.node}
          nodes={nodesQuery.data ?? []} storages={storagesQuery.data ?? []}
          onSubmit={(payload) => dockerTransferMut.mutate(payload)} />
      )}
    </>
  );
}
