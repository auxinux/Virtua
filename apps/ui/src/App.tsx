import React, { Suspense, lazy } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { Sidebar } from "./components/Layout/Sidebar";
import { TopBar } from "./components/Layout/TopBar";
import { TaskDrawer } from "./components/Layout/TaskDrawer";
import { useAuth } from "./utils/useAuth";
import { initializeTheme } from "./utils/theme";
import { AccessDenied } from "./components/auth/AccessDenied";

class RouteErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; message?: string }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: undefined };
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Unexpected interface error",
    };
  }

  componentDidCatch(error: unknown) {
    console.error("Route render failed", error);
  }

  render() {
    if (this.state.hasError) {
      return <AccessDenied title="Page failed to render" message={this.state.message ?? "Unexpected interface error"} />;
    }
    return this.props.children;
  }
}

// Lazy-loaded pages
const Login = lazy(() => import("./pages/Login"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const NodeOverviewPage = lazy(() => import("./pages/NodeOverviewPage"));
const CreateWizardPage = lazy(() => import("./pages/CreateWizardPage"));
const HostOverview = lazy(() => import("./pages/HostOverview"));
const HealthPage = lazy(() => import("./pages/HealthPage"));
const HostShell = lazy(() => import("./pages/HostShell"));
const ConsolePage = lazy(() => import("./pages/ConsolePage"));
const DesktopDevicesPage = lazy(() => import("./pages/DesktopDevicesPage"));
const VmList = lazy(() => import("./pages/vm/VmList"));
const VmDetail = lazy(() => import("./pages/vm/VmDetail"));
const VmCreate = lazy(() => import("./pages/vm/VmCreate"));
const LxcList = lazy(() => import("./pages/lxc/LxcList"));
const LxcDetail = lazy(() => import("./pages/lxc/LxcDetail"));
const LxcCreate = lazy(() => import("./pages/lxc/LxcCreate"));
const DockerList = lazy(() => import("./pages/docker/DockerList"));
const DockerDetail = lazy(() => import("./pages/docker/DockerDetail"));
const DockerCreate = lazy(() => import("./pages/docker/DockerCreate"));
const DockerCompose = lazy(() => import("./pages/docker/DockerCompose"));
const DockerVolumes = lazy(() => import("./pages/docker/DockerVolumes"));
const StorageDashboard = lazy(() => import("./pages/storage/StorageDashboard"));
const PoolDetail = lazy(() => import("./pages/storage/PoolDetail"));
const IsoManager = lazy(() => import("./pages/storage/IsoManager"));
const TemplatesPage = lazy(() => import("./pages/storage/TemplatesPage"));
const BackupsPage = lazy(() => import("./pages/storage/BackupsPage"));
const NetworkPage = lazy(() => import("./pages/network/NetworkPage"));
const FirewallPage = lazy(() => import("./pages/network/FirewallPage"));
const UserList = lazy(() => import("./pages/users/UserList"));
const UserDetail = lazy(() => import("./pages/users/UserDetail"));
const AuditPage = lazy(() => import("./pages/AuditPage"));
const CrashesPage = lazy(() => import("./pages/CrashesPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const AboutPage = lazy(() => import("./pages/AboutPage"));
const ChangePassword = lazy(() => import("./pages/ChangePassword"));

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-6 h-6 border-2 border-accent-blue border-t-transparent rounded-full animate-spin" />
    </div>
  );
}

function ProtectedLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) return <LoadingSpinner />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mustChangePassword) return <Navigate to="/change-password" replace />;

  const params = new URLSearchParams(location.search);
  const detachedConsole = location.pathname.startsWith("/vms/") && (params.get("detached") === "serial" || params.get("detached") === "vnc" || params.get("detached") === "spice");

  if (detachedConsole) {
    return (
      <div className="h-full bg-surface-800">
        <Suspense fallback={<LoadingSpinner />}>
          <RouteErrorBoundary>{children}</RouteErrorBoundary>
        </Suspense>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <TopBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto bg-surface-800 p-4">
          <Suspense fallback={<LoadingSpinner />}>
            <RouteErrorBoundary>{children}</RouteErrorBoundary>
          </Suspense>
        </main>
      </div>
      <TaskDrawer />
    </div>
  );
}

function HomeRedirect() {
  const { capabilities, isLoading } = useAuth();
  if (isLoading) return <LoadingSpinner />;
  return <Navigate to={capabilities?.defaultRoute ?? "/access-denied"} replace />;
}

function SectionRoute({
  section,
  children,
}: {
  section: keyof NonNullable<ReturnType<typeof useAuth>["capabilities"]>["sections"];
  children: React.ReactNode;
}) {
  const { capabilities, isLoading } = useAuth();
  if (isLoading) return <LoadingSpinner />;
  if (!capabilities?.sections[section]) {
    return <AccessDenied />;
  }
  return <>{children}</>;
}

function ResourceRoute({
  resourceType,
  paramName,
  children,
}: {
  resourceType: "vm" | "lxc" | "docker";
  paramName: "name" | "id";
  children: React.ReactNode;
}) {
  const params = useParams();
  const resourceName = params[paramName];
  const { capabilities, isLoading } = useAuth();
  if (isLoading) return <LoadingSpinner />;
  if (!capabilities || !resourceName) return <AccessDenied />;
  if (capabilities.role === "ADMIN") return <>{children}</>;

  const allowed =
    resourceType === "vm"
      ? capabilities.resources.vms.some((entry) => entry.name === resourceName)
      : resourceType === "lxc"
        ? capabilities.resources.lxc.some((entry) => entry.name === resourceName)
        : capabilities.resources.docker.some((entry) => entry.id === resourceName || entry.id.startsWith(resourceName) || resourceName.startsWith(entry.id));

  if (!allowed) {
    return <AccessDenied message="You do not have the required rights to access this resource." />;
  }
  return <>{children}</>;
}

export default function App() {
  React.useEffect(() => {
    initializeTheme();
  }, []);

  return (
    <BrowserRouter>
      <Suspense fallback={<LoadingSpinner />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/change-password" element={<ChangePassword />} />
          <Route path="/access-denied" element={<ProtectedLayout><AccessDenied /></ProtectedLayout>} />

          <Route path="/" element={<ProtectedLayout><HomeRedirect /></ProtectedLayout>} />
          <Route path="/nodes/:name" element={<ProtectedLayout><SectionRoute section="host"><NodeOverviewPage /></SectionRoute></ProtectedLayout>} />
          <Route path="/nodes/:name/settings" element={<ProtectedLayout><SectionRoute section="settings"><SettingsPage /></SectionRoute></ProtectedLayout>} />
          <Route path="/host" element={<ProtectedLayout><SectionRoute section="host"><HostOverview /></SectionRoute></ProtectedLayout>} />
          <Route path="/dashboard" element={<ProtectedLayout><SectionRoute section="dashboard"><Dashboard /></SectionRoute></ProtectedLayout>} />
          <Route path="/console" element={<ProtectedLayout><ConsolePage /></ProtectedLayout>} />
          <Route path="/account" element={<ProtectedLayout><DesktopDevicesPage /></ProtectedLayout>} />
          <Route path="/about" element={<ProtectedLayout><AboutPage /></ProtectedLayout>} />
          {/* Legacy path kept so old links/bookmarks still resolve. */}
          <Route path="/desktop" element={<Navigate to="/account" replace />} />
          <Route path="/health" element={<ProtectedLayout><SectionRoute section="health"><HealthPage /></SectionRoute></ProtectedLayout>} />
          <Route path="/host/shell" element={<ProtectedLayout><SectionRoute section="hostShell"><HostShell /></SectionRoute></ProtectedLayout>} />
          <Route path="/create" element={<ProtectedLayout><SectionRoute section="createWizard"><CreateWizardPage /></SectionRoute></ProtectedLayout>} />

          <Route path="/vms" element={<ProtectedLayout><SectionRoute section="vms"><VmList /></SectionRoute></ProtectedLayout>} />
          <Route path="/vms/create" element={<ProtectedLayout><SectionRoute section="vmCreate"><VmCreate /></SectionRoute></ProtectedLayout>} />
          <Route path="/vms/:name" element={<ProtectedLayout><ResourceRoute resourceType="vm" paramName="name"><VmDetail /></ResourceRoute></ProtectedLayout>} />

          <Route path="/lxc" element={<ProtectedLayout><SectionRoute section="lxc"><LxcList /></SectionRoute></ProtectedLayout>} />
          <Route path="/lxc/create" element={<ProtectedLayout><SectionRoute section="lxcCreate"><LxcCreate /></SectionRoute></ProtectedLayout>} />
          <Route path="/lxc/:name" element={<ProtectedLayout><ResourceRoute resourceType="lxc" paramName="name"><LxcDetail /></ResourceRoute></ProtectedLayout>} />

          <Route path="/docker" element={<ProtectedLayout><SectionRoute section="docker"><DockerList /></SectionRoute></ProtectedLayout>} />
          <Route path="/docker/create" element={<ProtectedLayout><SectionRoute section="dockerCreate"><DockerCreate /></SectionRoute></ProtectedLayout>} />
          <Route path="/docker/compose" element={<ProtectedLayout><SectionRoute section="docker"><DockerCompose /></SectionRoute></ProtectedLayout>} />
          <Route path="/docker/volumes" element={<ProtectedLayout><SectionRoute section="docker"><DockerVolumes /></SectionRoute></ProtectedLayout>} />
          <Route path="/docker/:id" element={<ProtectedLayout><ResourceRoute resourceType="docker" paramName="id"><DockerDetail /></ResourceRoute></ProtectedLayout>} />

          <Route path="/storage" element={<ProtectedLayout><SectionRoute section="storageOverview"><StorageDashboard /></SectionRoute></ProtectedLayout>} />
          <Route path="/storage/pools/:name" element={<ProtectedLayout><SectionRoute section="storageOverview"><PoolDetail /></SectionRoute></ProtectedLayout>} />
          <Route path="/nodes/:nodeName/storage/pools/:name" element={<ProtectedLayout><SectionRoute section="storageOverview"><PoolDetail /></SectionRoute></ProtectedLayout>} />
          <Route path="/storage/isos" element={<ProtectedLayout><SectionRoute section="isoLibrary"><IsoManager /></SectionRoute></ProtectedLayout>} />
          <Route path="/templates" element={<ProtectedLayout><TemplatesPage /></ProtectedLayout>} />
          <Route path="/storage/backups" element={<ProtectedLayout><SectionRoute section="backups"><BackupsPage /></SectionRoute></ProtectedLayout>} />

          <Route path="/network" element={<ProtectedLayout><SectionRoute section="network"><NetworkPage /></SectionRoute></ProtectedLayout>} />
          <Route path="/network/firewall" element={<ProtectedLayout><SectionRoute section="firewall"><FirewallPage /></SectionRoute></ProtectedLayout>} />

          <Route path="/users" element={<ProtectedLayout><SectionRoute section="users"><UserList /></SectionRoute></ProtectedLayout>} />
          <Route path="/users/:id" element={<ProtectedLayout><SectionRoute section="users"><UserDetail /></SectionRoute></ProtectedLayout>} />

          <Route path="/audit" element={<ProtectedLayout><SectionRoute section="audit"><AuditPage /></SectionRoute></ProtectedLayout>} />
          <Route path="/crashes" element={<ProtectedLayout><SectionRoute section="crashes"><CrashesPage /></SectionRoute></ProtectedLayout>} />
          <Route path="/settings" element={<ProtectedLayout><SectionRoute section="settings"><SettingsPage /></SectionRoute></ProtectedLayout>} />

          <Route path="*" element={<ProtectedLayout><HomeRedirect /></ProtectedLayout>} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
