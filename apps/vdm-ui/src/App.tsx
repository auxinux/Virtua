import { Suspense, lazy, useEffect, useState } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useVdmAuth } from "@/hooks/useVdmAuth";
import { Sidebar } from "@/components/Layout/Sidebar";
import { TopBar } from "@/components/Layout/TopBar";

const Login = lazy(() => import("@/pages/Login"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const InventoryPage = lazy(() => import("@/pages/InventoryPage"));
const NodesPage = lazy(() => import("@/pages/NodesPage"));
const VmsPage = lazy(() => import("@/pages/VmsPage"));
const LxcPage = lazy(() => import("@/pages/LxcPage"));
const DockerPage = lazy(() => import("@/pages/DockerPage"));
const DockerComposePage = lazy(() => import("@/pages/DockerComposePage"));
const DockerVolumesPage = lazy(() => import("@/pages/DockerVolumesPage"));
const StoragePage = lazy(() => import("@/pages/StoragePage"));
const TasksPage = lazy(() => import("@/pages/TasksPage"));
const BackupsPage = lazy(() => import("@/pages/BackupsPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));
const ConsoleWindowPage = lazy(() => import("@/pages/ConsoleWindowPage"));

function Spinner() {
  return (
    <div className="flex items-center justify-center h-full min-h-[200px]">
      <div className="w-8 h-8 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const [apiError, setApiError] = useState<string | null>(null);
  useEffect(() => {
    const listener = (event: Event) => {
      setApiError((event as CustomEvent<string>).detail || "The operation failed");
      window.setTimeout(() => setApiError(null), 8000);
    };
    window.addEventListener("vdm-api-error", listener);
    return () => window.removeEventListener("vdm-api-error", listener);
  }, []);
  return (
    <div className="flex h-screen overflow-hidden bg-vdm-bg">
      <Sidebar />
      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <TopBar />
        {apiError && <div className="mx-4 mt-3 rounded-lg border border-vdm-danger/40 bg-vdm-danger/10 px-3 py-2 text-sm text-vdm-danger">{apiError}</div>}
        <main className="flex-1 overflow-auto p-4">
          {children}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const { isAuthenticated, isLoading, user } = useVdmAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-vdm-bg">
        <div className="w-8 h-8 border-2 border-vdm-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="*" element={<Suspense fallback={<Spinner />}><Login /></Suspense>} />
      </Routes>
    );
  }

  if (window.location.pathname === "/console" && !user?.mustChangePassword) {
    return <Suspense fallback={<Spinner />}><ConsoleWindowPage /></Suspense>;
  }

  return (
    <AppShell>
      <Suspense fallback={<Spinner />}>
        {user?.mustChangePassword ? <Routes>
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/settings" replace />} />
        </Routes> : <Routes>
          <Route path="/" element={<Navigate to={user?.mustChangePassword ? "/settings" : "/dashboard"} replace />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/inventory/:type/:node/:name/*" element={<InventoryPage />} />
          <Route path="/nodes" element={<NodesPage />} />
          <Route path="/vms" element={<VmsPage />} />
          <Route path="/lxc" element={<LxcPage />} />
          <Route path="/docker" element={<DockerPage />} />
          <Route path="/docker/compose" element={<DockerComposePage />} />
          <Route path="/docker/volumes" element={<DockerVolumesPage />} />
          <Route path="/storage" element={<StoragePage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/backups" element={<BackupsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to={user?.mustChangePassword ? "/settings" : "/dashboard"} replace />} />
        </Routes>}
      </Suspense>
    </AppShell>
  );
}
