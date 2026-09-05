import RFB from "@novnc/novnc";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, MousePointer2, RotateCcw, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { localVirtua } from "@/api/localVirtua";
import { virtuaClient } from "@/api/virtuaClient";
import type { PowerAction, VirtuaResource } from "@/types";

type RfbInstance = RFB & {
  viewOnly: boolean;
  clipViewport: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focus: (options?: FocusOptions) => void;
};

function ConsoleButton({
  label,
  icon: Icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: typeof MousePointer2;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 items-center gap-2 rounded border border-virtua-border px-3 text-xs text-virtua-muted transition-colors hover:bg-virtua-panelHover hover:text-virtua-text disabled:cursor-not-allowed disabled:opacity-35"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function CloudGraphicalConsole({
  resource,
  runResourceAction = (resourceId, action) => virtuaClient.runAction(resourceId, action),
  onChanged,
}: {
  resource: VirtuaResource;
  runResourceAction?: (resourceId: string, action: PowerAction) => Promise<unknown>;
  onChanged?: () => void | Promise<void>;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RfbInstance | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const toolbarTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState("Connexion graphique...");
  const [statusVisible, setStatusVisible] = useState(true);
  const [isConnected, setConnected] = useState(false);
  const [isRestarting, setRestarting] = useState(false);
  const [isAppFullscreen, setAppFullscreen] = useState(false);
  const [isWindowFullscreen, setWindowFullscreen] = useState(false);
  const [isToolbarVisible, setToolbarVisible] = useState(true);
  const [connectionNonce, setConnectionNonce] = useState(0);
  const isFullscreen = isAppFullscreen || isWindowFullscreen || Boolean(document.fullscreenElement);

  const showStatus = (message: string, durationMs?: number) => {
    setStatus(message);
    setStatusVisible(true);
    if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
    statusTimerRef.current = null;
    if (durationMs) {
      statusTimerRef.current = window.setTimeout(() => {
        setStatusVisible(false);
        statusTimerRef.current = null;
      }, durationMs);
    }
  };

  const disconnectConsole = () => {
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    setConnected(false);
  };

  useEffect(() => {
    let disposed = false;

    const ticketPromise = resource.source === "local"
      ? localVirtua.getConsoleTicket(resource.id)
      : virtuaClient.getConsoleTicket(resource.id, "graphical");

    void ticketPromise.then((ticket) => {
      if (disposed || !containerRef.current) return;
      disconnectConsole();
      const rfb = new RFB(containerRef.current, ticket.url, { wsProtocols: ["binary"] }) as RfbInstance;
      rfb.viewOnly = false;
      rfb.clipViewport = true;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = "#000";
      rfb.qualityLevel = 7;
      rfb.compressionLevel = 2;
      rfb.addEventListener("connect", () => {
        setConnected(true);
        showStatus("Console graphique connectee", 1200);
        rfb.focus();
      });
      rfb.addEventListener("disconnect", () => {
        setConnected(false);
        showStatus("Console graphique deconnectee");
      });
      rfb.addEventListener("securityfailure", () => {
        showStatus("Echec securite VNC");
      });
      rfbRef.current = rfb;
    }).catch((error) => {
      showStatus(error instanceof Error ? error.message : "Impossible d'ouvrir la console graphique");
    });

    return () => {
      disposed = true;
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
      disconnectConsole();
    };
  }, [resource.id, resource.state, connectionNonce]);

  useEffect(() => {
    const syncFullscreenState = () => {
      if (document.fullscreenElement) setAppFullscreen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void exitFullscreenMode();
      }
    };
    document.addEventListener("fullscreenchange", syncFullscreenState);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", syncFullscreenState);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreen) {
      setToolbarVisible(true);
      if (toolbarTimerRef.current) window.clearTimeout(toolbarTimerRef.current);
      toolbarTimerRef.current = null;
      return;
    }

    setToolbarVisible(true);
    if (toolbarTimerRef.current) window.clearTimeout(toolbarTimerRef.current);
    toolbarTimerRef.current = window.setTimeout(() => {
      setToolbarVisible(false);
      toolbarTimerRef.current = null;
    }, 1800);

    return () => {
      if (toolbarTimerRef.current) window.clearTimeout(toolbarTimerRef.current);
    };
  }, [isFullscreen]);

  const sendCtrlAltDel = () => {
    try {
      rfbRef.current?.sendCtrlAltDel();
      rfbRef.current?.focus();
    } catch {
      showStatus("Ctrl+Alt+Del impossible", 1800);
    }
  };

  const restartResource = async () => {
    setRestarting(true);
    disconnectConsole();
    showStatus("Redemarrage demande...");
    try {
      await runResourceAction(resource.id, "restart");
      await onChanged?.();
      showStatus("Reconnexion console...");
      setConnectionNonce((current) => current + 1);
    } catch (error) {
      showStatus(error instanceof Error ? error.message : "Redemarrage impossible");
    } finally {
      setRestarting(false);
    }
  };

  const showToolbarBriefly = () => {
    if (!isFullscreen) return;
    setToolbarVisible(true);
    if (toolbarTimerRef.current) window.clearTimeout(toolbarTimerRef.current);
    toolbarTimerRef.current = window.setTimeout(() => {
      setToolbarVisible(false);
      toolbarTimerRef.current = null;
    }, 1800);
  };

  async function exitFullscreenMode() {
    const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;

    if (isTauri) {
      try {
        const appWindow = getCurrentWindow();
        await appWindow.setFullscreen(false).catch(() => undefined);
        await appWindow.setSimpleFullscreen(false).catch(() => undefined);
      } catch (error) {
        showStatus(error instanceof Error ? error.message : "Sortie plein ecran impossible", 2200);
      }
    }

    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined);
    }

    setWindowFullscreen(false);
    setAppFullscreen(false);
    setToolbarVisible(true);
    window.setTimeout(() => rfbRef.current?.focus(), 150);
  }

  const enterFullscreenMode = async () => {
    const isTauri = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;

    if (isTauri) {
      try {
        const appWindow = getCurrentWindow();
        try {
          await appWindow.setFullscreen(true);
        } catch {
          await appWindow.setSimpleFullscreen(true);
        }
        setWindowFullscreen(true);
        setAppFullscreen(true);
        window.setTimeout(() => rfbRef.current?.focus(), 250);
        return;
      } catch (error) {
        showStatus(error instanceof Error ? error.message : "Plein ecran Tauri impossible", 2200);
      }
    }

    if (document.fullscreenElement) {
      try {
        await document.exitFullscreen();
      } finally {
        setAppFullscreen(false);
        setWindowFullscreen(false);
        rfbRef.current?.focus();
      }
      return;
    }

    try {
      await shellRef.current?.requestFullscreen();
    } catch {
      setAppFullscreen(true);
      showStatus("Plein ecran", 900);
    } finally {
      window.setTimeout(() => rfbRef.current?.focus(), 0);
    }
  };

  const toggleFullscreen = async () => {
    if (isFullscreen) {
      await exitFullscreenMode();
      return;
    }
    await enterFullscreenMode();
  };

  return (
    <div
      ref={shellRef}
      onMouseMove={showToolbarBriefly}
      className={`flex flex-col bg-[#05070a] ${
        isFullscreen
          ? "fixed inset-0 z-[100] h-screen w-screen rounded-none"
          : "h-full min-h-[24rem] rounded-b"
      }`}
    >
      <div
        className={`flex flex-wrap items-center justify-between gap-2 border-b border-virtua-border bg-black/75 px-3 py-2 transition-transform duration-150 ${
          isFullscreen ? "absolute left-0 right-0 top-0 z-20" : ""
        } ${isFullscreen && !isToolbarVisible ? "-translate-y-full" : "translate-y-0"}`}
      >
        <div className="flex items-center gap-2 text-xs text-virtua-muted">
          <span className="h-2 w-2 rounded-full bg-virtua-green" />
          <span>{resource.name} / ecran virtuel</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <ConsoleButton label="Ctrl+Alt+Del" icon={Send} disabled={!isConnected} onClick={sendCtrlAltDel} />
          <ConsoleButton label="Redemarrer" icon={RotateCcw} disabled={!resource.permissions.canPower || isRestarting} onClick={() => void restartResource()} />
          <ConsoleButton label={isFullscreen ? "Quitter plein ecran" : "Plein ecran"} icon={Maximize2} onClick={() => void toggleFullscreen()} />
        </div>
      </div>

      <div className={`relative min-h-0 flex-1 bg-black ${isFullscreen ? "h-screen" : ""}`}>
        <div ref={containerRef} className="h-full w-full" />
        {statusVisible && (
          <div className="absolute left-3 top-3 rounded bg-black/70 px-2 py-1 text-xs text-white">
            {status}
          </div>
        )}
      </div>
    </div>
  );
}

export function GraphicalConsole({
  resource,
  runResourceAction = (resourceId, action) => virtuaClient.runAction(resourceId, action),
  onChanged,
}: {
  resource: VirtuaResource;
  runResourceAction?: (resourceId: string, action: PowerAction) => Promise<unknown>;
  onChanged?: () => void | Promise<void>;
}) {
  return <CloudGraphicalConsole resource={resource} runResourceAction={runResourceAction} onChanged={onChanged} />;
}
