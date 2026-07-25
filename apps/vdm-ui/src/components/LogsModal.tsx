import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";

type ResType = "vms" | "lxc" | "docker";

/**
 * Live logs viewer for a VM / LXC / Docker resource on a given node. Proxies
 * `/api/vdm/{type}/{node}/{name}/logs` (which forwards to the node's runner).
 */
export function LogsModal({ open, onClose, type, node, name, title }: {
  open: boolean; onClose: () => void; type: ResType; node: string; name: string; title: string;
}) {
  const [tail, setTail] = useState(200);
  const path = `/api/vdm/${type}/${encodeURIComponent(node)}/${encodeURIComponent(name)}/logs?tail=${tail}`;

  const logsQuery = useQuery({
    queryKey: ["vdm-logs", type, node, name, tail],
    queryFn: () => api.get<unknown>(path),
    enabled: open,
    refetchInterval: open ? 4000 : false,
  });

  if (!open) return null;

  // Node logs endpoints return either a string or { logs: string }.
  const raw = logsQuery.data;
  const text = typeof raw === "string" ? raw : ((raw as { logs?: string })?.logs ?? "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="vdm-card w-full max-w-3xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-vdm-text">Logs · {title}</h3>
          <div className="flex items-center gap-2">
            <select className="vdm-input w-28 text-xs" value={tail} onChange={(e) => setTail(parseInt(e.target.value, 10))}>
              <option value={50}>50 lines</option>
              <option value={200}>200 lines</option>
              <option value={500}>500 lines</option>
              <option value={1000}>1000 lines</option>
            </select>
            <button className="vdm-btn-ghost text-xs" onClick={onClose}>Close</button>
          </div>
        </div>
        <pre className="bg-black/50 border border-vdm-border rounded-lg p-3 text-xs font-mono text-vdm-textMuted overflow-auto max-h-[60vh] whitespace-pre-wrap break-all">
          {logsQuery.isLoading ? "Loading…" : (text.trim() ? text : "No logs yet.")}
        </pre>
        <p className="text-xs text-vdm-textMuted/60">Auto-refresh every 4 s · {node}</p>
      </div>
    </div>
  );
}
