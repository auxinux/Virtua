import React, { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc/lib/rfb";
import { useTranslation } from "react-i18next";
import { apiPost } from "../api/client";

interface NoVncConsoleProps {
  ticketPath: string;
  className?: string;
  bare?: boolean;
  resizeSession?: boolean;
}

type RfbInstance = RFB & {
  viewOnly: boolean;
  clipViewport: boolean;
  scaleViewport: boolean;
  resizeSession: boolean;
  focus: (options?: FocusOptions) => void;
  sendCredentials?: (credentials: { password?: string }) => void;
};

export function NoVncConsole({ ticketPath, className = "", bare = false, resizeSession = true }: NoVncConsoleProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbInstance | null>(null);
  const [status, setStatus] = useState(() => t("msg.connectionConnecting"));
  const [statusVisible, setStatusVisible] = useState(true);

  useEffect(() => {
    let disposed = false;
    let statusTimer: number | null = null;
    let cursorObserver: MutationObserver | null = null;

    const hideLocalCursor = () => {
      const container = containerRef.current;
      if (!container) return;
      container.style.setProperty("cursor", "none", "important");
      for (const element of Array.from(container.querySelectorAll<HTMLElement>("canvas, div"))) {
        element.style.setProperty("cursor", "none", "important");
      }
    };

    const disconnectCurrent = () => {
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
    };

    const connect = async () => {
      try {
        const { url, password } = await apiPost<{ url: string; password?: string }>(ticketPath);
        if (disposed || !containerRef.current) return;

        disconnectCurrent();
        setStatus(t("msg.connectionConnecting"));
        setStatusVisible(true);

        const rfb = new RFB(containerRef.current, url, {
          wsProtocols: ["binary"],
          credentials: password ? { password } : undefined,
        }) as RfbInstance;
        rfb.viewOnly = false;
        rfb.clipViewport = !resizeSession;
        rfb.scaleViewport = true;
        rfb.resizeSession = resizeSession;
        rfb.background = "#000";
        rfb.qualityLevel = 7;
        rfb.compressionLevel = 2;
        cursorObserver = new MutationObserver(hideLocalCursor);
        cursorObserver.observe(containerRef.current, { childList: true, subtree: true });
        hideLocalCursor();

        rfb.addEventListener("connect", () => {
          setStatus(t("msg.connectionConnected"));
          setStatusVisible(true);
          if (statusTimer) window.clearTimeout(statusTimer);
          statusTimer = window.setTimeout(() => setStatusVisible(false), 1200);
          rfb.focus();
        });
        rfb.addEventListener("disconnect", (event: Event) => {
          const detail = event as CustomEvent<{ clean: boolean }>;
          setStatus(detail.detail?.clean ? t("msg.connectionDisconnected") : t("msg.connectionLost"));
          setStatusVisible(true);
        });
        rfb.addEventListener("securityfailure", () => {
          setStatus(t("msg.connectionSecurityFailure"));
          setStatusVisible(true);
        });
        rfb.addEventListener("credentialsrequired", () => {
          if (password && rfb.sendCredentials) {
            rfb.sendCredentials({ password });
          } else {
            setStatus(t("msg.connectionSecurityFailure"));
            setStatusVisible(true);
          }
        });
        rfbRef.current = rfb;
      } catch (error) {
        setStatus(error instanceof Error ? error.message : t("msg.connectionFailed"));
        setStatusVisible(true);
      }
    };

    void connect();
    return () => {
      disposed = true;
      if (statusTimer) window.clearTimeout(statusTimer);
      cursorObserver?.disconnect();
      disconnectCurrent();
    };
  }, [resizeSession, t, ticketPath]);

  return (
    <div className={`relative h-full min-h-[320px] overflow-hidden bg-black ${bare ? "" : "rounded-lg"} ${className}`}>
      <div ref={containerRef} className="h-full w-full" />
      {statusVisible && (
        <div className="absolute left-3 top-3 rounded bg-black/65 px-2 py-1 text-xs text-white">
          {status}
        </div>
      )}
    </div>
  );
}
