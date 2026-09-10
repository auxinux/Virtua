import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import RFB from "@novnc/novnc/lib/rfb";
import "@xterm/xterm/css/xterm.css";
import { api } from "@/api/client";
import { SpiceConsole } from "@/components/SpiceConsole";
import { RdpConsolePanel } from "@/components/RdpConsolePanel";

type ConsoleType = "vms" | "lxc" | "docker";
export type ConsoleMode = "term" | "vnc" | "spice" | "rdp";

function wsUrl(ticket: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/api/vdm/ws/console?ticket=${encodeURIComponent(ticket)}`;
}

export function ConsoleModal({ open, onClose, type, node, name, title, mode, standalone = false }: {
  open: boolean; onClose: () => void; type: ConsoleType; node: string; name: string; title: string; mode: ConsoleMode; standalone?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const termHostRef = useRef<HTMLDivElement>(null);
  const vncHostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);

  useEffect(() => {
    if (!open || mode === "spice" || mode === "rdp") return;
    setError(null);
    let disposed = false;
    let ws: WebSocket | null = null;
    let term: XTerm | null = null;
    let rfb: RFB | null = null;
    let ro: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const ticketPath = mode === "vnc"
      ? `/api/vdm/vms/${encodeURIComponent(node)}/${encodeURIComponent(name)}/vnc-ticket`
      : `/api/vdm/${type}/${encodeURIComponent(node)}/${encodeURIComponent(name)}/console-ticket`;
    void (async () => {
      try {
        const { ticket, password } = await api.post<{ ticket: string; password?: string }>(ticketPath);
        if (disposed) return;
        const url = wsUrl(ticket);
        if (mode === "vnc") {
          if (!vncHostRef.current) return;
          rfb = new RFB(vncHostRef.current, url, password ? { credentials: { password } } : {});
          rfb.scaleViewport = true; rfb.resizeSession = true; rfb.background = "#000";
          rfb.addEventListener("securityfailure", (event) => setError(`VNC security error: ${(event as CustomEvent<{ reason?: string }>).detail?.reason ?? "authentication failed"}`));
          rfb.addEventListener("disconnect", (event) => { if (!disposed && !(event as CustomEvent<{ clean?: boolean }>).detail?.clean) setError("The graphical console connection was interrupted"); });
          return;
        }
        if (!termHostRef.current) return;
        const termHost = termHostRef.current;
        // NOT convertEol: the far end is a real PTY that already emits CRLF, and
        // forcing a carriage return on every LF garbles anything that moves the
        // cursor down without resetting the column (prompts, progress bars).
        term = new XTerm({ theme: { background: "#0b0e14", foreground: "#c1c2c5", cursor: "#228be6" }, fontFamily: "JetBrains Mono, Fira Code, monospace", fontSize: 14, cursorBlink: true, scrollback: 5000, convertEol: false });
        const fit = new FitAddon(); term.loadAddon(fit); term.open(termHost);
        /** Fit only once the host has a box, else xterm computes 0 cols. */
        const safeFit = () => {
          if (disposed || termHost.clientWidth === 0 || termHost.clientHeight === 0) return;
          try { fit.fit(); } catch { /* detached mid-measure */ }
        };
        const sendResize = () => {
          if (ws?.readyState === WebSocket.OPEN && term && term.cols > 0 && term.rows > 0) {
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        };
        safeFit();
        ws = new WebSocket(url); ws.binaryType = "arraybuffer";
        ws.onopen = () => {
          // The node spawns the PTY at a fixed 80x24. Without this first resize
          // the shell wraps at the wrong column for the whole session, which is
          // what makes the output look interleaved and unreadable.
          safeFit();
          sendResize();
          term?.write("\x1b[32mConnected\x1b[0m\r\n");
        };
        ws.onmessage = (ev) => {
          const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
          try { const msg = JSON.parse(raw) as { type: string; data: string }; if (msg.type === "output") term?.write(msg.data); } catch { term?.write(raw); }
        };
        ws.onclose = (ev) => term?.write(`\r\n\x1b[31mDisconnected${ev.reason ? ": " + ev.reason : ""}\x1b[0m\r\n`);
        ws.onerror = () => term?.write("\r\n\x1b[31mConnection error\x1b[0m\r\n");
        term.onData((data) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data })); });
        term.onResize(() => sendResize());
        // Debounced: fullscreen toggles and window drags fire this in bursts and
        // every fit() reflows the whole buffer.
        ro = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(safeFit, 80);
        });
        ro.observe(termHost);
      } catch (e) { setError(e instanceof Error ? e.message : "Failed to open console"); }
    })();
    return () => { disposed = true; if (resizeTimer) clearTimeout(resizeTimer); ro?.disconnect(); try { ws?.close(); } catch { /* noop */ } try { rfb?.disconnect(); } catch { /* noop */ } try { term?.dispose(); } catch { /* noop */ } };
  }, [open, mode, type, node, name]);

  if (!open) return null;
  const label = mode === "vnc" ? "Graphical console" : mode === "spice" ? "SPICE console" : mode === "rdp" ? "RDP console" : "Terminal";
  const openWindow = () => {
    const query = new URLSearchParams({ type, node, name, title, mode });
    window.open(`/console?${query}`, `vdm-console-${node}-${name}-${mode}`, "popup,width=1440,height=900,resizable=yes");
    if (!standalone) onClose();
  };
  const toggleFullscreen = async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await panelRef.current?.requestFullscreen();
  };
  return (
    <div className={`${standalone ? "fixed inset-0" : "fixed inset-0 z-50 p-2 md:p-4"} flex items-center justify-center bg-black/80`} onClick={standalone ? undefined : onClose}>
      <div ref={panelRef} className="vdm-card flex h-full w-full max-w-none flex-col overflow-hidden p-2 md:p-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
          <h3 className="text-sm font-semibold text-vdm-text">{label} · {title} <span className="ml-2 font-mono text-xs text-vdm-textMuted">{node}</span></h3>
          <div className="flex items-center gap-2">
            {!standalone && <button className="vdm-btn-ghost text-xs" onClick={openWindow}>Open Window</button>}
            <button className="vdm-btn-ghost text-xs" onClick={() => void toggleFullscreen()}>{fullscreen ? "Exit Fullscreen" : "Fullscreen"}</button>
            <button className="vdm-btn-ghost text-xs" onClick={standalone ? () => window.close() : onClose}>Close</button>
          </div>
        </div>
        {error && <div className="mb-2 rounded-lg border border-vdm-danger/40 bg-vdm-danger/10 px-3 py-2 text-sm text-vdm-danger">{error}</div>}
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg bg-black">
          {mode === "vnc" ? <div ref={vncHostRef} className="h-full w-full bg-black" />
            : mode === "spice" ? <SpiceConsole ticketPath={`/api/vdm/vms/${encodeURIComponent(node)}/${encodeURIComponent(name)}/spice-ticket`} />
              : mode === "rdp" ? <RdpConsolePanel node={node} name={name} />
                : <div ref={termHostRef} className="h-full w-full bg-black p-2" />}
        </div>
      </div>
    </div>
  );
}
