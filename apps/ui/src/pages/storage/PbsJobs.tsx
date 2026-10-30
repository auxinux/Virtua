import React, { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiDelete, apiGet, apiPost, apiPut } from "../../api/client";
import { ConfirmModal, Modal } from "../../components/ui/Modal";
import { formatDate } from "../../utils/formatBytes";

type Remote = { id: number; name: string; datastore: string };

type Selection = "all" | string[];

type PbsJob = {
  id: number;
  name: string;
  remoteId: number;
  targets: { vms: Selection; cts: Selection };
  days: string;
  time: string;
  keepLast?: number;
  keepDaily?: number;
  keepWeekly?: number;
  keepMonthly?: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastMessage: string | null;
};

// JS weekday digits (0 = Sunday), shown Monday first.
const DAYS: Array<[string, string]> = [["1", "Mon"], ["2", "Tue"], ["3", "Wed"], ["4", "Thu"], ["5", "Fri"], ["6", "Sat"], ["0", "Sun"]];

function describeSelection(sel: Selection, noun: string) {
  if (sel === "all") return `all ${noun}s`;
  return sel.length ? sel.join(", ") : "";
}

function describeDays(days: string) {
  if (days.length === 7) return "Every day";
  if (days === "12345") return "Mon–Fri";
  return DAYS.filter(([d]) => days.includes(d)).map(([, l]) => l).join(", ");
}

export default function PbsJobs({ remotes }: { remotes: Remote[] }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PbsJob | "new" | null>(null);
  const [deleting, setDeleting] = useState<PbsJob | null>(null);

  const { data: jobs = [] } = useQuery<PbsJob[]>({
    queryKey: ["pbs", "jobs"],
    queryFn: () => apiGet("/api/pbs/jobs"),
    refetchInterval: 10_000,
  });

  const runJob = useMutation({
    mutationFn: (id: number) => apiPost(`/api/pbs/jobs/${id}/run`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pbs", "jobs"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
  });

  const deleteJob = useMutation({
    mutationFn: (id: number) => apiDelete(`/api/pbs/jobs/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["pbs", "jobs"] });
      setDeleting(null);
    },
  });

  const remoteName = (id: number) => remotes.find((r) => r.id === id)?.name ?? "?";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-text-200">Scheduled backups to PBS</h3>
          <p className="text-xs text-text-500">Guests are backed up one at a time, in Proxmox VE format (restorable by Virtua and by Proxmox VE). Retention is applied after each backup.</p>
        </div>
        <button onClick={() => setEditing("new")} className="btn-secondary btn-sm">New job</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-surface-600/50">
            <tr className="text-left text-xs text-text-500 uppercase tracking-wider">
              <th className="px-4 py-2">Job</th>
              <th className="px-4 py-2">Guests</th>
              <th className="px-4 py-2">Schedule</th>
              <th className="px-4 py-2">PBS</th>
              <th className="px-4 py-2">Last run</th>
              <th className="px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-600">
            {jobs.map((job) => (
              <tr key={job.id} className="hover:bg-surface-600/20">
                <td className="px-4 py-2 text-text-200">
                  {job.name}
                  {!job.enabled && <span className="ml-2 text-xs text-text-500">disabled</span>}
                </td>
                <td className="px-4 py-2 text-text-400">
                  {[describeSelection(job.targets.vms, "VM"), describeSelection(job.targets.cts, "container")].filter(Boolean).join(" + ")}
                </td>
                <td className="px-4 py-2 text-text-400">{describeDays(job.days)} at {job.time}</td>
                <td className="px-4 py-2 text-text-400">{remoteName(job.remoteId)}</td>
                <td className="px-4 py-2 text-text-400" title={job.lastMessage ?? undefined}>
                  {job.lastRunAt ? formatDate(job.lastRunAt) : "never"}
                  {job.lastStatus && (
                    <span className={`ml-2 text-xs ${job.lastStatus === "ok" ? "text-green-400" : job.lastStatus === "running" ? "text-accent-blue-light" : job.lastStatus === "partial" ? "text-amber-300" : "text-red-400"}`}>
                      {job.lastStatus}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => runJob.mutate(job.id)} disabled={job.lastStatus === "running"} className="btn-secondary btn-sm">Run now</button>
                    <button onClick={() => setEditing(job)} className="btn-secondary btn-sm">Edit</button>
                    <button onClick={() => setDeleting(job)} className="btn-danger btn-sm">Delete</button>
                  </div>
                </td>
              </tr>
            ))}
            {jobs.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-text-500">No scheduled backup yet</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <JobModal job={editing} remotes={remotes} onClose={() => setEditing(null)} onSaved={() => {
        qc.invalidateQueries({ queryKey: ["pbs", "jobs"] });
        setEditing(null);
      }} />

      <ConfirmModal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && deleteJob.mutate(deleting.id)}
        loading={deleteJob.isPending}
        dangerous
        title="Delete backup job"
        message={deleting ? `Delete job ${deleting.name}? Backups already on the PBS are kept.` : ""}
        confirmLabel="Delete"
      />
    </div>
  );
}

function GuestPicker({ label, all, value, onChange }: {
  label: string;
  all: string[];
  value: Selection;
  onChange: (v: Selection) => void;
}) {
  const selected = value === "all" ? [] : value;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-3">
        <span className="label mb-0">{label}</span>
        <label className="flex items-center gap-1 text-sm text-text-300 cursor-pointer">
          <input type="radio" checked={value === "all"} onChange={() => onChange("all")} /> All (incl. future ones)
        </label>
        <label className="flex items-center gap-1 text-sm text-text-300 cursor-pointer">
          <input type="radio" checked={value !== "all"} onChange={() => onChange([])} /> Selected
        </label>
      </div>
      {value !== "all" && (
        <div className="flex flex-wrap gap-2 rounded-md border border-surface-600 p-2 max-h-32 overflow-y-auto">
          {all.length === 0 && <span className="text-xs text-text-500">None on this node</span>}
          {all.map((name) => (
            <label key={name} className="flex items-center gap-1 text-sm text-text-300 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(name)}
                onChange={(e) => onChange(e.target.checked ? [...selected, name] : selected.filter((n) => n !== name))}
              />
              {name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function JobModal({ job, remotes, onClose, onSaved }: {
  job: PbsJob | "new" | null;
  remotes: Remote[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const isNew = job === "new";
  const empty = { name: "Nightly backup", remoteId: remotes[0]?.id ?? 0, vms: "all" as Selection, cts: "all" as Selection, days: "0123456", time: "02:00", keepLast: "", keepDaily: "7", keepWeekly: "4", keepMonthly: "3", enabled: true };
  const [form, setForm] = useState(empty);
  const [error, setError] = useState("");

  const { data: vms = [] } = useQuery<Array<{ name: string }>>({ queryKey: ["vms"], queryFn: () => apiGet("/api/vms"), enabled: !!job });
  const { data: cts = [] } = useQuery<Array<{ name: string }>>({ queryKey: ["lxc"], queryFn: () => apiGet("/api/lxc"), enabled: !!job });

  React.useEffect(() => {
    if (!job) return;
    setError("");
    if (job === "new") {
      setForm({ ...empty, remoteId: remotes[0]?.id ?? 0 });
      return;
    }
    const s = (n?: number) => (n ? String(n) : "");
    setForm({
      name: job.name,
      remoteId: job.remoteId,
      vms: job.targets.vms,
      cts: job.targets.cts,
      days: job.days,
      time: job.time,
      keepLast: s(job.keepLast),
      keepDaily: s(job.keepDaily),
      keepWeekly: s(job.keepWeekly),
      keepMonthly: s(job.keepMonthly),
      enabled: job.enabled,
    });
  }, [job]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name,
        remoteId: form.remoteId,
        targets: { vms: form.vms, cts: form.cts },
        days: form.days,
        time: form.time,
        keepLast: Number(form.keepLast) || undefined,
        keepDaily: Number(form.keepDaily) || undefined,
        keepWeekly: Number(form.keepWeekly) || undefined,
        keepMonthly: Number(form.keepMonthly) || undefined,
        enabled: form.enabled,
      };
      return isNew || !job ? apiPost("/api/pbs/jobs", body) : apiPut(`/api/pbs/jobs/${job.id}`, body);
    },
    onSuccess: onSaved,
    onError: (err: Error) => setError(err.message),
  });

  const toggleDay = (d: string) => setForm((f) => ({ ...f, days: f.days.includes(d) ? f.days.replace(d, "") : f.days + d }));
  const keepInput = (key: "keepLast" | "keepDaily" | "keepWeekly" | "keepMonthly", label: string) => (
    <div>
      <label className="label">{label}</label>
      <input type="number" min={0} value={form[key]} onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} className="input" placeholder="—" />
    </div>
  );

  return (
    <Modal
      open={!!job}
      onClose={onClose}
      size="lg"
      title={isNew ? "New PBS backup job" : "Edit PBS backup job"}
      footer={
        <>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name || !form.remoteId} className="btn-primary">
            {save.isPending ? "Saving..." : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Job name</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="input" />
          </div>
          <div>
            <label className="label">Destination PBS</label>
            <select value={form.remoteId} onChange={(e) => setForm((f) => ({ ...f, remoteId: Number(e.target.value) }))} className="select">
              {remotes.map((r) => <option key={r.id} value={r.id}>{r.name} — {r.datastore}</option>)}
            </select>
          </div>
        </div>

        <GuestPicker label="VMs" all={vms.map((v) => v.name)} value={form.vms} onChange={(v) => setForm((f) => ({ ...f, vms: v }))} />
        <GuestPicker label="Containers" all={cts.map((c) => c.name)} value={form.cts} onChange={(v) => setForm((f) => ({ ...f, cts: v }))} />

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label">Days</label>
            <div className="flex gap-1">
              {DAYS.map(([d, l]) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleDay(d)}
                  className={`rounded-md border px-2 py-1 text-xs ${form.days.includes(d) ? "border-accent-blue bg-accent-blue/10 text-text-100" : "border-surface-600 text-text-500"}`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="label">Time (server)</label>
            <input type="time" value={form.time} onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))} className="input w-32" />
          </div>
        </div>

        <div>
          <div className="label">Retention (per guest, empty = no limit)</div>
          <div className="grid grid-cols-4 gap-3">
            {keepInput("keepLast", "Last")}
            {keepInput("keepDaily", "Daily")}
            {keepInput("keepWeekly", "Weekly")}
            {keepInput("keepMonthly", "Monthly")}
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="w-4 h-4" checked={form.enabled} onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))} />
          <span className="text-sm text-text-300">Enabled</span>
        </label>
        <p className="text-xs text-text-500">
          The PBS token needs the DatastoreBackup role (DatastorePowerUser to also restore Proxmox VE backups made by other users).
        </p>
        {error && <div className="text-sm text-red-400">{error}</div>}
      </div>
    </Modal>
  );
}
