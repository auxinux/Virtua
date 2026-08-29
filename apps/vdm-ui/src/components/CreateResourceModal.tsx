import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import type { VdmNode, VdmSharedStorage, VdmNodePool } from "@/types/vdm";

type CreateType = "vm" | "lxc" | "docker";

interface PoolEntry { name: string }
interface IsoEntry { filename: string; displayName?: string; type: string }
interface TemplateEntry { name: string; dist: string; release: string; arch: string; variant: string; description?: string; cached?: boolean }
interface ImageEntry { id: string; repoTags?: string[] }
interface BridgeEntry { name: string }
interface DockerNetEntry { name: string; driver?: string }

/** Unified "create resource" modal (VM / LXC / Docker) for a chosen node. */
export function CreateResourceModal({ open, onClose, type }: { open: boolean; onClose: () => void; type: CreateType }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const nodesQuery = useQuery<VdmNode[]>({ queryKey: ["vdm-nodes"], queryFn: () => api.get("/api/vdm/nodes"), enabled: open });
  const onlineNodes = (nodesQuery.data ?? []).filter((n) => n.enabled && n.status === "online");

  const [node, setNode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  // Storage: local node pool OR shared storage
  const [storageKind, setStorageKind] = useState<"local" | "shared">("local");
  const [storagePool, setStoragePool] = useState("");
  const [sharedStorageName, setSharedStorageName] = useState("");

  // Common resources
  const [cpu, setCpu] = useState(type === "docker" ? 1 : 2);
  const [memory, setMemory] = useState(type === "lxc" ? 1024 : type === "docker" ? 512 : 2048);
  const [disk, setDisk] = useState(type === "lxc" ? 8 : 20);
  const [bridge, setBridge] = useState("");

  // VM
  const [osType, setOsType] = useState("linux");
  const [isoFile, setIsoFile] = useState("");
  // LXC
  const [templateName, setTemplateName] = useState("");
  const [password, setPassword] = useState("");
  // Docker
  const [image, setImage] = useState("");
  const [dockerNet, setDockerNet] = useState("");
  const [ports, setPorts] = useState("");

  useEffect(() => {
    if (open && !node && onlineNodes.length > 0) setNode(onlineNodes[0].name);
  }, [open, onlineNodes, node]);

  // Per-node catalogs (only fetched for the relevant type)
  const pools = useQuery<VdmNodePool[]>({ queryKey: ["vdm-node-pools", node], queryFn: () => api.get(`/api/vdm/nodes/${node}/storage`), enabled: open && !!node });
  const storagesQuery = useQuery<VdmSharedStorage[]>({ queryKey: ["vdm-storage"], queryFn: () => api.get("/api/vdm/storage"), enabled: open });
  const isos = useQuery<IsoEntry[]>({ queryKey: ["vdm-node-isos", node], queryFn: () => api.get(`/api/vdm/nodes/${node}/isos`), enabled: open && !!node && type === "vm" });
  const templates = useQuery<TemplateEntry[]>({ queryKey: ["vdm-node-templates", node], queryFn: () => api.get(`/api/vdm/nodes/${node}/lxc-templates`), enabled: open && !!node && type === "lxc" });
  const images = useQuery<ImageEntry[]>({ queryKey: ["vdm-node-images", node], queryFn: () => api.get(`/api/vdm/nodes/${node}/docker-images`), enabled: open && !!node && type === "docker" });
  const bridges = useQuery<BridgeEntry[]>({ queryKey: ["vdm-node-bridges", node], queryFn: () => api.get(`/api/vdm/nodes/${node}/bridges`), enabled: open && !!node && (type === "vm" || type === "lxc") });
  const dockerNets = useQuery<DockerNetEntry[]>({ queryKey: ["vdm-node-dnets", node], queryFn: () => api.get(`/api/vdm/nodes/${node}/docker-networks`), enabled: open && !!node && type === "docker" });

  const create = useMutation({
    mutationFn: () => {
      let body: Record<string, unknown>;
      if (type === "vm") {
        if (storageKind === "local" && !storagePool) throw new Error("Select a storage pool");
        if (storageKind === "shared" && !sharedStorageName) throw new Error("Select a shared storage");
        body = {
          name, vcpus: cpu, memoryMb: memory, diskGb: disk,
          os: osType || "linux",
          ...(storageKind === "local" ? { storagePool } : { sharedStorageName }),
          ...(isoFile ? { isoFile } : {}),
          ...(bridge ? { bridge } : {}),
        };
      } else if (type === "lxc") {
        const tpl = (templates.data ?? []).find((t) => t.name === templateName);
        if (!tpl) throw new Error("Select a template");
        if (password.length < 6) throw new Error("Password must be at least 6 characters");
        if (storageKind === "local" && !storagePool) throw new Error("Select a storage pool");
        if (storageKind === "shared" && !sharedStorageName) throw new Error("Select a shared storage");
        body = {
          name, dist: tpl.dist, release: tpl.release, arch: tpl.arch, variant: tpl.variant,
          cpuCores: cpu, memoryMb: memory, diskGb: disk, password,
          ...(storageKind === "local" ? { storagePool } : { sharedStorageName }),
          ...(bridge ? { bridge } : {}),
        };
      } else {
        if (!image.trim()) throw new Error("An image is required");
        if (storageKind === "local" && !storagePool) throw new Error("Select a storage pool");
        if (storageKind === "shared" && !sharedStorageName) throw new Error("Select a shared storage");
        body = {
          name, image: image.trim(),
          ...(storageKind === "local" ? { storagePool } : { sharedStorageName }),
          ...(cpu ? { cpuLimit: cpu } : {}),
          ...(memory ? { memoryMb: memory } : {}),
          ...(dockerNet ? { network: dockerNet } : {}),
          ...(ports.trim() ? { ports: parsePorts(ports) } : {}),
        };
      }
      return api.post(`/api/vdm/${type}/${encodeURIComponent(node)}`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`vdm-${type === "vm" ? "vms" : type}`] });
      onClose();
      navigate("/tasks");
    },
    onError: (e: Error) => setError(e.message),
  });

  if (!open) return null;
  const label = type === "vm" ? "Virtual Machine" : type === "lxc" ? "LXC Container" : "Docker Container";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="vdm-card w-full max-w-lg p-5 space-y-3 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-vdm-text">Create {label}</h3>

        <div>
          <label className="vdm-label">Target node</label>
          <select className="vdm-input" value={node} onChange={(e) => setNode(e.target.value)}>
            {onlineNodes.length === 0 && <option value="">No online node</option>}
            {onlineNodes.map((n) => <option key={n.name} value={n.name}>{n.displayName}</option>)}
          </select>
        </div>

        <div>
          <label className="vdm-label">Name</label>
          <input className="vdm-input font-mono" value={name} onChange={(e) => setName(e.target.value)} placeholder={type === "docker" ? "my-app" : "my-machine"} />
        </div>

        {/* Storage: local node pool OR shared storage */}
        <div>
          <label className="vdm-label">Storage</label>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setStorageKind("local")}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${storageKind === "local" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
              Local storage
            </button>
            <button type="button" onClick={() => setStorageKind("shared")}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${storageKind === "shared" ? "border-vdm-accent bg-vdm-accent/10 text-vdm-accent" : "border-vdm-border text-vdm-textMuted hover:border-vdm-accent/50"}`}>
              Shared storage
            </button>
          </div>
          {storageKind === "local" ? (
            <select className="vdm-input mt-2" value={storagePool} onChange={(e) => setStoragePool(e.target.value)}>
              <option value="">Select local pool…</option>
              {(pools.data ?? []).filter((p) => p.mounted !== false).map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          ) : (
            <select className="vdm-input mt-2" value={sharedStorageName} onChange={(e) => setSharedStorageName(e.target.value)}>
              <option value="">Select shared storage…</option>
              {(storagesQuery.data ?? []).map((s) => <option key={s.name} value={s.name}>{s.displayName} ({s.type})</option>)}
            </select>
          )}
        </div>

        {type === "vm" && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="vdm-label">OS type</label>
                <input className="vdm-input" value={osType} onChange={(e) => setOsType(e.target.value)} placeholder="linux" />
              </div>
            </div>
            <div>
              <label className="vdm-label">Install ISO (optional)</label>
              <select className="vdm-input" value={isoFile} onChange={(e) => setIsoFile(e.target.value)}>
                <option value="">None</option>
                {(isos.data ?? []).filter((f) => f.type === "iso").map((f) => <option key={f.filename} value={f.filename}>{f.displayName ?? f.filename}</option>)}
              </select>
            </div>
          </>
        )}

        {type === "lxc" && (
          <>
            <div>
              <label className="vdm-label">Template</label>
              <select className="vdm-input" value={templateName} onChange={(e) => setTemplateName(e.target.value)}>
                <option value="">Select…</option>
                {(templates.data ?? []).slice(0, 200).map((t) => (
                  <option key={t.name} value={t.name}>{t.dist} {t.release} ({t.arch}){t.cached ? " ✓" : ""}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="vdm-label">Root password</label>
              <input className="vdm-input font-mono" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="min 6 chars" />
            </div>
          </>
        )}

        {type === "docker" && (
          <>
            <div>
              <label className="vdm-label">Image</label>
              <input className="vdm-input font-mono" value={image} onChange={(e) => setImage(e.target.value)} placeholder="nginx:latest" list="vdm-docker-images" />
              <datalist id="vdm-docker-images">
                {(images.data ?? []).flatMap((i) => (i.repoTags ?? []).filter((t) => t && !t.startsWith("<none>"))).map((t) => <option key={t} value={t} />)}
              </datalist>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="vdm-label">Network</label>
                <select className="vdm-input" value={dockerNet} onChange={(e) => setDockerNet(e.target.value)}>
                  <option value="">default (bridge)</option>
                  {(dockerNets.data ?? []).filter((n) => n.name !== "host" && n.name !== "none").map((n) => <option key={n.name} value={n.name}>{n.name}</option>)}
                </select>
              </div>
              <div>
                <label className="vdm-label">Ports (host:container)</label>
                <input className="vdm-input font-mono" value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="8080:80,443:443" />
              </div>
            </div>
          </>
        )}

        {/* Resources */}
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="vdm-label">{type === "docker" ? "CPU limit" : "vCPU"}</label>
            <input className="vdm-input" type="number" min={1} value={cpu} onChange={(e) => setCpu(parseInt(e.target.value, 10) || 1)} />
          </div>
          <div>
            <label className="vdm-label">Memory (MB)</label>
            <input className="vdm-input" type="number" min={64} step={64} value={memory} onChange={(e) => setMemory(parseInt(e.target.value, 10) || 512)} />
          </div>
          {type !== "docker" && (
            <div>
              <label className="vdm-label">Disk (GB)</label>
              <input className="vdm-input" type="number" min={1} value={disk} onChange={(e) => setDisk(parseInt(e.target.value, 10) || 8)} />
            </div>
          )}
        </div>

        {(type === "vm" || type === "lxc") && (
          <div>
            <label className="vdm-label">Network bridge</label>
            <select className="vdm-input" value={bridge} onChange={(e) => setBridge(e.target.value)}>
              <option value="">default ({type === "vm" ? "virbr0" : "lxcbr0"})</option>
              {(bridges.data ?? []).map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </div>
        )}

        {error && <p className="text-xs text-vdm-danger">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="vdm-btn-primary"
            disabled={create.isPending || !node || !name.trim()}
            onClick={() => { setError(""); create.mutate(); }}
          >
            {create.isPending ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function parsePorts(s: string): Array<{ hostPort: number; containerPort: number; protocol: "tcp" | "udp" }> {
  const out: Array<{ hostPort: number; containerPort: number; protocol: "tcp" | "udp" }> = [];
  for (const part of s.split(",")) {
    const m = /^\s*(\d{1,5})\s*:\s*(\d{1,5})\s*(?:\/\s*(tcp|udp))?\s*$/i.exec(part);
    if (!m) continue;
    out.push({ hostPort: parseInt(m[1], 10), containerPort: parseInt(m[2], 10), protocol: (m[3]?.toLowerCase() as "tcp" | "udp") ?? "tcp" });
  }
  return out;
}
