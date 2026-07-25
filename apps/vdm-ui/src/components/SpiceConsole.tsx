import { useId, useLayoutEffect, useRef, useState } from "react";
import { SpiceMainConn, sendCtrlAltDel } from "spice-client";
import { api } from "@/api/client";

function wsUrl(ticket: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/vdm/ws/console?ticket=${encodeURIComponent(ticket)}`;
}

export function SpiceConsole({ ticketPath }: { ticketPath: string }) {
  const screenId = `vdm-spice-${useId().replace(/:/g, "")}`;
  const containerRef = useRef<HTMLDivElement>(null);
  const connRef = useRef<SpiceMainConn | null>(null);
  const [status, setStatus] = useState("Connecting…");
  const [connected, setConnected] = useState(false);

  useLayoutEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | null = null;
    let mutations: MutationObserver | null = null;
    let timer: number | null = null;
    const normalizedCanvases = new Set<HTMLCanvasElement>();
    const normalizePointer = (event: Event) => {
      if (!(event instanceof MouseEvent) || !(event.currentTarget instanceof HTMLCanvasElement)) return;
      const canvas = event.currentTarget;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      Object.defineProperty(event, "offsetX", { configurable: true, value: (event.clientX - rect.left) * canvas.width / rect.width });
      Object.defineProperty(event, "offsetY", { configurable: true, value: (event.clientY - rect.top) * canvas.height / rect.height });
    };

    const fit = () => {
      const screen = document.getElementById(screenId);
      if (!screen) return;
      screen.style.cssText = "height:100%;width:100%;display:flex;align-items:center;justify-content:center;position:relative;cursor:none";
      for (const child of Array.from(screen.children)) {
        if (!(child instanceof HTMLElement)) continue;
        child.style.maxWidth = "100%";
        child.style.maxHeight = "100%";
        if (child instanceof HTMLCanvasElement) {
          child.style.width = "auto";
          child.style.height = "auto";
          child.style.objectFit = "contain";
          child.style.cursor = "none";
          if (!normalizedCanvases.has(child)) {
            for (const event of ["mousemove", "mousedown", "mouseup", "wheel"]) child.addEventListener(event, normalizePointer, { capture: true });
            normalizedCanvases.add(child);
          }
        }
      }
    };
    const resizeGuest = () => {
      const container = containerRef.current;
      const conn = connRef.current;
      if (!container || !conn) return;
      const width = Math.max(640, Math.floor(container.clientWidth / 8) * 8);
      const height = Math.max(480, Math.floor(container.clientHeight / 8) * 8);
      conn.resize_window(0, width, height, 32, 0, 0);
      fit();
    };
    const scheduleResize = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(resizeGuest, 200);
    };

    void (async () => {
      try {
        const { ticket, password } = await api.post<{ ticket: string; password?: string }>(ticketPath);
        if (disposed) return;
        connRef.current = new SpiceMainConn({
          uri: wsUrl(ticket), password: password ?? "", screen_id: screenId, scale_view: true,
          onsuccess: () => { if (!disposed) { setConnected(true); setStatus("Connected"); scheduleResize(); } },
          onerror: (error: Error) => { if (!disposed) { setConnected(false); setStatus(error?.message || "SPICE connection failed"); } },
        });
        observer = new ResizeObserver(scheduleResize);
        if (containerRef.current) observer.observe(containerRef.current);
        const screen = document.getElementById(screenId);
        if (screen) { mutations = new MutationObserver(fit); mutations.observe(screen, { childList: true }); }
      } catch (error) {
        if (!disposed) setStatus(error instanceof Error ? error.message : "SPICE connection failed");
      }
    })();

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      observer?.disconnect();
      mutations?.disconnect();
      for (const canvas of normalizedCanvases) for (const event of ["mousemove", "mousedown", "mouseup", "wheel"]) canvas.removeEventListener(event, normalizePointer, { capture: true });
      connRef.current?.stop();
      connRef.current = null;
    };
  }, [screenId, ticketPath]);

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-black">
      <div id={screenId} className="h-full w-full" />
      <div className="absolute left-3 top-3 rounded bg-black/65 px-2 py-1 text-xs text-white">{status}</div>
      {connected && <button type="button" className="absolute right-3 top-3 rounded bg-black/65 px-2 py-1 text-xs text-white hover:bg-black/80" onClick={() => connRef.current && sendCtrlAltDel(connRef.current)}>Ctrl+Alt+Del</button>}
    </div>
  );
}
