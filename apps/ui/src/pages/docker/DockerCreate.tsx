import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiGet, apiPost } from "../../api/client";
import type { DockerImage, DockerNetwork, StoragePool } from "@auxinux/shared";

interface PortMapping {
  hostPort: number;
  containerPort: number;
  protocol: "tcp" | "udp";
}

interface EnvVar {
  key: string;
  value: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
}

interface CreateDockerPayload {
  name: string;
  image: string;
  storagePool?: string;
  command?: string;
  ports: PortMapping[];
  env: EnvVar[];
  volumes: VolumeMount[];
  network?: string;
  ipAddress?: string;
  macAddress?: string;
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  privileged: boolean;
}

interface CreateDockerApiPayload {
  name: string;
  image: string;
  storagePool?: string;
  command?: string;
  ports: PortMapping[];
  env: string[];
  volumes: Array<VolumeMount & { mode: "ro" | "rw" }>;
  network?: string;
  ipAddress?: string;
  macAddress?: string;
  restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  privileged: boolean;
}

function sanitizeDockerStorageName(value: string) {
  const segment = value.trim().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return segment || "container";
}

function defaultDockerVolumePath(containerName: string, index: number) {
  return `docker/${sanitizeDockerStorageName(containerName)}/volume-${index + 1}`;
}

function isValidIpv4(value: string) {
  return /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/.test(value);
}

function isValidMac(value: string) {
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(value);
}

export default function DockerCreate() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedImage = searchParams.get("image") ?? "";
  const targetNode = searchParams.get("node");

  // Pre-fill ports from URL param (e.g. "80/tcp,443/tcp" passed from Hub search)
  const initialPorts: PortMapping[] = useMemo(() => {
    const portsParam = searchParams.get("ports") ?? "";
    if (!portsParam) return [];
    return portsParam.split(",").flatMap((spec) => {
      const m = spec.trim().match(/^(\d+)\/(tcp|udp)$/i);
      if (!m) return [];
      const containerPort = parseInt(m[1], 10);
      const protocol = m[2].toLowerCase() as "tcp" | "udp";
      return [{ hostPort: containerPort, containerPort, protocol }];
    });
  }, [searchParams]);

  const [form, setForm] = useState<CreateDockerPayload>({
    name: "",
    image: selectedImage,
    storagePool: "",
    command: "",
    ports: initialPorts,
    env: [],
    volumes: [],
    network: "",
    ipAddress: "",
    macAddress: "",
    restartPolicy: "unless-stopped",
    privileged: false,
  });
  const [imageSearch, setImageSearch] = useState("");
  const [error, setError] = useState("");

  const { data: localImages = [] } = useQuery<DockerImage[]>({
    queryKey: ["docker", "images", targetNode || "local"],
    queryFn: () => apiGet<DockerImage[]>(targetNode ? `/api/nodes/${encodeURIComponent(targetNode)}/docker/images` : "/api/docker/images"),
  });

  const { data: storagePools = [] } = useQuery<StoragePool[]>({
    queryKey: ["storage", "pools", "docker-create", targetNode || "local"],
    queryFn: () => apiGet<StoragePool[]>(targetNode ? `/api/nodes/${encodeURIComponent(targetNode)}/storage/pools` : "/api/storage/pools"),
  });

  const { data: dockerNetworks = [] } = useQuery<DockerNetwork[]>({
    queryKey: ["docker", "networks", targetNode || "local"],
    queryFn: () => apiGet<DockerNetwork[]>(`/api/docker/networks${targetNode ? `?node=${encodeURIComponent(targetNode)}` : ""}`),
  });

  const containerPools = useMemo(
    () => storagePools.filter((pool) => pool.enabled !== false && pool.content.includes("container")),
    [storagePools],
  );

  const create = useMutation({
    mutationFn: (payload: CreateDockerApiPayload) => apiPost(`/api/docker/containers${targetNode ? `?node=${encodeURIComponent(targetNode)}` : ""}`, payload),
    onSuccess: () => navigate("/docker"),
    onError: (err: Error) => setError(err.message),
  });

  const set = (field: keyof CreateDockerPayload, value: unknown) =>
    setForm((f) => ({ ...f, [field]: value }));

  useEffect(() => {
    if (selectedImage) {
      setForm((current) => current.image === selectedImage ? current : { ...current, image: selectedImage });
    }
  }, [selectedImage]);

  useEffect(() => {
    if (!form.storagePool) return;
    setForm((current) => {
      let changed = false;
      const volumes = current.volumes.map((volume, index) => {
        if (volume.hostPath.trim()) return volume;
        changed = true;
        return { ...volume, hostPath: defaultDockerVolumePath(current.name, index) };
      });
      return changed ? { ...current, volumes } : current;
    });
  }, [form.storagePool]);

  const addPort = () => set("ports", [...form.ports, { hostPort: 8080, containerPort: 80, protocol: "tcp" }]);
  const removePort = (i: number) => set("ports", form.ports.filter((_, idx) => idx !== i));
  const updatePort = (i: number, p: Partial<PortMapping>) =>
    set("ports", form.ports.map((port, idx) => idx === i ? { ...port, ...p } : port));

  const addEnv = () => set("env", [...form.env, { key: "", value: "" }]);
  const removeEnv = (i: number) => set("env", form.env.filter((_, idx) => idx !== i));
  const updateEnv = (i: number, p: Partial<EnvVar>) =>
    set("env", form.env.map((e, idx) => idx === i ? { ...e, ...p } : e));

  const addVolume = () => set("volumes", [
    ...form.volumes,
    { hostPath: form.storagePool ? defaultDockerVolumePath(form.name, form.volumes.length) : "", containerPath: "" },
  ]);
  const removeVolume = (i: number) => set("volumes", form.volumes.filter((_, idx) => idx !== i));
  const updateVolume = (i: number, p: Partial<VolumeMount>) =>
    set("volumes", form.volumes.map((v, idx) => idx === i ? { ...v, ...p } : v));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!form.name.match(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)) {
      setError(t("docker.containerNameInvalid"));
      return;
    }
    if (!form.image) { setError(t("docker.imageRequired")); return; }
    if (form.ipAddress && !isValidIpv4(form.ipAddress)) {
      setError(t("docker.staticIpInvalid"));
      return;
    }
    if (form.macAddress && !isValidMac(form.macAddress)) {
      setError(t("vm.macInvalid"));
      return;
    }
    if (form.ipAddress && (!form.network || ["bridge", "host", "none"].includes(form.network))) {
      setError(t("docker.staticIpNetworkRequired"));
      return;
    }
    const payload: CreateDockerApiPayload = {
      name: form.name,
      image: form.image,
      storagePool: form.storagePool || undefined,
      command: form.command || undefined,
      ports: form.ports,
      env: form.env.filter((entry) => entry.key).map((entry) => `${entry.key}=${entry.value}`),
      volumes: form.volumes.filter((entry) => entry.hostPath && entry.containerPath).map((entry) => ({ ...entry, mode: "rw" as const })),
      network: form.network || undefined,
      ipAddress: form.ipAddress || undefined,
      macAddress: form.macAddress || undefined,
      restartPolicy: form.restartPolicy,
      privileged: form.privileged,
    };
    create.mutate(payload);
  };

  const filteredImages = localImages.filter((img) =>
    imageSearch ? img.repoTags?.some((t) => t.toLowerCase().includes(imageSearch.toLowerCase())) : true
  );

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <button onClick={() => navigate("/docker")} className="text-text-400 hover:text-text-200 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div>
          <h1 className="text-xl font-bold text-text-100">{t("docker.createContainer")}</h1>
          {targetNode && <p className="text-xs text-text-500 mt-1">{t("datacenter.node")}: {targetNode}</p>}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("docker.image")}</h2>

          <div>
            <label className="label">{t("docker.imageName")} *</label>
            <input
              className="input font-mono"
              value={form.image}
              onChange={(e) => set("image", e.target.value)}
              placeholder="nginx:latest or ubuntu:22.04"
              required
            />
            <p className="text-xs text-text-500 mt-1">
              {t("docker.imageHelp")}
            </p>
          </div>

          {localImages.length > 0 && (
            <div>
              <label className="label">{t("docker.selectLocalImage")}</label>
              <input
                className="input mb-2"
                value={imageSearch}
                onChange={(e) => setImageSearch(e.target.value)}
                placeholder={t("msg.search")}
              />
              <div className="max-h-32 overflow-y-auto space-y-1">
                {filteredImages.slice(0, 10).map((img) =>
                  img.repoTags?.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => set("image", tag)}
                      className={`w-full text-left px-2 py-1 rounded text-xs font-mono hover:bg-surface-600 transition-colors ${
                        form.image === tag ? "bg-accent-blue/20 text-accent-blue" : "text-text-300"
                      }`}
                    >
                      {tag}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("common.details")}</h2>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("docker.containerName")}</label>
              <input
                className="input"
                value={form.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Required (e.g. web-nginx)"
              />
            </div>
            <div>
              <label className="label">{t("docker.restartPolicy")}</label>
              <select className="input" value={form.restartPolicy} onChange={(e) => set("restartPolicy", e.target.value)}>
                <option value="no">{t("docker.restartNo")}</option>
                <option value="always">{t("docker.restartAlways")}</option>
                <option value="unless-stopped">{t("docker.restartUnlessStopped")}</option>
                <option value="on-failure">{t("docker.restartOnFailure")}</option>
              </select>
            </div>
          </div>

          <div>
            <label className="label">{t("docker.commandOverride")}</label>
            <input
              className="input font-mono"
              value={form.command}
              onChange={(e) => set("command", e.target.value)}
              placeholder="e.g. /bin/bash -c 'echo hello'"
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4 rounded border-surface-500 bg-surface-700 accent-accent-blue"
              checked={form.privileged}
              onChange={(e) => set("privileged", e.target.checked)}
            />
            <span className="text-sm text-text-300">{t("docker.privilegedMode")}</span>
            <span className="text-xs text-yellow-400">{t("docker.securityRisk")}</span>
          </label>
        </div>

        <div className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold text-text-300 border-b border-surface-500 pb-2">{t("res.network")}</h2>

          <div>
            <label className="label">{t("docker.network")}</label>
            <select
              className="input font-mono"
              value={form.network ?? ""}
              onChange={(e) => set("network", e.target.value)}
            >
              <option value="">{t("docker.defaultNetwork")}</option>
              {dockerNetworks.map((network) => (
                <option key={network.id} value={network.name}>
                  {network.name} ({network.driver}{network.subnet ? ` · ${network.subnet}` : ""})
                </option>
              ))}
            </select>
            <p className="text-xs text-text-500 mt-1">{t("docker.networkHelp")}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("docker.staticIp")}</label>
              <input
                className="input font-mono"
                value={form.ipAddress || ""}
                onChange={(e) => set("ipAddress", e.target.value.trim())}
                placeholder="203.0.113.245"
              />
            </div>
            <div>
              <label className="label">{t("docker.macAddress")}</label>
              <input
                className="input font-mono"
                value={form.macAddress || ""}
                onChange={(e) => set("macAddress", e.target.value.toLowerCase().trim())}
                placeholder="02:00:00:09:42:48"
              />
            </div>
          </div>
        </div>

        <div className="card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-300">{t("docker.portMappings")}</h2>
            <button type="button" onClick={addPort} className="text-xs btn">+ {t("docker.addPort")}</button>
          </div>
          {form.ports.map((p, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input type="number" className="input w-24 text-sm" value={p.hostPort}
                onChange={(e) => updatePort(i, { hostPort: parseInt(e.target.value, 10) })}
                placeholder="Host" />
              <span className="text-text-500">:</span>
              <input type="number" className="input w-24 text-sm" value={p.containerPort}
                onChange={(e) => updatePort(i, { containerPort: parseInt(e.target.value, 10) })}
                placeholder="Container" />
              <select className="input w-20 text-sm" value={p.protocol}
                onChange={(e) => updatePort(i, { protocol: e.target.value as "tcp" | "udp" })}>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
              <button type="button" onClick={() => removePort(i)} className="text-red-400 hover:text-red-300 ml-1">✕</button>
            </div>
          ))}
          {form.ports.length === 0 && (
            <p className="text-xs text-text-500">{t("docker.noPorts")}</p>
          )}
        </div>

        <div className="card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-300">{t("docker.volumeMounts")}</h2>
            <button type="button" onClick={addVolume} className="text-xs btn">+ {t("docker.addVolume")}</button>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t("storage.pool")}</label>
              <select
                className="input"
                value={form.storagePool ?? ""}
                onChange={(e) => set("storagePool", e.target.value)}
              >
                <option value="">{t("docker.defaultStorage")}</option>
                {containerPools.map((pool) => (
                  <option key={pool.name} value={pool.name}>{pool.name}</option>
                ))}
              </select>
            </div>
          </div>
          {form.volumes.map((v, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input className="input text-sm font-mono" value={v.hostPath}
                onChange={(e) => updateVolume(i, { hostPath: e.target.value })}
                placeholder={form.storagePool ? "docker/web/volume-1" : "/host/path"} />
              <span className="text-text-500">:</span>
              <input className="input text-sm font-mono" value={v.containerPath}
                onChange={(e) => updateVolume(i, { containerPath: e.target.value })}
                placeholder="/container/path" />
              <button type="button" onClick={() => removeVolume(i)} className="text-red-400 hover:text-red-300 ml-1">✕</button>
            </div>
          ))}
          {form.volumes.length === 0 && (
            <p className="text-xs text-text-500">{t("docker.noVolumes")}</p>
          )}
        </div>

        <div className="card p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-text-300">{t("docker.environmentVariables")}</h2>
            <button type="button" onClick={addEnv} className="text-xs btn">+ {t("docker.addVariable")}</button>
          </div>
          {form.env.map((e, i) => (
            <div key={i} className="flex gap-2 items-center">
              <input className="input text-sm font-mono w-40" value={e.key}
                onChange={(ev) => updateEnv(i, { key: ev.target.value })}
                placeholder="KEY" />
              <span className="text-text-500">=</span>
              <input className="input text-sm font-mono flex-1" value={e.value}
                onChange={(ev) => updateEnv(i, { value: ev.target.value })}
                placeholder="value" />
              <button type="button" onClick={() => removeEnv(i)} className="text-red-400 hover:text-red-300 ml-1">✕</button>
            </div>
          ))}
          {form.env.length === 0 && (
            <p className="text-xs text-text-500">{t("docker.noEnvironmentVariables")}</p>
          )}
        </div>

        {error && (
          <div className="bg-red-900/30 border border-red-800 rounded px-3 py-2 text-sm text-red-400">{error}</div>
        )}

        <div className="flex gap-3">
          <button type="submit" disabled={create.isPending} className="btn-primary">
            {create.isPending ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                {t("common.creating")}
              </span>
            ) : (
              `${t("action.create")} ${t("docker.container")}`
            )}
          </button>
          <button type="button" onClick={() => navigate("/docker")} className="btn">
            {t("action.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}
