import RFB from "@novnc/novnc";
import { SpiceMainConn, sendCtrlAltDel as spiceSendCtrlAltDel } from "spice-client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Maximize2, MousePointer2, RotateCcw, Send, Volume2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { localVirtua } from "@/api/localVirtua";
import { virtuaClient } from "@/api/virtuaClient";
import { installSpiceAudioFallback, resumeSpiceAudio } from "./spiceAudioFallback";
import type { ConsoleMode, DesktopConsoleTicketResponse, PowerAction, VirtuaResource } from "@/types";

installSpiceAudioFallback();

type RfbInstance = RFB & {
  viewOnly: boolean;
  clipViewport: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focus: (options?: FocusOptions) => void;
};

function fetchConsoleTicket(resource: VirtuaResource, mode: ConsoleMode): Promise<DesktopConsoleTicketResponse> {
  return resource.source === "local"
    ? localVirtua.getConsoleTicket(resource.id, mode)
    : virtuaClient.getConsoleTicket(resource.id, mode);
}

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
  const rawId = useId().replace(/[:]/g, "");
  const screenId = `virtua-console-screen-${rawId}`;
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RfbInstance | null>(null);
  const spiceRef = useRef<SpiceMainConn | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const toolbarTimerRef = useRef<number | null>(null);
  const resizeTimerRef = useRef<number | null>(null);
  const [status, setStatus] = useState("Connexion graphique...");
  const [statusVisible, setStatusVisible] = useState(true);
  const [isConnected, setConnected] = useState(false);
  const [protocol, setProtocol] = useState<"spice" | "vnc" | null>(null);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
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
    spiceRef.current?.stop();
    spiceRef.current = null;
    setConnected(false);
    setProtocol(null);
    setAudioAvailable(false);
    setAudioPlaying(false);
  };

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let fitObserver: MutationObserver | null = null;
    const normalizedCanvases = new Set<HTMLCanvasElement>();

    const normalizePointer = (event: Event) => {
      if (!(event instanceof MouseEvent) || !(event.currentTarget instanceof HTMLCanvasElement)) return;
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = Math.max(0, Math.min(canvas.width - 1, (event.clientX - rect.left) * canvas.width / rect.width));
      const y = Math.max(0, Math.min(canvas.height - 1, (event.clientY - rect.top) * canvas.height / rect.height));
      Object.defineProperty(event, "offsetX", { configurable: true, value: x });
      Object.defineProperty(event, "offsetY", { configurable: true, value: y });
    };

    // SPICE's canvas doesn't auto-fit its container like noVNC's RFB does
    // (rfb.scaleViewport handles that natively) — scale it manually and keep
    // pointer coordinates mapped onto the true canvas resolution.
    const fitSpiceDisplay = () => {
      const screen = document.getElementById(screenId);
      if (!screen) return;
      for (const child of Array.from(screen.children)) {
        if (!(child instanceof HTMLElement)) continue;
        child.style.maxWidth = "100%";
        child.style.maxHeight = "100%";
        if (child instanceof HTMLCanvasElement) {
          child.style.width = "auto";
          child.style.height = "auto";
          child.style.objectFit = "contain";
          if (!normalizedCanvases.has(child)) {
            for (const type of ["mousemove", "mousedown", "mouseup", "wheel"]) {
              child.addEventListener(type, normalizePointer, { capture: true });
            }
            normalizedCanvases.add(child);
          }
        }
      }
      const audio = screen.querySelector("audio");
      setAudioAvailable(!!audio);
      setAudioPlaying(!!audio && !audio.paused);
    };

    const resizeSpiceGuest = () => {
      const conn = spiceRef.current;
      const container = containerRef.current;
      if (!conn || !container) return;
      const width = Math.max(640, Math.floor(container.clientWidth / 8) * 8);
      const height = Math.max(480, Math.floor(container.clientHeight / 8) * 8);
      conn.resize_window(0, width, height, 32, 0, 0);
    };

    const scheduleSpiceResize = () => {
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = window.setTimeout(resizeSpiceGuest, 200);
    };

    const mountVnc = (ticket: DesktopConsoleTicketResponse) => {
      if (!containerRef.current) return;
      const rfb = new RFB(containerRef.current, ticket.url, { wsProtocols: ["binary"] }) as RfbInstance;
      rfb.viewOnly = false;
      rfb.clipViewport = true;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = "#000";
      rfb.qualityLevel = 7;
      rfb.compressionLevel = 2;
      rfb.addEventListener("connect", () => {
        setProtocol("vnc");
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
    };

    const mountSpice = (ticket: DesktopConsoleTicketResponse) => {
      // A SPICE ticket only proves the server issued one. If the session itself
      // never comes up (SPICE disabled on the VM, proxy refusing the protocol),
      // fall back to VNC instead of leaving a dead screen.
      let spiceEverConnected = false;
      const conn = new SpiceMainConn({
        uri: ticket.url,
        password: ticket.password ?? "",
        screen_id: screenId,
        scale_view: true,
        onsuccess: () => {
          if (disposed) return;
          spiceEverConnected = true;
          setProtocol("spice");
          setConnected(true);
          showStatus("Console graphique connectee", 1200);
          scheduleSpiceResize();
        },
        onerror: (error: Error) => {
          if (disposed) return;
          setConnected(false);
          if (!spiceEverConnected) {
            showStatus("SPICE indisponible, bascule sur VNC...");
            void fallbackToVnc();
            return;
          }
          showStatus(error?.message || "Console graphique deconnectee");
        },
      });
      spiceRef.current = conn;
      resizeObserver = new ResizeObserver(scheduleSpiceResize);
      if (containerRef.current) resizeObserver.observe(containerRef.current);
      const screen = document.getElementById(screenId);
      if (screen) {
        fitObserver = new MutationObserver(fitSpiceDisplay);
        fitObserver.observe(screen, { childList: true });
        fitSpiceDisplay();
      }
    };

    const fallbackToVnc = async () => {
      spiceRef.current?.stop();
      spiceRef.current = null;
      resizeObserver?.disconnect();
      resizeObserver = null;
      fitObserver?.disconnect();
      fitObserver = null;
      if (disposed || !containerRef.current) return;
      containerRef.current.innerHTML = "";
      try {
        const ticket = await fetchConsoleTicket(resource, "graphical");
        if (disposed || !containerRef.current) return;
        mountVnc(ticket);
      } catch (error) {
        if (disposed) return;
        showStatus(error instanceof Error ? error.message : "Impossible d'ouvrir la console graphique");
      }
    };

    const connect = async () => {
      if (disposed || !containerRef.current) return;
      disconnectConsole();
      // Neither library guarantees it tears down its own DOM nodes on
      // disconnect — clear the container so a protocol switch (e.g. SPICE
      // becoming available after a VM restart) never leaves stale canvases.
      containerRef.current.innerHTML = "";
      showStatus("Connexion graphique...");
      setStatusVisible(true);

      // SPICE first (needed for qxl / audio); silent fallback to VNC if the
      // server hasn't enabled SPICE for this VM yet.
      try {
        const ticket = await fetchConsoleTicket(resource, "spice");
        if (disposed || !containerRef.current) return;
        mountSpice(ticket);
        return;
      } catch {
        // fall through to VNC
      }

      try {
        const ticket = await fetchConsoleTicket(resource, "graphical");
        if (disposed || !containerRef.current) return;
        mountVnc(ticket);
      } catch (error) {
        if (disposed) return;
        showStatus(error instanceof Error ? error.message : "Impossible d'ouvrir la console graphique");
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (statusTimerRef.current) window.clearTimeout(statusTimerRef.current);
      if (resizeTimerRef.current) window.clearTimeout(resizeTimerRef.current);
      fitObserver?.disconnect();
      resizeObserver?.disconnect();
      for (const canvas of normalizedCanvases) {
        for (const type of ["mousemove", "mousedown", "mouseup", "wheel"]) {
          canvas.removeEventListener(type, normalizePointer, { capture: true });
        }
      }
      normalizedCanvases.clear();
      disconnectConsole();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      if (protocol === "spice" && spiceRef.current) {
        spiceSendCtrlAltDel(spiceRef.current);
      } else {
        rfbRef.current?.sendCtrlAltDel();
        rfbRef.current?.focus();
      }
    } catch {
      showStatus("Ctrl+Alt+Del impossible", 1800);
    }
  };

  const enableAudio = async () => {
    const audio = document.getElementById(screenId)?.querySelector("audio");
    if (audio) {
      audio.muted = false;
      audio.volume = 1;
      try {
        await audio.play();
        setAudioPlaying(true);
      } catch {
        setAudioPlaying(false);
      }
      return;
    }
    setAudioPlaying(await resumeSpiceAudio(screenId).catch(() => false));
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
          <span>{resource.name} / ecran virtuel{protocol ? ` (${protocol === "spice" ? "SPICE" : "VNC"})` : ""}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {protocol === "spice" && audioAvailable && !audioPlaying && (
            <ConsoleButton label="Activer le son" icon={Volume2} onClick={() => void enableAudio()} />
          )}
          <ConsoleButton label="Ctrl+Alt+Del" icon={Send} disabled={!isConnected} onClick={sendCtrlAltDel} />
          <ConsoleButton label="Redemarrer" icon={RotateCcw} disabled={!resource.permissions.canPower || isRestarting} onClick={() => void restartResource()} />
          <ConsoleButton label={isFullscreen ? "Quitter plein ecran" : "Plein ecran"} icon={Maximize2} onClick={() => void toggleFullscreen()} />
        </div>
      </div>

      <div className={`relative min-h-0 flex-1 bg-black ${isFullscreen ? "h-screen" : ""}`}>
        <div ref={containerRef} id={screenId} className="h-full w-full" />
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
