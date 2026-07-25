import { useEffect, useState } from "react";
import { api } from "@/api/client";

interface RdpInfo {
  xrdpInstalled: boolean; xrdpActive: boolean; xrdpPort: number; xrdpLibVnc?: string;
  profileName: string; ready: boolean; warnings: string[]; consolePassword?: string;
}

export function RdpConsolePanel({ node, name }: { node: string; name: string }) {
  const base = `/api/vdm/vms/${encodeURIComponent(node)}/${encodeURIComponent(name)}`;
  const [info, setInfo] = useState<RdpInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const load = async () => {
    try { setInfo(await api.get<RdpInfo>(`${base}/rdp-info`)); }
    catch (e) { setError(e instanceof Error ? e.message : "RDP status failed"); }
  };
  useEffect(() => { void load(); }, [base]);
  const prepare = async () => {
    setPending(true); setError(null);
    try { setInfo(await api.post<RdpInfo>(`${base}/rdp-prepare`)); }
    catch (e) { setError(e instanceof Error ? e.message : "RDP preparation failed"); }
    finally { setPending(false); }
  };
  return (
    <div className="h-full overflow-auto bg-vdm-bg p-6">
      <div className="vdm-card mx-auto max-w-3xl space-y-4 p-5">
        <div><h3 className="text-base font-semibold text-vdm-text">RDP Remote Console</h3><p className="mt-1 text-sm text-vdm-textMuted">Dedicated RDP gateway on node {node}; no RDP server is required inside the VM.</p></div>
        {error && <div className="rounded border border-vdm-danger/40 bg-vdm-danger/10 p-3 text-sm text-vdm-danger">{error}</div>}
        {!info && !error && <div className="text-sm text-vdm-textMuted">Checking RDP gateway…</div>}
        {info && <>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded border border-vdm-border p-3"><div className="text-xs text-vdm-textMuted">Profile</div><div className="font-mono text-vdm-text">{info.profileName}</div></div>
            <div className="rounded border border-vdm-border p-3"><div className="text-xs text-vdm-textMuted">Gateway</div><div className="font-mono text-vdm-text">{info.xrdpActive ? `active · port ${info.xrdpPort}` : "inactive"}</div></div>
          </div>
          {info.warnings?.length > 0 && <ul className="list-disc space-y-1 rounded border border-vdm-warning/40 bg-vdm-warning/10 p-3 pl-8 text-sm text-vdm-warning">{info.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
          {info.consolePassword && <div className="rounded border border-vdm-success/40 bg-vdm-success/10 p-3 text-sm text-vdm-success">Console password: <strong className="font-mono">{info.consolePassword}</strong></div>}
          <div className="flex gap-2"><button className="vdm-btn-ghost" disabled={pending || !info.xrdpInstalled || !info.xrdpLibVnc} onClick={() => void prepare()}>{pending ? "Preparing…" : "Prepare RDP"}</button><button className="vdm-btn-primary" disabled={!info.ready} onClick={() => { window.location.href = `${base}/rdp-file`; }}>Download .rdp</button></div>
        </>}
      </div>
    </div>
  );
}
