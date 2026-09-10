import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useVdmAuth } from "@/hooks/useVdmAuth";

type MetaType = "vms" | "lxc" | "docker";

/** Name rules enforced by the node before it touches libvirt / lxc / docker. */
const NAME_PATTERN: Record<MetaType, RegExp> = {
  vms: /^[a-zA-Z][a-zA-Z0-9_.-]{0,62}$/,
  lxc: /^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/,
  docker: /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/,
};

const RENAME_HINT: Record<MetaType, string> = {
  vms: "The VM must be stopped. Snapshots, backups, ACLs and firewall rules follow the new name.",
  lxc: "The container must be stopped. Its internal hostname is synchronized with the new name.",
  docker: "Works even while running. The container id is unchanged, so notes and permissions are kept.",
};

/**
 * Notes, display name and rename for one machine, relayed to its owning node.
 * Mirrors what the per-node web UI offers so an operator doesn't have to leave
 * the datacenter view to annotate or relabel a machine.
 */
export function ResourceMetaPanel({ type, node, resourceKey, realName, className = "" }: {
  type: MetaType;
  node: string;
  /** vms/lxc: name ; docker: container id */
  resourceKey: string;
  realName: string;
  className?: string;
}) {
  const qc = useQueryClient();
  const { isAdmin } = useVdmAuth();
  const base = `/api/vdm/${type}/${encodeURIComponent(node)}/${encodeURIComponent(resourceKey)}`;

  const notesQuery = useQuery<{ notes: string }>({
    queryKey: ["vdm-notes", type, node, resourceKey],
    queryFn: () => api.get(`${base}/notes`),
  });
  const displayQuery = useQuery<{ displayName: string }>({
    queryKey: ["vdm-display-name", type, node, resourceKey],
    queryFn: () => api.get(`${base}/display-name`),
  });

  const [notesDraft, setNotesDraft] = useState("");
  const [editingNotes, setEditingNotes] = useState(false);
  useEffect(() => { if (!editingNotes) setNotesDraft(notesQuery.data?.notes ?? ""); }, [notesQuery.data, editingNotes]);

  // A real rename writes display_name = the new name, so an override equal to
  // the real name carries no information — treat it as "no override".
  const storedDisplay = displayQuery.data?.displayName?.trim() ?? "";
  const currentDisplay = storedDisplay === realName ? "" : storedDisplay;

  const [displayDraft, setDisplayDraft] = useState("");
  const [editingDisplay, setEditingDisplay] = useState(false);
  useEffect(() => { if (!editingDisplay) setDisplayDraft(currentDisplay); }, [currentDisplay, editingDisplay]);

  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(realName);
  const [error, setError] = useState("");

  const saveNotes = useMutation({
    mutationFn: () => api.put(`${base}/notes`, { notes: notesDraft }),
    onSuccess: () => { setEditingNotes(false); void qc.invalidateQueries({ queryKey: ["vdm-notes", type, node, resourceKey] }); },
    onError: (e: Error) => setError(e.message),
  });

  const saveDisplay = useMutation({
    mutationFn: (value: string) => api.put(`${base}/display-name`, { displayName: value }),
    onSuccess: () => {
      setEditingDisplay(false);
      void qc.invalidateQueries({ queryKey: ["vdm-display-name", type, node, resourceKey] });
      void qc.invalidateQueries({ queryKey: ["vdm-inventory"] });
    },
    onError: (e: Error) => setError(e.message),
  });

  const rename = useMutation({
    mutationFn: (newName: string) => api.post<{ ok: boolean; key: string; name: string }>(`${base}/rename`, { newName }),
    onSuccess: () => {
      setRenaming(false);
      // vms/lxc change their key, so drop every cached view of this machine.
      void qc.invalidateQueries();
    },
    onError: (e: Error) => setError(e.message),
  });

  const trimmedRename = renameDraft.trim();
  const renameValid = NAME_PATTERN[type].test(trimmedRename) && trimmedRename !== realName;

  return (
    <div className={`vdm-card p-4 space-y-4 ${className}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-vdm-textMuted">Identity &amp; Notes</h3>
        {isAdmin && !renaming && (
          <button className="vdm-btn-ghost text-xs" onClick={() => { setError(""); setRenameDraft(realName); setRenaming(true); }}>Rename</button>
        )}
      </div>

      {renaming && (
        <div className="space-y-2 rounded border border-vdm-border p-3">
          <p className="text-xs text-vdm-textMuted">{RENAME_HINT[type]}</p>
          <input className="vdm-input" value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} placeholder={realName} autoFocus />
          <div className="flex gap-2">
            <button className="vdm-btn-primary text-xs" disabled={!renameValid || rename.isPending} onClick={() => { setError(""); rename.mutate(trimmedRename); }}>
              {rename.isPending ? "Renaming…" : "Rename"}
            </button>
            <button className="vdm-btn-ghost text-xs" onClick={() => { setRenaming(false); setError(""); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Display name */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="vdm-label">Display name</span>
          {isAdmin && !editingDisplay && (
            <button className="vdm-btn-ghost text-xs" onClick={() => { setError(""); setEditingDisplay(true); }}>Edit</button>
          )}
        </div>
        {editingDisplay ? (
          <>
            <input className="vdm-input" value={displayDraft} onChange={(e) => setDisplayDraft(e.target.value)} placeholder={realName} maxLength={120} />
            <p className="text-xs text-vdm-textMuted/70">Label shown in Virtua only — the real name stays <span className="font-mono">{realName}</span>.</p>
            <div className="flex gap-2 pt-1">
              <button className="vdm-btn-primary text-xs" disabled={saveDisplay.isPending} onClick={() => { setError(""); saveDisplay.mutate(displayDraft.trim()); }}>
                {saveDisplay.isPending ? "Saving…" : "Save"}
              </button>
              <button className="vdm-btn-ghost text-xs" onClick={() => { setEditingDisplay(false); setDisplayDraft(currentDisplay); }}>Cancel</button>
              {currentDisplay && (
                <button className="vdm-btn-ghost text-xs" disabled={saveDisplay.isPending} onClick={() => { setDisplayDraft(""); saveDisplay.mutate(""); }}>Reset</button>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-vdm-text">
            {currentDisplay
              ? <>{currentDisplay} <span className="font-mono text-xs text-vdm-textMuted">({realName})</span></>
              : <span className="text-vdm-textMuted italic">None — the real name is used</span>}
          </p>
        )}
      </div>

      {/* Notes */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <span className="vdm-label">Notes</span>
          {isAdmin && !editingNotes && (
            <button className="vdm-btn-ghost text-xs" onClick={() => { setError(""); setEditingNotes(true); }}>Edit</button>
          )}
        </div>
        {editingNotes ? (
          <>
            <textarea className="vdm-input min-h-[120px] resize-y" value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} maxLength={4000} placeholder="Add notes for this machine…" />
            <div className="flex gap-2 pt-1">
              <button className="vdm-btn-primary text-xs" disabled={saveNotes.isPending} onClick={() => { setError(""); saveNotes.mutate(); }}>
                {saveNotes.isPending ? "Saving…" : "Save"}
              </button>
              <button className="vdm-btn-ghost text-xs" onClick={() => { setEditingNotes(false); setNotesDraft(notesQuery.data?.notes ?? ""); }}>Cancel</button>
            </div>
          </>
        ) : (
          <p className="whitespace-pre-wrap text-sm text-vdm-text min-h-[1.5rem]">
            {notesQuery.data?.notes?.trim() ? notesQuery.data.notes : <span className="text-vdm-textMuted italic">No notes</span>}
          </p>
        )}
      </div>

      {error && <p className="text-xs text-vdm-danger">{error}</p>}
    </div>
  );
}
