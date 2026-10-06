import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuEntry {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  /** Render a divider ABOVE this entry. */
  divider?: boolean;
  onClick: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  /** Optional heading (e.g. "VM · web01"). */
  title?: string;
  entries: ContextMenuEntry[];
}

/**
 * Right-click menu rendered in a portal on <body> so no ancestor overflow or
 * transform clips it, positioned from its measured size so it always fits the
 * viewport, closed on outside click / Escape / scroll / resize. The menu
 * closes before running the entry, so a modal opened from it is never covered.
 */
export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Hidden for the measuring pass so the menu never flashes at the wrong spot.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!state) { setPos(null); return; }
    const el = ref.current;
    const menuW = el?.offsetWidth || 220;
    const menuH = el?.offsetHeight || Math.min(state.entries.length * 32 + 16, 480);
    const x = state.x + menuW + 8 > window.innerWidth ? state.x - menuW : state.x;
    const y = state.y + menuH + 8 > window.innerHeight ? state.y - menuH : state.y;
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - menuW - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuH - 8)),
    });
  }, [state]);

  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!state) return;
    // The menu lives in a portal: DOM containment, not bubbling, is the test.
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, close]);

  if (!state) return null;

  return createPortal(
    <div
      ref={ref}
      role="menu"
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      className="fixed z-[60] min-w-[210px] max-w-[300px] rounded-lg border border-surface-500 bg-surface-700 shadow-2xl py-1.5 text-sm animate-fade-in"
      style={{ left: pos?.x ?? state.x, top: pos?.y ?? state.y, visibility: pos ? "visible" : "hidden" }}
    >
      {state.title && (
        <div className="px-3 pb-1.5 mb-1 border-b border-surface-500 text-[11px] font-semibold uppercase tracking-wide text-text-500 truncate">
          {state.title}
        </div>
      )}
      {state.entries.map((entry, i) => (
        <div key={`${entry.label}-${i}`}>
          {entry.divider && <div className="my-1 h-px bg-surface-500/70" />}
          <button
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => { if (!entry.disabled) { close(); entry.onClick(); } }}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
              entry.disabled
                ? "text-text-500/50 cursor-not-allowed"
                : entry.danger
                  ? "text-red-400 hover:bg-red-900/20"
                  : "text-text-200 hover:bg-surface-600"
            }`}
          >
            <span className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center">{entry.icon}</span>
            <span className="flex-1 truncate">{entry.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
