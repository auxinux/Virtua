import { Boxes, ChevronsDown, ChevronsUp, Container, Expand, Minimize2, Monitor, PanelLeftClose, PanelLeftOpen, Play, RotateCcw, Search, Square } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router-dom";
import { GraphicalConsole } from "@/components/GraphicalConsole";
import { MetricBar } from "@/components/MetricBar";
import { StatusBadge } from "@/components/StatusBadge";
import { TextConsole } from "@/components/TextConsole";
import { virtuaClient } from "@/api/virtuaClient";
import type { ConsoleMode, PowerAction, ResourceKind, VirtuaResource, VirtuaUser } from "@/types";
import { useLanguage } from "@/i18n";
import { setConsolePrefs, useConsolePrefs } from "@/consolePrefs";

const kindIcons: Record<ResourceKind, typeof Monitor> = {
  vm: Monitor,
  lxc: Container,
  docker: Boxes,
};

function isRunningState(state: string) {
  return ["running", "run", "active", "started", "up"].includes(state.toLowerCase());
}

function isStoppedState(state: string) {
  return ["stopped", "stop", "inactive", "shutoff", "shut off", "down", "exited"].includes(state.toLowerCase());
}

function guestAgentLabel(resource: VirtuaResource, t: (k: string) => string) {
  if (resource.kind !== "vm") return "n/a";
  const agent = resource.guestAgent;
  if (!agent) return t("general.unknown");
  if (agent.running) return "actif"; // Could be translated if needed
  if (agent.installed === false) return "non installe";
  if (agent.installed) return agent.status ?? "installe";
  return agent.status ?? t("general.unknown");
}

function StopChoiceDialog({
  resource,
  onClose,
  onChoose,
  t,
}: {
  resource: VirtuaResource;
  onClose: () => void;
  onChoose: (action: PowerAction) => void;
  t: (k: string) => string;
}) {
  const local = resource.source === "local";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded border border-virtua-border bg-virtua-panel p-4 shadow-xl">
        <h2 className="text-lg font-semibold">{t("console.stop_title")} {resource.name}</h2>
        <p className="mt-2 text-sm text-virtua-muted">
          {t("console.stop_desc")}
        </p>
        <div className="mt-4 space-y-2">
          <button
            onClick={() => onChoose(local ? "shutdown" : "stop")}
            className="w-full rounded border border-virtua-border bg-black/15 px-3 py-3 text-left hover:bg-virtua-panelHover"
          >
            <span className="block text-sm font-medium">{t("console.stop_os")}</span>
            <span className="mt-1 block text-xs text-virtua-muted">
              {t("console.stop_os_desc")}
            </span>
          </button>
          {local ? (
            <button
              onClick={() => onChoose("stop")}
              className="w-full rounded border border-virtua-red/50 bg-virtua-red/10 px-3 py-3 text-left text-virtua-red hover:bg-virtua-red/15"
            >
              <span className="block text-sm font-medium">{t("console.stop_force")}</span>
              <span className="mt-1 block text-xs text-virtua-red/80">
                {t("console.stop_force_desc")}
              </span>
            </button>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end">
          <button onClick={onClose} className="virtua-button">{t("general.cancel")}</button>
        </div>
      </div>
    </div>
  );
}

function ResourceListItem({ resource, onContextMenu }: { resource: VirtuaResource; onContextMenu: (event: MouseEvent, resource: VirtuaResource) => void }) {
  const Icon = kindIcons[resource.kind];

  return (
    <NavLink
      to={`/console/${resource.id}`}
      onContextMenu={(event) => onContextMenu(event, resource)}
      className={({ isActive }) =>
        `block rounded border p-3 transition-colors ${
          isActive
            ? "border-virtua-accent bg-virtua-accentSoft/65"
            : "border-virtua-border bg-black/10 hover:bg-virtua-panelHover"
        }`
      }
    >
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded bg-black/25 text-virtua-accent">
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{resource.name}</p>
          <p className="truncate text-xs text-virtua-muted">{resource.node} / {resource.ip}</p>
        </div>
        <StatusBadge status={resource.state} />
      </div>
    </NavLink>
  );
}

function ResourceContextMenu({
  resource,
  x,
  y,
  onClose,
  onConsole,
  onConfig,
  onPower,
  t,
}: {
  resource: VirtuaResource;
  x: number;
  y: number;
  onClose: () => void;
  onConsole: () => void;
  onConfig: () => void;
  onPower: (action: PowerAction) => void;
  t: (k: string) => string;
}) {
  const running = isRunningState(resource.state);
  const stopped = isStoppedState(resource.state);
  const canStart = resource.permissions.canPower && stopped;
  const canStop = resource.permissions.canPower && running;
  const canRestart = resource.permissions.canPower && running;

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const run = (action: PowerAction) => {
    onPower(action);
    onClose();
  };

  return (
    <div
      className="fixed z-50 w-64 overflow-hidden rounded border border-virtua-border bg-virtua-panel shadow-xl"
      style={{ left: x, top: y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="border-b border-virtua-border px-3 py-2">
        <p className="truncate text-sm font-medium">{resource.name}</p>
        <p className="text-xs text-virtua-muted">{resource.kind.toUpperCase()} / {resource.state}</p>
      </div>
      <div className="p-1">
        <button disabled={!resource.permissions.canConsole} onClick={onConsole} className="flex h-8 w-full items-center rounded px-3 text-left text-sm text-virtua-text hover:bg-virtua-panelHover disabled:cursor-not-allowed disabled:opacity-40">
          {t("nav.console")}
        </button>
        <button onClick={onConfig} className="flex h-8 w-full items-center rounded px-3 text-left text-sm text-virtua-text hover:bg-virtua-panelHover">
          {t("console.config")}
        </button>
      </div>
      <div className="border-t border-virtua-border p-1">
        <p className="px-3 py-1 text-[11px] uppercase tracking-wider text-virtua-muted">{t("console.power")}</p>
        <button disabled={!canStart} onClick={() => run("start")} className="flex h-8 w-full items-center rounded px-3 text-left text-sm text-virtua-text hover:bg-virtua-panelHover disabled:cursor-not-allowed disabled:opacity-40">
          {t("console.start")}
        </button>
        <button disabled={!canRestart} onClick={() => run("restart")} className="flex h-8 w-full items-center rounded px-3 text-left text-sm text-virtua-text hover:bg-virtua-panelHover disabled:cursor-not-allowed disabled:opacity-40">
          {t("console.restart")}
        </button>
        <button disabled={!canStop} onClick={() => run("stop")} className="flex h-8 w-full items-center rounded px-3 text-left text-sm text-virtua-red hover:bg-virtua-panelHover disabled:cursor-not-allowed disabled:opacity-40">
          {t("console.stop")}
        </button>
      </div>
    </div>
  );
}

/** Fold the info bars, or everything around the console. The machine list carries its own fold button. */
function ConsoleViewControls({ t }: { t: (k: string) => string }) {
  const prefs = useConsolePrefs();
  const buttonClass = "virtua-icon-button !h-8 !w-8";
  return (
    <div className="flex gap-1">
      {!prefs.focus ? (
        <button
          className={buttonClass}
          title={prefs.detailsCollapsed ? t("console.show_details") : t("console.hide_details")}
          onClick={() => setConsolePrefs({ detailsCollapsed: !prefs.detailsCollapsed })}
        >
          {prefs.detailsCollapsed ? <ChevronsDown className="h-4 w-4" /> : <ChevronsUp className="h-4 w-4" />}
        </button>
      ) : null}
      <button
        className={buttonClass}
        title={prefs.focus ? t("console.exit_focus") : t("console.enter_focus")}
        onClick={() => setConsolePrefs({ focus: !prefs.focus })}
      >
        {prefs.focus ? <Minimize2 className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
      </button>
    </div>
  );
}

function ConsoleModeTabs({
  resource,
  mode,
  onMode,
  t,
}: {
  resource: VirtuaResource;
  mode: ConsoleMode;
  onMode: (mode: ConsoleMode) => void;
  t: (k: string) => string;
}) {
  return (
    <>
      {(resource.kind === "vm" ? ["graphical", "text"] as const : ["text", "graphical"] as const).map((nextMode) => {
        const disabled = !resource.consoleModes.includes(nextMode);
        return (
          <button
            key={nextMode}
            disabled={disabled}
            onClick={() => onMode(nextMode)}
            className={`h-7 rounded px-3 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
              mode === nextMode ? "bg-virtua-accent text-white" : "text-virtua-muted hover:bg-virtua-panelHover hover:text-virtua-text"
            }`}
          >
            {nextMode === "text" ? t("console.term_text") : t("console.term_graphical")}
          </button>
        );
      })}
    </>
  );
}

function ConsoleToolbar({
  resource,
  runResourceAction,
  onChanged,
  extras,
  t,
}: {
  resource: VirtuaResource;
  runResourceAction: (resourceId: string, action: PowerAction) => Promise<unknown>;
  onChanged?: () => void | Promise<void>;
  extras?: ReactNode;
  t: (k: string) => string;
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showStopChoice, setShowStopChoice] = useState(false);
  const state = resource.state.toLowerCase();
  const isRunning = isRunningState(state);
  const isStopped = isStoppedState(state);
  const canStart = resource.permissions.canPower && isStopped && pendingAction === null;
  const canStop = resource.permissions.canPower && isRunning && pendingAction === null;
  const canRestart = resource.permissions.canPower && isRunning && pendingAction === null;

  const runPowerAction = async (action: PowerAction) => {
    setPendingAction(action);
    setError(null);
    try {
      await runResourceAction(resource.id, action);
      await onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err || "Action impossible"));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-virtua-border bg-virtua-panel px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-lg font-semibold">{resource.name}</h1>
          <StatusBadge status={resource.state} />
        </div>
        <p className="mt-1 text-xs text-virtua-muted">
          {resource.kind.toUpperCase()} / {resource.node} / {resource.image ?? "console"}
          {error ? <span className="ml-2 text-virtua-red">{error}</span> : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          className="virtua-icon-button"
          title={t("console.start")}
          disabled={!canStart}
          onClick={() => void runPowerAction("start")}
        >
          <Play className="h-4 w-4" />
        </button>
        <button
          className="virtua-icon-button"
          title={t("console.stop")}
          disabled={!canStop}
          onClick={() => setShowStopChoice(true)}
        >
          <Square className="h-4 w-4" />
        </button>
        <button
          className="virtua-icon-button"
          title={t("console.restart")}
          disabled={!canRestart}
          onClick={() => void runPowerAction("restart")}
        >
          <RotateCcw className="h-4 w-4" />
        </button>
        {extras ? <div className="ml-2 border-l border-virtua-border pl-2">{extras}</div> : null}
      </div>
      {showStopChoice ? (
        <StopChoiceDialog
          resource={resource}
          onClose={() => setShowStopChoice(false)}
          onChoose={(action) => {
            setShowStopChoice(false);
            void runPowerAction(action);
          }}
          t={t}
        />
      ) : null}
    </div>
  );
}

export function ConsolePage({
  resources,
  user,
  runResourceAction = (resourceId, action) => virtuaClient.runAction(resourceId, action),
  onChanged,
}: {
  resources: VirtuaResource[];
  user: VirtuaUser | null;
  runResourceAction?: (resourceId: string, action: PowerAction) => Promise<unknown>;
  onChanged?: () => void | Promise<void>;
}) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { resourceId } = useParams();
  const prefs = useConsolePrefs();
  const showList = !prefs.focus && !prefs.listCollapsed;
  const showDetails = !prefs.focus && !prefs.detailsCollapsed;
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ResourceKind | "all">("all");
  const [mode, setMode] = useState<ConsoleMode>("text");
  const [contextMenu, setContextMenu] = useState<{ resource: VirtuaResource; x: number; y: number } | null>(null);
  const [stopChoiceResource, setStopChoiceResource] = useState<VirtuaResource | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);

  const kindLabels: Record<ResourceKind | "all", string> = useMemo(() => ({
    all: t("general.all"),
    vm: t("nav.vm"),
    lxc: t("nav.lxc"),
    docker: t("nav.docker"),
  }), [t]);

  const filteredResources = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return resources.filter((resource) => {
      const matchesKind = kind === "all" || resource.kind === kind;
      const matchesQuery =
        normalizedQuery.length === 0 ||
        resource.name.toLowerCase().includes(normalizedQuery) ||
        resource.displayName.toLowerCase().includes(normalizedQuery) ||
        resource.node.toLowerCase().includes(normalizedQuery) ||
        (resource.ip ?? "").toLowerCase().includes(normalizedQuery);
      return matchesKind && matchesQuery;
    });
  }, [kind, query, resources]);

  const selectedResource = resources.find((resource) => resource.id === resourceId) ?? filteredResources[0] ?? resources[0];

  useEffect(() => {
    if (!resourceId && selectedResource) {
      navigate(`/console/${selectedResource.id}`, { replace: true });
    }
  }, [navigate, resourceId, selectedResource]);

  useEffect(() => {
    if (selectedResource && !selectedResource.consoleModes.includes(mode)) {
      setMode(selectedResource.consoleModes[0]);
    }
  }, [mode, selectedResource]);

  useEffect(() => {
    if (!selectedResource) return;
    setMode(selectedResource.kind === "vm" && selectedResource.consoleModes.includes("graphical") ? "graphical" : selectedResource.consoleModes[0]);
  }, [selectedResource?.id]);

  const openContextMenu = (event: MouseEvent, resource: VirtuaResource) => {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 256;
    const menuHeight = 250;
    setContextMenu({
      resource,
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
    });
  };

  const runContextPowerAction = async (resource: VirtuaResource, action: PowerAction) => {
    setContextError(null);
    try {
      await runResourceAction(resource.id, action);
      await onChanged?.();
    } catch (error) {
      setContextError(error instanceof Error ? error.message : String(error || "Action impossible"));
    }
  };

  if (!selectedResource) {
    return (
      <div className="grid h-full place-items-center rounded border border-virtua-border bg-virtua-panel">
        <p className="text-sm text-virtua-muted">{t("console.no_machine")}</p>
      </div>
    );
  }

  // With the info bars folded, the console mode switch and the view controls
  // ride in the console's own action bar (or a corner of the text console).
  const foldedControls = (
    <div className="flex items-center gap-1">
      {selectedResource.consoleModes.length > 1 ? (
        <div className="mr-1 flex items-center gap-1 rounded bg-black/40 p-0.5">
          <ConsoleModeTabs resource={selectedResource} mode={mode} onMode={setMode} t={t} />
        </div>
      ) : null}
      <ConsoleViewControls t={t} />
    </div>
  );

  return (
    <div
      className={
        prefs.focus
          ? "relative flex h-full min-h-0 flex-col"
          : `grid h-full min-h-[42rem] gap-4 ${showList ? "lg:grid-cols-[18rem_1fr] xl:grid-cols-[20rem_1fr]" : "grid-cols-[3rem_1fr]"}`
      }
    >
      {contextError ? (
        <div className="fixed left-1/2 top-16 z-50 -translate-x-1/2 rounded border border-virtua-red/50 bg-virtua-panel px-3 py-2 text-sm text-virtua-red shadow-xl">
          {contextError}
        </div>
      ) : null}
      {showList ? (
      <aside className="flex min-h-0 flex-col rounded border border-virtua-border bg-virtua-panel">
        <div className="border-b border-virtua-border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h1 className="text-base font-semibold">{t("console.title")}</h1>
              <p className="text-[11px] text-virtua-muted">
                {user?.role === "ADMIN" ? t("console.admin_access") : t("console.user_access")}
              </p>
            </div>
            <button
              className="virtua-icon-button !h-8 !w-8"
              title={t("console.hide_list")}
              onClick={() => setConsolePrefs({ listCollapsed: true })}
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
          </div>

          <label className="flex h-9 items-center gap-2 rounded border border-virtua-border bg-black/20 px-2.5">
            <Search className="h-3.5 w-3.5 text-virtua-muted" />
            <input
              className="min-w-0 flex-1 bg-transparent text-xs text-virtua-text outline-none placeholder:text-virtua-muted"
              placeholder={t("general.search")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="mt-2 grid grid-cols-4 gap-1 rounded bg-black/20 p-1">
            {(["all", "vm", "lxc", "docker"] as const).map((nextKind) => (
              <button
                key={nextKind}
                onClick={() => setKind(nextKind)}
                className={`h-7 rounded text-[10px] uppercase font-medium transition-colors ${
                  kind === nextKind ? "bg-virtua-accent text-white" : "text-virtua-muted hover:bg-virtua-panelHover hover:text-virtua-text"
                }`}
              >
                {kindLabels[nextKind]}
              </button>
            ))}
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-1.5 overflow-auto p-2">
          {filteredResources.map((resource) => (
            <ResourceListItem key={resource.id} resource={resource} onContextMenu={openContextMenu} />
          ))}
        </div>
      </aside>
      ) : !prefs.focus ? (
        // Folded list: a narrow rail keeps one-click access to each machine
        // and the way back to the full list.
        <aside className="flex min-h-0 flex-col items-center gap-1.5 rounded border border-virtua-border bg-virtua-panel py-2">
          <button
            className="virtua-icon-button !h-8 !w-8"
            title={t("console.show_list")}
            onClick={() => setConsolePrefs({ listCollapsed: false })}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </button>
          <div className="my-1 h-px w-6 bg-virtua-border" />
          <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 overflow-auto">
            {resources.map((resource) => {
              const Icon = kindIcons[resource.kind];
              return (
                <NavLink
                  key={resource.id}
                  to={`/console/${resource.id}`}
                  title={`${resource.name} (${resource.state})`}
                  onContextMenu={(event) => openContextMenu(event, resource)}
                  className={({ isActive }) =>
                    `relative flex h-8 w-8 items-center justify-center rounded transition-colors ${
                      isActive ? "bg-virtua-accentSoft text-white" : "text-virtua-muted hover:bg-virtua-panelHover hover:text-virtua-text"
                    }`
                  }
                >
                  <Icon className="h-4 w-4" />
                  <span className={`absolute bottom-0.5 right-0.5 h-1.5 w-1.5 rounded-full ${isRunningState(resource.state) ? "bg-virtua-green" : "bg-virtua-muted"}`} />
                </NavLink>
              );
            })}
          </div>
        </aside>
      ) : null}

      <section
        className={
          prefs.focus
            ? "flex min-h-0 flex-1 flex-col overflow-hidden bg-[#05070a]"
            : "flex min-h-0 flex-col overflow-hidden rounded border border-virtua-border bg-[#05070a] shadow-panel"
        }
      >
        {showDetails ? (
        <>
        <ConsoleToolbar resource={selectedResource} runResourceAction={runResourceAction} onChanged={onChanged} extras={<ConsoleViewControls t={t} />} t={t} />

        <div className="grid gap-2 border-b border-virtua-border bg-[#0b0f14] p-2 lg:grid-cols-[1fr_14rem]">
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
            <div className="rounded bg-black/20 p-2">
              <p className="text-[10px] uppercase text-virtua-muted">{t("general.address")}</p>
              <p className="mt-0.5 font-mono text-xs">{selectedResource.ip ?? "n/a"}</p>
            </div>
            <div className="rounded bg-black/20 p-2">
              <p className="text-[10px] uppercase text-virtua-muted">{t("general.owner")}</p>
              <p className="mt-0.5 text-xs">{selectedResource.owner ?? (selectedResource.permissions.canView ? t("general.authorized") : t("general.denied"))}</p>
            </div>
            <div className="rounded bg-black/20 p-2">
              <p className="text-[10px] uppercase text-virtua-muted">{t("general.uptime")}</p>
              <p className="mt-0.5 text-xs">{selectedResource.uptime ?? selectedResource.state}</p>
            </div>
            <div className="rounded bg-black/20 p-2">
              <p className="text-[10px] uppercase text-virtua-muted">{t("console.guest_agent")}</p>
              <p className="mt-0.5 text-xs">{guestAgentLabel(selectedResource, t)}</p>
            </div>
          </div>
          <div className="space-y-1.5 py-1">
            <MetricBar label={t("general.cpu")} value={selectedResource.cpu ?? 0} />
            <MetricBar label={t("general.ram")} value={selectedResource.memory ?? 0} />
          </div>
        </div>

        <div className="flex items-center gap-1 border-b border-virtua-border bg-[#0b0f14] px-2 py-1.5">
          <ConsoleModeTabs resource={selectedResource} mode={mode} onMode={setMode} t={t} />
        </div>
        </>
        ) : null}

        <div className="min-h-0 flex-1 relative bg-[#05070a]">
          {!selectedResource.permissions.canConsole ? (
            <div className="absolute inset-0 grid place-items-center bg-[#05070a] text-sm text-virtua-muted">
              {t("console.no_perm")}
            </div>
          ) : mode === "graphical" ? (
            <GraphicalConsole
              resource={selectedResource}
              runResourceAction={runResourceAction}
              onChanged={onChanged}
              toolbarExtras={!showDetails ? foldedControls : undefined}
            />
          ) : <TextConsole resource={selectedResource} />}
          {!showDetails && (mode !== "graphical" || !selectedResource.permissions.canConsole) ? (
            // The text console has no action bar: a corner control, faint
            // until hovered, brings the bars back.
            <div className="absolute right-2 top-2 z-30 opacity-30 transition-opacity hover:opacity-100">
              {foldedControls}
            </div>
          ) : null}
        </div>
      </section>

      {contextMenu ? (
        <ResourceContextMenu
          resource={contextMenu.resource}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onConsole={() => {
            navigate(`/console/${contextMenu.resource.id}`);
            if (contextMenu.resource.kind === "vm" && contextMenu.resource.consoleModes.includes("graphical")) setMode("graphical");
            setContextMenu(null);
          }}
          onConfig={() => {
            navigate(`/resources/${contextMenu.resource.id}`);
            setContextMenu(null);
          }}
          onPower={(action) => {
            if (action === "stop") {
              setStopChoiceResource(contextMenu.resource);
              setContextMenu(null);
              return;
            }
            void runContextPowerAction(contextMenu.resource, action);
          }}
          t={t}
        />
      ) : null}
      {stopChoiceResource ? (
        <StopChoiceDialog
          resource={stopChoiceResource}
          onClose={() => setStopChoiceResource(null)}
          onChoose={(action) => {
            const resource = stopChoiceResource;
            setStopChoiceResource(null);
            void runContextPowerAction(resource, action);
          }}
          t={t}
        />
      ) : null}
    </div>
  );
}
