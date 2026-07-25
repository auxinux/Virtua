import React, { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SpiceMainConn, sendCtrlAltDel } from "spice-client";
import { useTranslation } from "react-i18next";
import { apiPost } from "../api/client";
import { installSpiceAudioFallback, resumeSpiceAudio } from "./spiceAudioFallback";

installSpiceAudioFallback();

interface SpiceConsoleProps {
  ticketPath: string;
  className?: string;
  bare?: boolean;
  toolbarId?: string;
}

export function SpiceConsole({ ticketPath, className = "", bare = false, toolbarId }: SpiceConsoleProps) {
  const { t } = useTranslation();
  const rawId = useId().replace(/[:]/g, "");
  const screenId = `spice-screen-${rawId}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const connRef = useRef<SpiceMainConn | null>(null);
  const [status, setStatus] = useState(() => t("msg.connectionConnecting"));
  const [statusVisible, setStatusVisible] = useState(true);
  const [connected, setConnected] = useState(false);
  const [audioAvailable, setAudioAvailable] = useState(false);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const toolbar = toolbarId ? document.getElementById(toolbarId) : null;

  useLayoutEffect(() => {
    let disposed = false;
    let statusTimer: number | null = null;
    let fitObserver: MutationObserver | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: number | null = null;
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

    const resizeGuest = () => {
      const conn = connRef.current;
      const container = containerRef.current;
      if (!conn || !container) return;
      const width = Math.max(640, Math.floor(container.clientWidth / 8) * 8);
      const height = Math.max(480, Math.floor(container.clientHeight / 8) * 8);
      conn.resize_window(0, width, height, 32, 0, 0);
    };

    const scheduleGuestResize = () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(resizeGuest, 200);
    };

    const fitDisplay = () => {
      const screen = document.getElementById(screenId);
      if (!screen) return;
      screen.style.setProperty("height", "100%", "important");
      screen.style.setProperty("width", "100%", "important");
      screen.style.display = "flex";
      screen.style.alignItems = "center";
      screen.style.justifyContent = "center";
      screen.style.position = "relative";
      screen.style.setProperty("cursor", "none", "important");
      for (const child of Array.from(screen.children)) {
        if (!(child instanceof HTMLElement)) continue;
        child.style.maxWidth = "100%";
        child.style.maxHeight = "100%";
        if (child instanceof HTMLCanvasElement) {
          child.style.width = "auto";
          child.style.height = "auto";
          child.style.objectFit = "contain";
          child.style.setProperty("cursor", "none", "important");
          if (!normalizedCanvases.has(child)) {
            for (const type of ["mousemove", "mousedown", "mouseup", "wheel"]) {
              child.addEventListener(type, normalizePointer, { capture: true });
            }
            normalizedCanvases.add(child);
          }
        } else if (child instanceof HTMLImageElement && child.style.pointerEvents === "none") {
          child.style.setProperty("display", "none", "important");
        }
      }
      const audio = screen.querySelector("audio");
      setAudioAvailable(!!audio);
      setAudioPlaying(!!audio && !audio.paused);
    };

    const enableAudio = async () => {
      const audio = document.getElementById(screenId)?.querySelector("audio");
      if (!audio) return;
      audio.muted = false;
      audio.volume = 1;
      try {
        await audio.play();
        setAudioPlaying(true);
      } catch {
        setAudioPlaying(false);
      }
    };

    const disconnectCurrent = () => {
      if (connRef.current) {
        connRef.current.stop();
        connRef.current = null;
      }
    };

    const connect = async () => {
      try {
        const { url, password } = await apiPost<{ url: string; password?: string }>(ticketPath);
        if (disposed || !containerRef.current) return;

        disconnectCurrent();
        setStatus(t("msg.connectionConnecting"));
        setStatusVisible(true);
        setConnected(false);

        const conn = new SpiceMainConn({
          uri: url,
          password: password ?? "",
          screen_id: screenId,
          scale_view: true,
          onsuccess: () => {
            if (disposed) return;
            setStatus(t("msg.connectionConnected"));
            setStatusVisible(true);
            setConnected(true);
            scheduleGuestResize();
            if (statusTimer) window.clearTimeout(statusTimer);
            statusTimer = window.setTimeout(() => setStatusVisible(false), 1200);
          },
          onerror: (error: Error) => {
            if (disposed) return;
            setStatus(error?.message || t("msg.connectionFailed"));
            setStatusVisible(true);
            setConnected(false);
          },
        });
        connRef.current = conn;
        resizeObserver = new ResizeObserver(scheduleGuestResize);
        resizeObserver.observe(containerRef.current);
        const screen = document.getElementById(screenId);
        if (screen) {
          fitObserver = new MutationObserver(fitDisplay);
          fitObserver.observe(screen, { childList: true });
          fitDisplay();
        }
        void enableAudio();
      } catch (error) {
        if (disposed) return;
        setStatus(error instanceof Error ? error.message : t("msg.connectionFailed"));
        setStatusVisible(true);
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (statusTimer) window.clearTimeout(statusTimer);
      if (resizeTimer) window.clearTimeout(resizeTimer);
      fitObserver?.disconnect();
      resizeObserver?.disconnect();
      for (const canvas of normalizedCanvases) {
        for (const type of ["mousemove", "mousedown", "mouseup", "wheel"]) {
          canvas.removeEventListener(type, normalizePointer, { capture: true });
        }
      }
      normalizedCanvases.clear();
      setAudioAvailable(false);
      setAudioPlaying(false);
      disconnectCurrent();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenId, t, ticketPath]);

  return (
    <div className={`relative h-full min-h-[320px] overflow-hidden bg-black ${bare ? "" : "rounded-lg"} ${className}`}>
      <div ref={containerRef} className="h-full w-full">
        <div id={screenId} className="flex h-full w-full items-center justify-center" />
      </div>
      {statusVisible && (
        <div className="absolute left-3 top-3 rounded bg-black/65 px-2 py-1 text-xs text-white">
          {status}
        </div>
      )}
      {connected && toolbar && createPortal(
        <div className="flex items-center gap-2">
          {(audioAvailable || connected) && !audioPlaying && (
            <button
              type="button"
              onClick={() => {
                const audio = document.getElementById(screenId)?.querySelector("audio");
                if (audio) {
                  audio.muted = false;
                  audio.volume = 1;
                  void audio.play().then(() => setAudioPlaying(true)).catch(() => setAudioPlaying(false));
                  return;
                }
                void resumeSpiceAudio(screenId).then(setAudioPlaying).catch(() => setAudioPlaying(false));
              }}
              className="rounded bg-black/65 px-2 py-1 text-xs text-white hover:bg-black/80"
            >
              Activer le son
            </button>
          )}
          <button
            type="button"
            onClick={() => connRef.current && sendCtrlAltDel(connRef.current)}
            className="rounded bg-black/65 px-2 py-1 text-xs text-white hover:bg-black/80"
          >
            Ctrl+Alt+Suppr
          </button>
        </div>,
        toolbar,
      )}
    </div>
  );
}
