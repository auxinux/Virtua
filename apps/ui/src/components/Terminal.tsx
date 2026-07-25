import React, { useEffect, useRef } from "react";
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

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

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
      convertEol: true,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitRef.current = fitAddon;
    term.loadAddon(fitAddon);

    term.open(containerRef.current);
    fitAddon.fit();

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
          term.write("\x1b[32mConnected\x1b[0m\r\n");
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data as string) as { type: string; data: string };
            if (msg.type === "output") term.write(msg.data);
          } catch {
            term.write(event.data as string);
          }
        };

        ws.onclose = (event) => {
          const reason = event.reason ? `: ${event.reason}` : "";
          term.write(`\r\n\x1b[31mDisconnected${reason}\x1b[0m\r\n`);
        };
        ws.onerror = () => term.write(`\r\n\x1b[31mConnection error (${resolvedUrl.replace(/\?.*$/, "?ticket=...")})\x1b[0m\r\n`);

        term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input", data }));
          }
        });

        term.onResize(({ cols, rows }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "resize", cols, rows }));
          }
        });

        resizeObserver = new ResizeObserver(() => fitAddon.fit());
        resizeObserver.observe(containerRef.current!);
      } catch (error) {
        term.write(`\r\n\x1b[31m${error instanceof Error ? error.message : "Connection failed"}\x1b[0m\r\n`);
      }
    };

    void connect();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      wsRef.current?.close();
      term.dispose();
    };
  }, [ticketBody, ticketPath, url]);

  return <div ref={containerRef} className={`xterm-container ${className}`} style={{ minHeight: "300px" }} />;
}
