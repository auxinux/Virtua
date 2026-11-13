import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { EngineSetup } from "@/components/EngineSetup";
import { Layout } from "@/components/Layout";
import { localVirtua, modeStore, type EngineInstallPrompt } from "@/api/localVirtua";
import { getRuntimePlatform } from "@/api/runtime";
import { virtuaClient } from "@/api/virtuaClient";
import { proxmoxClient } from "@/api/proxmoxClient";
import { ProxmoxAuthPage } from "@/pages/ProxmoxAuthPage";
import { ProxmoxResourcesPage } from "@/pages/ProxmoxResourcesPage";
import { ProxmoxDetailPage } from "@/pages/ProxmoxDetailPage";
import { AuthPage } from "@/pages/AuthPage";
import { Dashboard } from "@/pages/Dashboard";
import { ConsolePage } from "@/pages/ConsolePage";
import { ResourcePage } from "@/pages/ResourcePage";
import { ResourceDetailPage } from "@/pages/ResourceDetailPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { LocalSettingsPage } from "@/pages/LocalSettingsPage";
import { StoragePage } from "@/pages/StoragePage";
import { TasksPage } from "@/pages/TasksPage";
import { UsageModePage } from "@/pages/UsageModePage";
import { UnifiedPage } from "@/pages/UnifiedPage";
import { DisposablePage } from "@/pages/DisposablePage";
import { DisposableStopDialog } from "@/components/DisposableStopDialog";
import { cloudDisposableApi, localDisposableApi } from "@/api/disposable";
import type { UsageMode, VirtuaConnection, VirtuaNode, VirtuaResource, VirtuaTask, VirtuaUser } from "@/types";

const engineLabels = { qemu: "QEMU", lxc: "LXC (Incus)", docker: "Docker" } as const;

/**
 * Local mode installs what a requested feature needs — but an installation can
 * raise an administrator prompt, so it is always the user's call.
 */
const confirmEngineInstall: EngineInstallPrompt = (engine, detail) =>
  window.confirm(
    `${engineLabels[engine]} est requis pour cette action.\n\n${detail}\n\n` +
      "Installer et preparer maintenant ? Votre systeme peut demander une autorisation administrateur.",
  );

function nodesFromResources(resources: VirtuaResource[]): VirtuaNode[] {
  const names = Array.from(new Set(resources.map((resource) => resource.node)));
  return names.map((name) => ({
    id: name,
    name,
    host: name,
    role: "worker",
    status: "online",
    cpuUsage: 0,
    memoryUsage: 0,
    storageUsage: 0,
    vmCount: resources.filter((resource) => resource.node === name && resource.kind === "vm").length,
    lxcCount: resources.filter((resource) => resource.node === name && resource.kind === "lxc").length,
    dockerCount: resources.filter((resource) => resource.node === name && resource.kind === "docker").length,
  }));
}

/**
 * A poll that returns what is already on screen must not re-render every
 * page: with a few dozen resources that was most of the UI's idle CPU.
 */
function sameJson<T>(previous: T, next: T) {
  return previous === next || JSON.stringify(previous) === JSON.stringify(next);
}

function keepIfSame<T>(next: T) {
  return (previous: T) => (sameJson(previous, next) ? previous : next);
}

export default function App() {
  const [usageMode, setUsageMode] = useState<"unset" | UsageMode>(() => modeStore.get());
  const [user, setUser] = useState<VirtuaUser | null>(null);
  const [connection, setConnection] = useState<VirtuaConnection | null>(null);
  const [nodes, setNodes] = useState<VirtuaNode[]>([]);
  const [resources, setResources] = useState<VirtuaResource[]>([]);
  const [tasks, setTasks] = useState<VirtuaTask[]>([]);
  const [needsLocalSetup, setNeedsLocalSetup] = useState(false);
  const [hostArch, setHostArch] = useState<string | null>(null);
  const [allowLocalMode, setAllowLocalMode] = useState(true);
  const [isLoading, setLoading] = useState(true);
  const [isAuthenticated, setAuthenticated] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isRefreshingRef = useRef(false);
  /** Consecutive failed cloud refreshes, for the polling back-off. */
  const failuresRef = useRef(0);

  async function loadCloudData({ restore = true }: { restore?: boolean } = {}) {
    setLoading(true);
    setLoadError(null);
    try {
      if (restore) {
        const restored = await virtuaClient.restoreSession();
        if (!restored) {
          setAuthenticated(false);
          setLoading(false);
          return;
        }
      }

      const [nextUser, nextConnection] = await Promise.all([
        virtuaClient.getCurrentUser(),
        virtuaClient.getConnection(),
      ]);

      setUser(nextUser);
      setConnection(nextConnection);
      setAuthenticated(true);

      try {
        const [nextResources, nextTasks] = await Promise.all([
          virtuaClient.listAccessibleResources(),
          virtuaClient.listTasks(),
        ]);
        setNodes(nodesFromResources(nextResources));
        setResources(nextResources);
        setTasks(nextTasks);
      } catch (resourceError) {
        setNodes([]);
        setResources([]);
        setTasks([]);
        setLoadError(resourceError instanceof Error ? resourceError.message : "Inventaire impossible a charger");
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Chargement impossible");
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }

  async function loadProxmoxData({ restore = true }: { restore?: boolean } = {}) {
    setLoading(true);
    setLoadError(null);
    try {
      if (restore) {
        const restored = await proxmoxClient.restore();
        if (!restored) {
          setAuthenticated(false);
          return;
        }
      }
      const [inventory, nextTasks] = await Promise.all([proxmoxClient.inventory(), proxmoxClient.listTasks().catch(() => [])]);
      setUser(proxmoxClient.getUser());
      setConnection(proxmoxClient.getConnection());
      setNodes(inventory.nodes);
      setResources(inventory.resources);
      setTasks(nextTasks);
      setAuthenticated(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Connexion Proxmox impossible");
      setAuthenticated(false);
    } finally {
      setLoading(false);
    }
  }

  async function loadLocalData() {
    setLoading(true);
    setLoadError(null);
    try {
      const diagnostics = await localVirtua.diagnostics();
      if (!diagnostics.ready) { setNeedsLocalSetup(true); setAuthenticated(false); return; }
      setNeedsLocalSetup(false);
      const [nextResources, metrics] = await Promise.all([
        localVirtua.listResources(),
        localVirtua.hostMetrics().catch(() => null),
      ]);
      const nextTasks = localVirtua.listTasks();
      setHostArch(diagnostics.hostArch);
      setUser(localVirtua.getUser());
      setConnection(localVirtua.getConnection());
      setNodes(localVirtua.nodesFromResources(nextResources, metrics));
      setResources(nextResources);
      setTasks(nextTasks);
      setAuthenticated(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Mode local impossible a charger");
      setNeedsLocalSetup(true);
      setAuthenticated(false);
      setUser(localVirtua.getUser());
      setConnection(localVirtua.getConnection());
      setNodes(localVirtua.nodesFromResources([]));
      setResources([]);
      setTasks(localVirtua.listTasks());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let disposed = false;
    void getRuntimePlatform().then((platform) => {
      if (disposed) return;
      const localAllowed = !platform.mobile;
      setAllowLocalMode(localAllowed);
      if (!localAllowed) {
        if (modeStore.get() !== "cloud") {
          modeStore.set("cloud");
        }
        setUsageMode("cloud");
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (usageMode === "unset") {
      setLoading(false);
      return;
    }
    if (usageMode === "local") {
      void loadLocalData();
      return;
    }
    if (usageMode === "proxmox") {
      void loadProxmoxData();
      return;
    }
    void loadCloudData();
  }, [usageMode]);

  useEffect(() => {
    const blockDefaultContextMenu = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("contextmenu", blockDefaultContextMenu);
    return () => document.removeEventListener("contextmenu", blockDefaultContextMenu);
  }, []);

  useEffect(() => {
    const refreshTasks = () => {
      if (usageMode === "local") {
        setTasks(localVirtua.listTasks());
        return;
      }
      if (usageMode === "proxmox") {
        void proxmoxClient.listTasks().then(setTasks).catch(() => undefined);
        return;
      }
      void virtuaClient.listTasks().then(setTasks).catch(() => undefined);
    };
    window.addEventListener("virtua-tasks-changed", refreshTasks);
    return () => window.removeEventListener("virtua-tasks-changed", refreshTasks);
  }, [usageMode]);

  const refreshInventory = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    if (isRefreshingRef.current && silent) return;
    isRefreshingRef.current = true;
    if (!silent) setLoadError(null);
    try {
      if (usageMode === "local") {
        // The host architecture cannot change while the app runs: it was
        // loaded once with the local mode.
        const [nextResources, metrics] = await Promise.all([
          localVirtua.listResources(),
          localVirtua.hostMetrics().catch(() => null),
        ]);
        setNodes(keepIfSame(localVirtua.nodesFromResources(nextResources, metrics)));
        setResources(keepIfSame(nextResources));
        setTasks(keepIfSame(localVirtua.listTasks()));
        setConnection((current) => current ? { ...current, lastSync: new Date().toISOString() } : current);
        return;
      }
      if (usageMode === "proxmox") {
        const [inventory, nextTasks] = await Promise.all([proxmoxClient.inventory(), proxmoxClient.listTasks().catch(() => [])]);
        setNodes(keepIfSame(inventory.nodes));
        setResources(keepIfSame(inventory.resources));
        setTasks(keepIfSame(nextTasks));
        setConnection((current) => current ? { ...current, lastSync: new Date().toISOString() } : current);
        failuresRef.current = 0;
        return;
      }
      const [nextResources, nextTasks] = await Promise.all([
        virtuaClient.listAccessibleResources(),
        virtuaClient.listTasks(),
      ]);
      setNodes(keepIfSame(nodesFromResources(nextResources)));
      setResources(keepIfSame(nextResources));
      setTasks(keepIfSame(nextTasks));
      setConnection((current) => current ? { ...current, lastSync: new Date().toISOString() } : current);
      failuresRef.current = 0;
    } catch (error) {
      failuresRef.current += 1;
      if (!silent) setLoadError(error instanceof Error ? error.message : "Inventaire impossible a charger");
    } finally {
      isRefreshingRef.current = false;
    }
  }, [usageMode]);

  useEffect(() => {
    if (!isAuthenticated) return;
    let disposed = false;
    let timer = 0;
    // Fast while the user looks at the window, slower in the background, and
    // backing off while a server is unreachable (up to one minute) instead of
    // hammering it — and a VDM with many nodes — every three seconds.
    const period = () => {
      if (usageMode === "local") return document.hasFocus() ? 5000 : 15000;
      const base = document.hasFocus() ? 3000 : 15000;
      return Math.min(60000, base * 2 ** Math.min(failuresRef.current, 4));
    };
    // A chained timeout (rather than setInterval) cannot pile refreshes up when
    // one poll takes longer than the period — a slow host used to queue them
    // until the UI stopped responding.
    let running = false;
    const tick = async () => {
      running = true;
      try {
        if (!document.hidden) await refreshInventory({ silent: true });
      } finally {
        running = false;
      }
      if (!disposed) timer = window.setTimeout(() => void tick(), period());
    };
    timer = window.setTimeout(() => void tick(), period());
    // Coming back to the window refreshes at once rather than at the end of a
    // background period (a poll in flight already does).
    const onFocus = () => {
      if (running) return;
      window.clearTimeout(timer);
      void tick();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [isAuthenticated, refreshInventory, usageMode]);

  const logout = async () => {
    if (usageMode === "cloud") {
      await virtuaClient.logout();
    }
    if (usageMode === "proxmox") {
      await proxmoxClient.logout().catch(() => undefined);
    }
    setUser(null);
    setConnection(null);
    setNodes([]);
    setResources([]);
    setTasks([]);
    setAuthenticated(false);
    setUsageMode("unset");
    modeStore.clear();
  };

  const selectMode = (mode: UsageMode) => {
    modeStore.set(mode);
    setUsageMode(mode);
  };

  const switchMode = () => {
    if (usageMode === "proxmox") {
      backToModeSelection();
      return;
    }
    const nextMode = usageMode === "local" ? "cloud" : "local";
    modeStore.set(nextMode);
    setAuthenticated(false);
    setUsageMode(nextMode);
  };

  const backToModeSelection = () => {
    modeStore.clear();
    setUsageMode("unset");
    setAuthenticated(false);
    setLoadError(null);
  };

  if (isLoading) {
    return (
      <div className="grid h-screen place-items-center bg-virtua-bg text-virtua-text">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-virtua-accent border-t-transparent" />
      </div>
    );
  }

  if (usageMode === "unset") {
    return <UsageModePage allowLocal={allowLocalMode} onSelect={selectMode} />;
  }

  if (usageMode === "local" && needsLocalSetup) {
    return <div className="min-h-screen bg-virtua-bg p-8 text-virtua-text"><div className="mx-auto max-w-3xl space-y-4">
      <h1 className="text-2xl font-semibold">Virtua Desktop {__APP_VERSION__}</h1>
      <EngineSetup requiredOnly onReady={() => void loadLocalData()} />
      <button className="virtua-button" onClick={() => selectMode("cloud")}>Se connecter plutôt à un serveur Virtua (Cloud)</button>
    </div></div>;
  }

  if (!isAuthenticated && usageMode === "proxmox") {
    return <ProxmoxAuthPage initialError={loadError} onBack={backToModeSelection} onAuthenticated={() => void loadProxmoxData({ restore: false })} />;
  }

  if (usageMode === "proxmox") {
    const pveAction = (resourceId: string, action: Parameters<typeof proxmoxClient.runAction>[1]) => proxmoxClient.runAction(resourceId, action);
    return (
      <Layout connection={connection} nodes={nodes} resources={resources} tasks={tasks} user={user} onLogout={logout} onSwitchMode={switchMode} loadError={loadError} usageMode={usageMode}>
        <Routes>
          <Route path="/" element={<ConsolePage resources={resources} user={user} runResourceAction={pveAction} onChanged={() => refreshInventory()} />} />
          <Route path="/console/:resourceId" element={<ConsolePage resources={resources} user={user} runResourceAction={pveAction} onChanged={() => refreshInventory()} />} />
          <Route path="/dashboard" element={<Dashboard connection={connection} nodes={nodes} resources={resources} tasks={tasks} usageMode={usageMode} />} />
          <Route path="/inventory" element={<ProxmoxResourcesPage kind="all" resources={resources} onChanged={() => refreshInventory()} />} />
          <Route path="/vms" element={<ProxmoxResourcesPage kind="vm" resources={resources} onChanged={() => refreshInventory()} />} />
          <Route path="/lxc" element={<ProxmoxResourcesPage kind="lxc" resources={resources} onChanged={() => refreshInventory()} />} />
          <Route path="/resources/:resourceId" element={<ProxmoxDetailPage resources={resources} onChanged={() => refreshInventory()} />} />
          <Route path="/tasks" element={<TasksPage tasks={tasks} onChanged={() => void proxmoxClient.listTasks().then(setTasks)} />} />
          <Route path="*" element={<ProxmoxResourcesPage kind="all" resources={resources} onChanged={() => refreshInventory()} />} />
        </Routes>
      </Layout>
    );
  }

  if (!isAuthenticated) {
    return <AuthPage initialError={loadError} onBack={backToModeSelection} onAuthenticated={() => loadCloudData({ restore: false })} />;
  }

  return (
    <Layout connection={connection} nodes={nodes} resources={resources} tasks={tasks} user={user} onLogout={logout} onSwitchMode={switchMode} loadError={loadError} usageMode={usageMode}>
      <Routes>
        <Route path="/" element={usageMode === "local"
          ? <Dashboard connection={connection} nodes={nodes} resources={resources} tasks={tasks} usageMode={usageMode} />
          : <ConsolePage resources={resources} user={user} onChanged={() => refreshInventory()} />} />
        <Route path="/console/:resourceId" element={<ConsolePage resources={resources} user={user} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/dashboard" element={<Dashboard connection={connection} nodes={nodes} resources={resources} tasks={tasks} usageMode={usageMode} />} />
        <Route path="/inventory" element={<ResourcePage kind="all" resources={resources} user={user} usageMode={usageMode} hostArch={usageMode === "local" ? hostArch : null} listCreateOptions={usageMode === "local" ? (type) => localVirtua.listCreateOptions(type) : undefined} createResource={usageMode === "local" ? (payload) => localVirtua.createResource(payload, confirmEngineInstall) : undefined} quickCreate={usageMode === "local" ? (os, name) => localVirtua.quickCreate(os, name) : (os, name) => virtuaClient.quickCreate(os, name)} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/vms" element={<ResourcePage kind="vm" resources={resources} user={user} usageMode={usageMode} hostArch={usageMode === "local" ? hostArch : null} listCreateOptions={usageMode === "local" ? (type) => localVirtua.listCreateOptions(type) : undefined} createResource={usageMode === "local" ? (payload) => localVirtua.createResource(payload, confirmEngineInstall) : undefined} quickCreate={usageMode === "local" ? (os, name) => localVirtua.quickCreate(os, name) : (os, name) => virtuaClient.quickCreate(os, name)} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/lxc" element={<ResourcePage kind="lxc" resources={resources} user={user} usageMode={usageMode} hostArch={usageMode === "local" ? hostArch : null} listCreateOptions={usageMode === "local" ? (type) => localVirtua.listCreateOptions(type) : undefined} createResource={usageMode === "local" ? (payload) => localVirtua.createResource(payload, confirmEngineInstall) : undefined} quickCreate={usageMode === "local" ? (os, name) => localVirtua.quickCreate(os, name) : (os, name) => virtuaClient.quickCreate(os, name)} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/docker" element={<ResourcePage kind="docker" resources={resources} user={user} usageMode={usageMode} hostArch={usageMode === "local" ? hostArch : null} listCreateOptions={usageMode === "local" ? (type) => localVirtua.listCreateOptions(type) : undefined} createResource={usageMode === "local" ? (payload) => localVirtua.createResource(payload, confirmEngineInstall) : undefined} quickCreate={usageMode === "local" ? (os, name) => localVirtua.quickCreate(os, name) : (os, name) => virtuaClient.quickCreate(os, name)} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/resources/:resourceId" element={<ResourceDetailPage resources={resources} user={user} updateResource={usageMode === "local" ? (resourceId, payload) => localVirtua.updateResource(resourceId, payload) : undefined} deleteResource={usageMode === "local" ? (resourceId, deleteDisks) => localVirtua.deleteResource(resourceId, Boolean(deleteDisks)) : undefined} listSnapshots={usageMode === "local" ? (resourceId) => localVirtua.listSnapshots(resourceId) : undefined} createSnapshot={usageMode === "local" ? (resourceId, name) => localVirtua.createSnapshot(resourceId, name) : (resourceId, name) => virtuaClient.snapshot(resourceId, name)} deleteSnapshot={usageMode === "local" ? (resourceId, snapshotId) => localVirtua.deleteSnapshot(resourceId, snapshotId) : undefined} rollbackSnapshot={usageMode === "local" ? (resourceId, snapshotId) => localVirtua.rollbackSnapshot(resourceId, snapshotId) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/storage" element={usageMode === "local" ? <StoragePage resources={resources} hostArch={hostArch} onChanged={() => refreshInventory()} /> : <ResourcePage kind="all" resources={resources} user={user} onChanged={() => refreshInventory()} />} />
        <Route path="/tasks" element={<TasksPage tasks={tasks} onClear={() => usageMode === "local" ? localVirtua.clearTasks() : virtuaClient.clearTasks()} onChanged={() => usageMode === "local" ? setTasks(localVirtua.listTasks()) : void virtuaClient.listTasks().then(setTasks)} />} />
        <Route path="/settings" element={usageMode === "local" ? <LocalSettingsPage /> : <SettingsPage connection={connection} />} />
        {usageMode === "local" ? <Route path="/unified" element={<UnifiedPage onChanged={() => refreshInventory()} />} /> : null}
        <Route path="/disposable" element={<DisposablePage resources={resources} api={usageMode === "local" ? localDisposableApi : cloudDisposableApi} onChanged={() => void refreshInventory()} />} />
      </Routes>
      <DisposableStopDialog resources={resources} act={usageMode === "local" ? localDisposableApi.act : cloudDisposableApi.act} onChanged={() => void refreshInventory()} />
    </Layout>
  );
}
