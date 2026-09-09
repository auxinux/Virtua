import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import { localVirtua } from "@/api/localVirtua";
import { virtuaClient } from "@/api/virtuaClient";
import type { VirtuaResource } from "@/types";
import "@xterm/xterm/css/xterm.css";

export function TextConsole({ resource }: { resource: VirtuaResource }) {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = terminalHostRef.current;
    if (!host) return;

    host.innerHTML = "";
    let disposed = false;
    let socket: WebSocket | null = null;

    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: "SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#05070a",
        foreground: "#dce7f3",
        cursor: "#2384e8",
        selectionBackground: "#1f6feb55",
        black: "#0b0f14",
        blue: "#2384e8",
        cyan: "#29b6c7",
        green: "#37b26c",
        red: "#ed5f5f",
        white: "#edf2f7",
        yellow: "#d49b24",
      },
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(host);
    // fit() throws when the host has not been laid out yet (hidden tab,
    // zero-height flex parent) and the exception used to take the page down.
    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // Nothing to fit to yet; the ResizeObserver will retry.
      }
    };
    fit();
    terminal.focus();

    const maskTicket = (url: string) => url.replace(/ticket=[^&]+/, "ticket=...");

    terminal.writeln(`Connexion a ${resource.kind.toUpperCase()} ${resource.displayName}...`);

    const ticketPromise = resource.source === "local"
      ? localVirtua.getConsoleTicket(resource.id, "text")
      : virtuaClient.getConsoleTicket(resource.id, "text");

    void ticketPromise.then((ticket) => {
      if (disposed) return;
      terminal.writeln(`Transport: ${maskTicket(ticket.url)}`);
      socket = new WebSocket(ticket.url);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => {
        terminal.write("\r\n\x1b[32mConnecte\x1b[0m\r\n\r\n");
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const message = JSON.parse(event.data) as { type?: string; data?: string };
          if (message.type === "output" && typeof message.data === "string") {
            terminal.write(message.data);
            return;
          }
        } catch {
          // Some console transports may send raw text.
        }
        terminal.write(event.data);
      };

      socket.onclose = (event) => {
        const reason = event.reason ? ` / ${event.reason}` : "";
        const code = event.code ? `code ${event.code}` : "code inconnu";
        terminal.write(`\r\n\x1b[31mDeconnecte (${code}${reason})\x1b[0m\r\n`);
      };

      socket.onerror = () => {
        terminal.write(`\r\n\x1b[31mErreur WebSocket console (${maskTicket(ticket.url)})\x1b[0m\r\n`);
      };
    }).catch((error) => {
      terminal.write(`\r\n\x1b[31m${error instanceof Error ? error.message : "Impossible d'ouvrir la console"}\x1b[0m\r\n`);
    });

    const dataDisposable = terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });

    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      socket?.close();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
    };
  }, [resource.id]);

  return <div ref={terminalHostRef} className="h-full min-h-[24rem] overflow-hidden rounded-b bg-[#05070a] p-2" />;
}
