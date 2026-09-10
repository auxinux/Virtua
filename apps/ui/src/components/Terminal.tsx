import React, { useEffect, useMemo, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { apiPost, wsUrl } from "../api/client";
import "@xterm/xterm/css/xterm.css";

interface TerminalProps {
  /** Full ws:// or wss:// URL, or HTTP path (will be converted). */
  url?: string;
  ticketPath?: string;
  ticketBody?: unknown;
  className?: string;
}

export function Terminal({ url, ticketPath, ticketBody, className = "" }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  // ticketBody is nearly always an inline object literal at the call site, so a
  // raw reference in the dep array would tear down and respawn the PTY on every
  // parent render. Compare by value instead.
  const ticketBodyKey = useMemo(() => (ticketBody === undefined ? "" : JSON.stringify(ticketBody)), [ticketBody]);

  useEffect(() => {
    if (!containerRef.current) return;
    const host = containerRef.current;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let openFrame: number | null = null;

    const term = new XTerm({
      theme: {
        background: "#000000",
        foreground: "#c1c2c5",
        cursor: "#228be6",
        selectionBackground: "#228be640",
      },
      fontFamily: "JetBrains Mono, Fira Code, monospace",
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      scrollback: 5000,
      // NOT convertEol: the far end is a real PTY that already emits CRLF.
      // Forcing a carriage return on every LF corrupts any program that moves
      // the cursor down without resetting the column (prompts, progress bars,
      // curses-style output) and is what makes the display look interleaved.
      convertEol: false,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    term.loadAddon(fitAddon);

    term.open(host);

    /** Fit only once the host actually has a box, else xterm computes 0 cols. */
    const safeFit = () => {
      if (disposed || host.clientWidth === 0 || host.clientHeight === 0) return;
      try { fitAddon.fit(); } catch { /* detached mid-measure */ }
    };

    const sendResize = () => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN && term.cols > 0 && term.rows > 0) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    // Layout is not settled on the first paint; measure on the next frame.
    openFrame = requestAnimationFrame(safeFit);

    const connect = async () => {
      try {
        const resolvedUrl = ticketPath
          ? (await apiPost<{ url: string }>(ticketPath, ticketBody)).url
          : (url!.startsWith("ws") ? url! : wsUrl(url!));
        if (disposed) return;

        const ws = new WebSocket(resolvedUrl);
        wsRef.current = ws;
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          // The PTY is spawned server-side at a fixed 80x24 (120x32 for the host
          // shell). Without this first resize the shell keeps wrapping at the
          // wrong column for the whole session — the real cause of the garbled,
          // overlapping output. Fit first so we advertise the true geometry.
          safeFit();
          sendResize();
          term.write("\x1b[32mConnected\x1b[0m\r\n");
        };

        ws.onmessage = (event) => {
          const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
          try {
            const msg = JSON.parse(raw) as { type: string; data: string };
            if (msg.type === "output") term.write(msg.data);
          } catch {
            term.write(raw);
          }
        };

        ws.onclose = (event) => {
          const reason = event.reason ? `: ${event.reason}` : "";
          term.write(`\r\n\x1b[31mDisconnected${reason}\x1b[0m\r\n`);
        };
        ws.onerror = () => term.write(`\r\n\x1b[31mConnection error (${resolvedUrl.replace(/\?.*$/, "?ticket=...")})\x1b[0m\r\n`);
      } catch (error) {
        term.write(`\r\n\x1b[31m${error instanceof Error ? error.message : "Connection failed"}\x1b[0m\r\n`);
      }
    };

    // Wired once, outside connect(), so no listener is ever registered twice.
    const dataSub = term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    });
    const resizeSub = term.onResize(() => sendResize());

    resizeObserver = new ResizeObserver(() => {
      // Debounced: a drag-resize or a sidebar transition fires this dozens of
      // times, and each fit() reflows the whole buffer.
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(safeFit, 80);
    });
    resizeObserver.observe(host);

    void connect();

    return () => {
      disposed = true;
      if (openFrame !== null) cancelAnimationFrame(openFrame);
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
    };
    // ticketBody is intentionally tracked through ticketBodyKey (value equality).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketBodyKey, ticketPath, url]);

  return <div ref={containerRef} className={`xterm-container ${className}`} style={{ minHeight: "300px" }} />;
}
