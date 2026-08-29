import { useEffect, useState } from "react";
import type { VdmNode, VdmSharedStorage } from "@/types/vdm";

// ── Icon ────────────────────────────────────────────────────────────────────
function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

const ICONS = {
  info: "m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z",
};

// ── Migrate Modal (VM/LXC) ─────────────────────────────────────────────────
export function MigrateModal({ open, onClose, resourceType, resourceName, sourceNode, nodes, storages, onSubmit }: {
  open: boolean; onClose: () => void; resourceType: string; resourceName: string;
  sourceNode: string; nodes: VdmNode[]; storages: VdmSharedStorage[];
  onSubmit: (targetNode: string, sharedStorageName: string | undefined, targetStoragePool: string | undefined, deleteSource: boolean) => void;
}) {
  const [targetNode, setTargetNode] = useState("");
  const [mode, setMode] = useState<"shared" | "local">("shared");
  const [storName, setStorName] = useState("");
  const [deleteSource, setDeleteSource] = useState(true);

  useEffect(() => { if (open) { setTargetNode(""); setStorName(""); setMode("shared"); setDeleteSource(true); } }, [open]);

  if (!open) return null;
  const canSubmit = targetNode && (mode === "local" ? true : !!storName);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Migrate {resourceType}: {resourceName}</h3>
        <div>
          <label className="vdm-label">Target Node</label>
          <select className="vdm-input" value={targetNode} onChange={(e) => setTargetNode(e.target.value)}>
            <option value="">Select node...</option>
            {nodes.filter((n) => n.name !== sourceNode && n.status === "online").map((n) => (
              <option key={n.name} value={n.name}>{n.displayName}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="vdm-label">Transfer method</label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setMode("shared")}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${mode === "shared" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
              Shared storage
            </button>
            <button type="button" onClick={() => setMode("local")}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${mode === "local" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
              Local copy (direct)
            </button>
          </div>
        </div>

        {mode === "shared" ? (
          <div>
            <label className="vdm-label">Shared Storage (for migration data)</label>
            <select className="vdm-input" value={storName} onChange={(e) => setStorName(e.target.value)}>
              <option value="">Select shared storage...</option>
              {storages.map((s) => <option key={s.name} value={s.name}>{s.displayName} ({s.type}: {s.source})</option>)}
            </select>
            {storages.length === 0 && <p className="text-xs text-vdm-danger mt-1">⚠ No shared storage configured. Use "Local copy" instead.</p>}
          </div>
        ) : (
          <p className="text-xs text-vdm-textMuted bg-vdm-accent/8 border border-vdm-accent/25 rounded px-3 py-2">
            Copies the {resourceType} data directly to the target node's <span className="font-mono">local</span> storage pool (streamed node-to-node, no shared storage required).
          </p>
        )}

        <label className="flex items-center gap-2 text-sm text-vdm-text cursor-pointer">
          <input type="checkbox" checked={deleteSource} onChange={(e) => setDeleteSource(e.target.checked)} className="rounded" />
          Delete from source after migration
        </label>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" onClick={() => { if (canSubmit) { onSubmit(targetNode, mode === "shared" ? storName : undefined, mode === "local" ? "local" : undefined, deleteSource); onClose(); } }} disabled={!canSubmit}>
            Start Migration
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Clone Modal (VM) — node + storage target ──────────────────────────────
export function CloneModal({ open, onClose, resourceType, resourceName, sourceNode, nodes, storages, onSubmit }: {
  open: boolean; onClose: () => void; resourceType: string; resourceName: string; sourceNode: string;
  nodes: VdmNode[]; storages: VdmSharedStorage[];
  onSubmit: (newName: string, targetNode: string, targetStoragePool: string | undefined, sharedStorageName: string | undefined) => void;
}) {
  const [newName, setNewName] = useState(`${resourceName}-clone`);
  const [targetNode, setTargetNode] = useState(sourceNode);
  const [mode, setMode] = useState<"local" | "shared">("local");
  const [storName, setStorName] = useState("");

  useEffect(() => { if (open) { setNewName(`${resourceName}-clone`); setTargetNode(sourceNode); setMode("local"); setStorName(""); } }, [open, resourceName, sourceNode]);

  if (!open) return null;
  const onlineNodes = nodes.filter((n) => n.status === "online");
  const canSubmit = newName.trim() && targetNode && (mode === "local" || !!storName);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Clone {resourceType}: {resourceName}</h3>
        <div>
          <label className="vdm-label">New Name</label>
          <input className="vdm-input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="clone-name" />
        </div>
        <div>
          <label className="vdm-label">Target Node</label>
          <select className="vdm-input" value={targetNode} onChange={(e) => setTargetNode(e.target.value)}>
            {onlineNodes.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
          </select>
        </div>
        <div>
          <label className="vdm-label">Storage</label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setMode("local")}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${mode === "local" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
              Local storage
            </button>
            <button type="button" onClick={() => setMode("shared")}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${mode === "shared" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
              Shared storage
            </button>
          </div>
        </div>
        {mode === "shared" && (
          <div>
            <label className="vdm-label">Shared Storage</label>
            <select className="vdm-input" value={storName} onChange={(e) => setStorName(e.target.value)}>
              <option value="">Select shared storage...</option>
              {storages.map((s) => <option key={s.name} value={s.name}>{s.displayName} ({s.type})</option>)}
            </select>
            {storages.length === 0 && <p className="text-xs text-vdm-danger mt-1">⚠ No shared storage configured.</p>}
          </div>
        )}
        {mode === "local" && targetNode !== sourceNode && (
          <p className="text-xs text-vdm-textMuted bg-vdm-accent/8 border border-vdm-accent/25 rounded px-3 py-2 flex gap-2 items-start">
            <Icon path={ICONS.info} className="w-3.5 h-3.5 flex-shrink-0 mt-0.5 text-vdm-accent" />
            Cross-node clone via local storage streams the disk node-to-node; a shared storage is only needed if you prefer that path.
          </p>
        )}
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" onClick={() => { if (canSubmit) { onSubmit(newName.trim(), targetNode, mode === "local" ? "local" : undefined, mode === "shared" ? storName : undefined); onClose(); } }} disabled={!canSubmit}>Clone</button>
        </div>
      </div>
    </div>
  );
}

// ── Backup Modal ───────────────────────────────────────────────────────────
export function BackupModal({ open, onClose, resourceName, storages, onSubmit }: {
  open: boolean; onClose: () => void; resourceName: string; storages: VdmSharedStorage[];
  onSubmit: (sharedStorageName: string) => void;
}) {
  const [storName, setStorName] = useState("");
  useEffect(() => { if (open) setStorName(""); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-sm p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">Backup: {resourceName}</h3>
        <div>
          <label className="vdm-label">Destination (Shared Storage)</label>
          <select className="vdm-input" value={storName} onChange={(e) => setStorName(e.target.value)}>
            <option value="">Select shared storage...</option>
            {storages.map((s) => <option key={s.name} value={s.name}>{s.displayName} ({s.source})</option>)}
          </select>
          {storages.length === 0 && <p className="text-xs text-vdm-danger mt-1">⚠ No shared storage configured.</p>}
        </div>
        <div className="flex gap-2 justify-end">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="vdm-btn-primary" onClick={() => { if (storName) { onSubmit(storName); onClose(); } }} disabled={!storName}>
            Start Backup
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Docker Transfer Modal (migrate / duplicate) ───────────────────────────
export function DockerTransferModal({ open, onClose, mode, currentName, sourceNode, nodes, storages, onSubmit }: {
  open: boolean; onClose: () => void; mode: "migrate" | "duplicate"; currentName: string; sourceNode: string;
  nodes: VdmNode[]; storages: VdmSharedStorage[];
  onSubmit: (payload: { targetNode: string; targetName: string; sharedStorageName?: string; targetStoragePool?: string; deleteSource: boolean }) => void;
}) {
  const [targetNode, setTargetNode] = useState("");
  const [targetName, setTargetName] = useState(mode === "migrate" ? currentName : `${currentName}-copy`);
  const [transferMode, setTransferMode] = useState<"shared" | "local">("local");
  const [storageName, setStorageName] = useState("");

  useEffect(() => { if (open) { setTargetNode(""); setTargetName(mode === "migrate" ? currentName : `${currentName}-copy`); setTransferMode("local"); setStorageName(""); } }, [open, mode, currentName]);

  if (!open) return null;
  const ready = !!targetNode && !!targetName && (transferMode === "local" || !!storageName);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="vdm-card w-full max-w-md p-5 space-y-4">
        <h3 className="text-base font-semibold text-vdm-text">{mode === "migrate" ? "Migrate" : "Duplicate"} Docker: {currentName}</h3>
        <div><label className="vdm-label">Target Node</label><select className="vdm-input" value={targetNode} onChange={(e) => setTargetNode(e.target.value)}>
          <option value="">Select node...</option>
          {nodes.filter((n) => n.name !== sourceNode && n.status === "online").map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
        </select></div>
        <div><label className="vdm-label">Target container name</label><input className="vdm-input font-mono" value={targetName} disabled={mode === "migrate"} onChange={(e) => setTargetName(e.target.value)} /></div>
        <div><label className="vdm-label">Transfer method</label><div className="grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setTransferMode("local")} className={`rounded-lg border px-3 py-2 text-sm ${transferMode === "local" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted"}`}>Local copy</button>
          <button type="button" onClick={() => setTransferMode("shared")} className={`rounded-lg border px-3 py-2 text-sm ${transferMode === "shared" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted"}`}>Shared storage</button>
        </div></div>
        {transferMode === "shared" && <div><label className="vdm-label">Shared storage</label><select className="vdm-input" value={storageName} onChange={(e) => setStorageName(e.target.value)}>
          <option value="">Select storage...</option>{storages.map((s) => <option key={s.name} value={s.name}>{s.displayName}</option>)}
        </select></div>}
        <p className="text-xs text-vdm-warning bg-vdm-warning/10 border border-vdm-warning/30 rounded px-3 py-2">
          The writable container layer and configuration are preserved. Containers with volumes or bind mounts are refused to prevent silent data loss.
        </p>
        <div className="flex justify-end gap-2"><button className="vdm-btn-ghost" onClick={onClose}>Cancel</button><button className="vdm-btn-primary" disabled={!ready} onClick={() => {
          if (!ready) return;
          onSubmit({ targetNode, targetName, sharedStorageName: transferMode === "shared" ? storageName : undefined, targetStoragePool: transferMode === "local" ? "local" : undefined, deleteSource: mode === "migrate" });
          onClose();
        }}>{mode === "migrate" ? "Start Migration" : "Start Duplication"}</button></div>
      </div>
    </div>
  );
}
