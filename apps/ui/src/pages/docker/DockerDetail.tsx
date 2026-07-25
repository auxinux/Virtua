import React, { useState, useRef, useEffect, useMemo } from "react";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost, apiDelete } from "../../api/client";
import { StatusBadge } from "../../components/ui/Badge";
import { MetricBar } from "../../components/ui/MetricBar";
import { NotesCard } from "../../components/NotesCard";
import { LockBadge, LockButton, useResourceLock } from "../../components/LockControl";
import { Tabs } from "../../components/ui/Tabs";
import { ConfirmModal } from "../../components/ui/Modal";
import { Terminal } from "../../components/Terminal";
import { ResourceAclPanel } from "../../components/acl/ResourceAclPanel";
import { formatBytes } from "../../utils/formatBytes";
import { useAuth } from "../../utils/useAuth";
import type { DockerContainerDetail, DockerStats } from "@auxinux/shared";

// ─── Summary Tab ───────────────────────────────────────────────────────────────
function DockerSummaryTab({ ct }: { ct: DockerContainerDetail }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-text-300 mb-3">Container Info</h3>
        <dl className="space-y-2 text-sm">
          {[
            ["ID", ct.id.slice(0, 12)],
            ["Name", ct.name],
            ["Image", ct.image],
            ["State", <StatusBadge key="s" state={ct.state} />],
            ["Created", new Date(ct.createdAt).toLocaleString()],
            ["Restart Policy", ct.restartPolicy || "—"],
            ["Privileged", ct.privileged ? "Yes" : "No"],
          ].map(([k, v]) => (
            <div key={String(k)} className="flex justify-between gap-2">
              <dt className="text-text-500 shrink-0">{k}</dt>
              <dd className="text-text-200 font-mono text-right truncate max-w-[60%]">{v}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-text-300 mb-3">Ports</h3>
        {ct.ports?.length ? (
          <div className="space-y-1">
            {ct.ports.map((p, i) => (
              <div key={i} className="flex justify-between text-sm">
                <span className="text-text-500">{p.hostPort}/{p.protocol}</span>
                <span className="font-mono text-text-200">→ {p.containerPort}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-500">No port mappings</p>
        )}

        <h3 className="text-sm font-semibold text-text-300 mt-4 mb-3">Volumes</h3>
        {ct.mounts?.length ? (
          <div className="space-y-1">
            {ct.mounts.map((m, i) => (
              <div key={i} className="text-xs font-mono text-text-300 bg-surface-700 rounded px-2 py-1">
                {m.source} → {m.destination}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-500">No volumes</p>
        )}
      </div>
    </div>
  );
}

// ─── Stats Tab ─────────────────────────────────────────────────────────────────
function DockerStatsTab({ id, running }: { id: string; running: boolean }) {
  const { t } = useTranslation();
  const { data: stats } = useQuery<DockerStats>({
    queryKey: ["docker", id, "stats"],
    queryFn: () => apiGet<DockerStats>(`/api/docker/containers/${id}/stats`),
    refetchInterval: 3_000,
    enabled: running,
  });

  if (!running) {
    return (
      <div className="space-y-4">
        <div className="card p-8 text-center text-text-400">{t("console.notRunning")}</div>
        <NotesCard type="docker" id={id} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="card p-4 space-y-3">
        <MetricBar label={t("res.cpu")} value={stats?.cpuPercent ?? 0} valueLabel={`${(stats?.cpuPercent ?? 0).toFixed(2)}%`} />
        <MetricBar
          label={t("res.memory")}
          value={stats?.memLimitBytes ? ((stats?.memUsedBytes ?? 0) / stats.memLimitBytes) * 100 : 0}
          valueLabel={`${formatBytes(stats?.memUsedBytes ?? 0)} / ${formatBytes(stats?.memLimitBytes ?? 0)}`}
        />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {[
          [t("common.netRx"), formatBytes(stats?.netRxBytes ?? 0)],
          [t("common.netTx"), formatBytes(stats?.netTxBytes ?? 0)],
          [t("common.diskRead"), formatBytes(stats?.blockRdBytes ?? 0)],
          [t("common.diskWrite"), formatBytes(stats?.blockWrBytes ?? 0)],
        ].map(([k, v]) => (
          <div key={String(k)} className="card p-3">
            <div className="text-xs text-text-500 mb-1">{k}</div>
            <div className="text-lg font-mono font-bold text-text-100">{v}</div>
          </div>
        ))}
      </div>
      <NotesCard type="docker" id={id} />
    </div>
  );
}

// ─── Logs Tab ──────────────────────────────────────────────────────────────────
function DockerLogsTab({ id }: { id: string }) {
  const logsRef = useRef<HTMLPreElement>(null);
  const [tail, setTail] = useState(200);

  const { data: logs = "" } = useQuery<string>({
    queryKey: ["docker", id, "logs", tail],
    queryFn: () => apiGet<string>(`/api/docker/containers/${id}/logs?tail=${tail}`),
    refetchInterval: 3_000,
    select: (d) => (typeof d === "string" ? d : JSON.stringify(d)),
  });

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-500">Showing last {tail} lines (auto-refresh 3s)</span>
        <select
          className="input text-xs w-28"
          value={tail}
          onChange={(e) => setTail(parseInt(e.target.value, 10))}
        >
          <option value={50}>50 lines</option>
          <option value={200}>200 lines</option>
          <option value={500}>500 lines</option>
          <option value={1000}>1000 lines</option>
        </select>
      </div>
      <pre
        ref={logsRef}
        className="bg-surface-900 rounded-lg p-4 text-xs font-mono text-text-300 overflow-auto max-h-[500px] whitespace-pre-wrap break-all"
      >
        {logs || "No logs yet"}
      </pre>
    </div>
  );
}

// ─── Ports Tab ─────────────────────────────────────────────────────────────────
function DockerPortsTab({ ct }: { ct: DockerContainerDetail }) {
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-text-300 mb-3">Port Mappings</h3>
      {ct.ports?.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-600">
              <th className="py-2 text-left text-text-400 font-medium">Host Port</th>
              <th className="py-2 text-left text-text-400 font-medium">Container Port</th>
              <th className="py-2 text-left text-text-400 font-medium">Protocol</th>
              <th className="py-2 text-left text-text-400 font-medium">Access</th>
            </tr>
          </thead>
          <tbody>
            {ct.ports.map((p, i) => (
              <tr key={i} className="border-b border-surface-700">
                <td className="py-2 font-mono text-text-200">{p.hostPort}</td>
                <td className="py-2 font-mono text-text-200">{p.containerPort}</td>
                <td className="py-2 text-text-400">{p.protocol.toUpperCase()}</td>
                <td className="py-2">
                  {p.protocol === "tcp" ? (
                    <a
                      href={`http://localhost:${p.hostPort}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent-blue hover:underline text-xs"
                    >
                      Open →
                    </a>
                  ) : (
                    <span className="text-text-500">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-text-500">No port mappings</p>
      )}
    </div>
  );
}

// ─── Networks Tab (multi-NIC) ────────────────────────────────────────────────
interface DockerNic { network: string; primary: boolean; ipAddress?: string; ipPrefixLen?: number; gateway?: string; macAddress?: string; }

function DockerNetworksTab({ id }: { id: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const nics = useQuery<DockerNic[]>({ queryKey: ["docker", id, "networks"], queryFn: () => apiGet(`/api/docker/containers/${id}/networks`) });
  const allNets = useQuery<Array<{ name: string }>>({ queryKey: ["docker", "networks-list"], queryFn: () => apiGet("/api/docker/networks") });
  const [adding, setAdding] = useState(false);
  const [network, setNetwork] = useState("");
  const [ipv4, setIpv4] = useState("");
  const [mac, setMac] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["docker", id, "networks"] });

  const connect = useMutation({
    mutationFn: () => apiPost(`/api/docker/containers/${id}/networks`, { network, ...(ipv4 ? { ipv4 } : {}), ...(mac ? { macAddress: mac } : {}) }),
    onSuccess: () => { setAdding(false); setNetwork(""); setIpv4(""); setMac(""); refresh(); },
  });
  const disconnect = useMutation({
    mutationFn: (net: string) => apiDelete(`/api/docker/containers/${id}/networks/${encodeURIComponent(net)}`),
    onSuccess: refresh,
  });

  const attached = new Set((nics.data ?? []).map((n) => n.network));
  const available = (allNets.data ?? []).map((n) => n.name).filter((n) => !attached.has(n) && n !== "host" && n !== "none");
  const canDelete = (nics.data ?? []).length > 1;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="rounded border border-yellow-800/50 bg-yellow-900/20 px-3 py-2 text-xs text-yellow-400">
        {t("net.dockerNote", "Un conteneur peut être connecté à plusieurs réseaux. Le réseau principal ne peut pas être retiré.")}
      </div>

      {(nics.data ?? []).map((nic) => (
        <NicCard
          key={nic.network}
          title={nic.network}
          primary={nic.primary || !canDelete}
          rows={[
            [t("net.ip", "IP"), nic.ipAddress ? `${nic.ipAddress}${nic.ipPrefixLen ? `/${nic.ipPrefixLen}` : ""}` : "—"],
            [t("net.gateway", "Passerelle"), nic.gateway || "—"],
            ["MAC", nic.macAddress || "—"],
          ]}
          onEdit={undefined}
          onDelete={() => disconnect.mutate(nic.network)}
          deleting={disconnect.isPending}
        />
      ))}

      {disconnect.error && <p className="text-xs text-red-400">{(disconnect.error as Error).message}</p>}

      {adding ? (
        <div className="card p-4 space-y-3 border border-accent-blue/30">
          <h4 className="text-sm font-semibold text-text-200">{t("net.connectNetwork", "Connecter à un réseau")}</h4>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className="label">{t("net.network", "Réseau")}</label>
              <select className="input font-mono" value={network} onChange={(e) => setNetwork(e.target.value)}>
                <option value="">{t("net.choose", "Choisir…")}</option>
                {available.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <div>
              <label className="label">{t("net.ipv4Optional", "IPv4 (optionnel)")}</label>
              <input className="input font-mono" value={ipv4} onChange={(e) => setIpv4(e.target.value)} placeholder="172.20.0.10" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">MAC ({t("net.optional", "optionnel")})</label>
              <input className="input font-mono" value={mac} onChange={(e) => setMac(e.target.value.toLowerCase())} placeholder="aa:bb:cc:dd:ee:ff" />
            </div>
          </div>
          {connect.error && <p className="text-xs text-red-400">{(connect.error as Error).message}</p>}
          <div className="flex items-center gap-2">
            <button className="btn-primary btn-sm" disabled={connect.isPending || !network} onClick={() => connect.mutate()}>
              {connect.isPending ? t("msg.loading", "…") : t("net.connect", "Connecter")}
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setAdding(false)}>{t("action.cancel", "Annuler")}</button>
          </div>
        </div>
      ) : (
        <button className="btn-secondary btn-sm" disabled={available.length === 0} onClick={() => setAdding(true)}>
          + {t("net.connectNetwork", "Connecter à un réseau")}
        </button>
      )}
    </div>
  );
}

// Shared NIC summary card with optional edit + delete (delete disabled for primary).
function NicCard({ title, primary, rows, onEdit, onDelete, deleting }: {
  title: string; primary: boolean; rows: [string, string][]; onEdit?: () => void; onDelete: () => void; deleting?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-200">{title}</span>
          {primary && <span className="text-2xs px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue border border-accent-blue/30">{t("net.primary", "principale")}</span>}
        </div>
        <div className="flex items-center gap-2">
          {onEdit && <button className="btn-ghost btn-sm" onClick={onEdit}>{t("action.edit", "Modifier")}</button>}
          <button
            className="btn-ghost btn-sm text-red-400 disabled:opacity-30 disabled:cursor-not-allowed"
            disabled={primary || deleting}
            title={primary ? t("net.cannotDeletePrimary", "La carte principale ne peut pas être supprimée") : undefined}
            onClick={onDelete}
          >
            {t("action.delete", "Supprimer")}
          </button>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-text-500">{k}</dt>
            <dd className="font-mono text-text-200 text-right truncate">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </div>
  );
}

// ─── Volumes Tab ───────────────────────────────────────────────────────────────
function DockerVolumesTab({ ct }: { ct: DockerContainerDetail }) {
  return (
    <div className="card p-5">
      <h3 className="text-sm font-semibold text-text-300 mb-3">Volume Mounts</h3>
      {ct.mounts?.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-600">
              <th className="py-2 text-left text-text-400 font-medium">Host Path</th>
              <th className="py-2 text-left text-text-400 font-medium">Container Path</th>
              <th className="py-2 text-left text-text-400 font-medium">Mode</th>
            </tr>
          </thead>
          <tbody>
            {ct.mounts.map((m, i) => (
              <tr key={i} className="border-b border-surface-700">
                <td className="py-2 font-mono text-text-300 text-xs">{m.source}</td>
                <td className="py-2 font-mono text-text-300 text-xs">{m.destination}</td>
                <td className="py-2 text-text-400">{m.mode || "rw"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-text-500">No volumes mounted</p>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────
export default function DockerDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const qc = useQueryClient();
  const { getResourcePermissions } = useAuth();
  const [tab, setTab] = useState("summary");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const perms = useMemo(() => (id ? getResourcePermissions("docker", id) : null), [getResourcePermissions, id]);
  const { locked, lockEntry } = useResourceLock("docker", id);
  const tabs = useMemo(() => [
    { key: "summary", label: "Summary" },
    perms?.canConsole ? { key: "terminal", label: "Terminal" } : null,
    { key: "stats", label: "Stats" },
    perms?.canAdmin ? { key: "acl", label: "Resource ACL" } : null,
    { key: "logs", label: "Logs" },
    { key: "ports", label: "Ports" },
    perms?.canModify ? { key: "networks", label: t("tab.networks", "Réseaux") } : null,
    { key: "volumes", label: "Volumes" },
  ].filter(Boolean) as Array<{ key: string; label: string }>, [perms?.canAdmin, perms?.canConsole, perms?.canModify, t]);

  const { data: ct, isLoading, error } = useQuery<DockerContainerDetail>({
    queryKey: ["docker", id],
    queryFn: () => apiGet<DockerContainerDetail>(`/api/docker/containers/${id}`),
    refetchInterval: 10_000,
    enabled: !!id,
  });

  const action = useMutation({
    mutationFn: (act: string) => apiPost(`/api/docker/containers/${id}/${act}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["docker"] }),
  });

  const remove = useMutation({
    mutationFn: () => apiDelete(`/api/docker/containers/${id}`),
    onSuccess: () => navigate("/docker"),
  });

  useEffect(() => {
    const requestedTab = searchParams.get("tab");
    if (requestedTab && tabs.some((entry) => entry.key === requestedTab)) {
      setTab(requestedTab);
      return;
    }
    if (!tabs.some((entry) => entry.key === tab)) {
      setTab("summary");
    }
  }, [searchParams, tab, tabs]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !ct) {
    return <div className="card p-6 text-red-400">Container not found</div>;
  }

  const isRunning = ct.state === "running";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate("/docker")} className="text-text-400 hover:text-text-200 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h1 className="text-xl font-bold text-text-100">{ct.name}</h1>
            <div className="flex items-center gap-2 mt-0.5">
              <StatusBadge state={ct.state} />
              {locked && <LockBadge reason={lockEntry?.reason} />}
              <span className="text-xs font-mono text-text-400">{ct.image}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {perms?.canPower && !isRunning && (
            <button onClick={() => action.mutate("start")} disabled={action.isPending}
              className="btn bg-green-900/40 text-green-400 hover:bg-green-900/60 border-green-800">
              Start
            </button>
          )}
          {perms?.canPower && isRunning && (
            <>
              <button onClick={() => action.mutate("restart")} disabled={action.isPending} className="btn">Restart</button>
              <button onClick={() => action.mutate("stop")} disabled={action.isPending}
                className="btn bg-red-900/40 text-red-400 hover:bg-red-900/60 border-red-800">
                Stop
              </button>
            </>
          )}
          {perms?.canAdmin && <LockButton type="docker" name={id} />}
          {perms?.canDelete && <button onClick={() => setDeleteOpen(true)} disabled={locked} title={locked ? "Ressource verrouillée" : undefined}
            className="btn bg-red-900/20 text-red-400 hover:bg-red-900/40 border-red-900 disabled:opacity-40 disabled:cursor-not-allowed">
            {t("action.delete")}
          </button>}
        </div>
      </div>

      {/* Tabs */}
      <Tabs tabs={tabs} active={tab} onChange={setTab} />

      {/* Tab content */}
      <div>
        {tab === "summary" && <DockerSummaryTab ct={ct} />}
        {tab === "terminal" && perms?.canConsole && (
          isRunning ? (
            <Terminal ticketPath={`/api/docker/containers/${id}/console-ticket`} className="h-[500px]" />
          ) : (
            <div className="card p-8 text-center text-text-400">
              Container must be running to access the terminal.
            </div>
          )
        )}
        {tab === "stats" && <DockerStatsTab id={id!} running={isRunning} />}
        {tab === "acl" && perms?.canAdmin && <ResourceAclPanel resourceType="docker" resourceName={id!} title={`Docker ACL · ${ct.name}`} />}
        {tab === "logs" && <DockerLogsTab id={id!} />}
        {tab === "ports" && <DockerPortsTab ct={ct} />}
        {tab === "networks" && perms?.canModify && <DockerNetworksTab id={id!} />}
        {tab === "volumes" && <DockerVolumesTab ct={ct} />}
      </div>

      <ConfirmModal
        open={deleteOpen}
        title={t("modal.deleteContainer")}
        message={`Delete container "${ct.name}"? The container and its data will be lost.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => remove.mutate()}
        onCancel={() => setDeleteOpen(false)}
        loading={remove.isPending}
      />
    </div>
  );
}
