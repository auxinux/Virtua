import { useCallback, useEffect, useRef, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { EngineSetup } from "@/components/EngineSetup";
import { Layout } from "@/components/Layout";
import { localVirtua, modeStore } from "@/api/localVirtua";
import { getRuntimePlatform } from "@/api/runtime";
import { virtuaClient } from "@/api/virtuaClient";
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
import type { UsageMode, VirtuaConnection, VirtuaNode, VirtuaResource, VirtuaTask, VirtuaUser } from "@/types";

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

  async function loadLocalData() {
    setLoading(true);
    setLoadError(null);
    try {
      const check = await localVirtua.diagnostics();
      if (!check.ready) { setNeedsLocalSetup(true); setAuthenticated(false); return; }
      setNeedsLocalSetup(false);
      const [diagnostics, nextResources, nextTasks] = await Promise.all([
        localVirtua.diagnostics(),
        localVirtua.listResources(),
        Promise.resolve(localVirtua.listTasks()),
      ]);
      const metrics = await localVirtua.hostMetrics().catch(() => null);
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
        const [diagnostics, nextResources, metrics] = await Promise.all([
          localVirtua.diagnostics(),
          localVirtua.listResources(),
          localVirtua.hostMetrics().catch(() => null),
        ]);
        setHostArch(diagnostics.hostArch);
        setNodes(localVirtua.nodesFromResources(nextResources, metrics));
        setResources(nextResources);
        setTasks(localVirtua.listTasks());
        setConnection((current) => current ? { ...current, lastSync: new Date().toISOString() } : current);
        return;
      }
      const [nextResources, nextTasks] = await Promise.all([
        virtuaClient.listAccessibleResources(),
        virtuaClient.listTasks(),
      ]);
      setNodes(nodesFromResources(nextResources));
      setResources(nextResources);
      setTasks(nextTasks);
      setConnection((current) => current ? { ...current, lastSync: new Date().toISOString() } : current);
    } catch (error) {
      if (!silent) setLoadError(error instanceof Error ? error.message : "Inventaire impossible a charger");
    } finally {
      isRefreshingRef.current = false;
    }
  }, [usageMode]);

  useEffect(() => {
    if (!isAuthenticated) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshInventory({ silent: true });
    }, usageMode === "local" ? 7000 : 3000);
    return () => window.clearInterval(interval);
  }, [isAuthenticated, refreshInventory]);

  const logout = async () => {
    if (usageMode === "cloud") {
      await virtuaClient.logout();
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
      <h1 className="text-2xl font-semibold">Virtua Desktop 0.2.0</h1>
      <EngineSetup requiredOnly onReady={() => void loadLocalData()} />
      <button className="virtua-button" onClick={backToModeSelection}>Retour au choix Local / Cloud</button>
    </div></div>;
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
        <Route path="/inventory" element={<ResourcePage kind="all" resources={resources} user={user} usageMode={usageMode} hostArch={hostArch} listCreateOptions={usageMode === "local" ? (type) => localVirtua.listCreateOptions(type) : undefined} createResource={usageMode === "local" ? (payload) => localVirtua.createResource(payload) : undefined} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/vms" element={<ResourcePage kind="vm" resources={resources} user={user} usageMode={usageMode} hostArch={hostArch} listCreateOptions={usageMode === "local" ? (type) => localVirtua.listCreateOptions(type) : undefined} createResource={usageMode === "local" ? (payload) => localVirtua.createResource(payload) : undefined} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/lxc" element={<ResourcePage kind="lxc" resources={resources} user={user} usageMode={usageMode} hostArch={hostArch} listCreateOptions={usageMode === "local" ? (type) => localVirtua.listCreateOptions(type) : undefined} createResource={usageMode === "local" ? (payload) => localVirtua.createResource(payload) : undefined} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/docker" element={<ResourcePage kind="docker" resources={resources} user={user} usageMode={usageMode} hostArch={hostArch} listCreateOptions={usageMode === "local" ? (type) => localVirtua.listCreateOptions(type) : undefined} createResource={usageMode === "local" ? (payload) => localVirtua.createResource(payload) : undefined} runResourceAction={usageMode === "local" ? (resourceId, action) => localVirtua.runAction(resourceId, action) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/resources/:resourceId" element={<ResourceDetailPage resources={resources} user={user} updateResource={usageMode === "local" ? (resourceId, payload) => localVirtua.updateResource(resourceId, payload) : undefined} deleteResource={usageMode === "local" ? (resourceId, deleteDisks) => localVirtua.deleteResource(resourceId, Boolean(deleteDisks)) : undefined} listSnapshots={usageMode === "local" ? (resourceId) => localVirtua.listSnapshots(resourceId) : undefined} createSnapshot={usageMode === "local" ? (resourceId, name) => localVirtua.createSnapshot(resourceId, name) : undefined} deleteSnapshot={usageMode === "local" ? (resourceId, snapshotId) => localVirtua.deleteSnapshot(resourceId, snapshotId) : undefined} rollbackSnapshot={usageMode === "local" ? (resourceId, snapshotId) => localVirtua.rollbackSnapshot(resourceId, snapshotId) : undefined} onChanged={() => refreshInventory()} />} />
        <Route path="/storage" element={usageMode === "local" ? <StoragePage resources={resources} hostArch={hostArch} onChanged={() => refreshInventory()} /> : <ResourcePage kind="all" resources={resources} user={user} onChanged={() => refreshInventory()} />} />
        <Route path="/tasks" element={<TasksPage tasks={tasks} onClear={() => usageMode === "local" ? localVirtua.clearTasks() : virtuaClient.clearTasks()} onChanged={() => usageMode === "local" ? setTasks(localVirtua.listTasks()) : void virtuaClient.listTasks().then(setTasks)} />} />
        <Route path="/settings" element={usageMode === "local" ? <LocalSettingsPage /> : <SettingsPage connection={connection} />} />
      </Routes>
    </Layout>
  );
}
