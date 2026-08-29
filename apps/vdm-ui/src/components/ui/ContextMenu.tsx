import { useEffect, useLayoutEffect, useRef, useState } from "react";

// ── Icon ────────────────────────────────────────────────────────────────────
function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

export interface ContextMenuEntry {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean; // render a divider ABOVE this entry
  onClick: () => void;
}

export interface ContextMenuState {
  x: number;
  y: number;
  entries: ContextMenuEntry[];
}

/**
 * Right-click contextual menu, integrated in the UI (not a native popup).
 * Position is clamped to the viewport; closes on outside click / Escape /
 * scroll. Each entry carries its own onClick; for destructive actions the
 * caller wraps the target in a ConfirmDialog.
 */
export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!state) return;
    const menuW = 220;
    const menuH = Math.min(state.entries.length * 36 + 12, 480);
    const x = Math.min(state.x, window.innerWidth - menuW - 8);
    const y = Math.min(state.y, window.innerHeight - menuH - 8);
    setPos({ x: Math.max(8, x), y: Math.max(8, y) });
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const close = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [state, onClose]);

  if (!state) return null;

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.stopPropagation()}
      className="fixed z-50 min-w-[210px] max-w-[280px] rounded-lg border border-vdm-border bg-vdm-surface shadow-xl py-1.5 text-sm"
      style={{ left: pos.x, top: pos.y }}
    >
      {state.entries.map((entry, i) => (
        <div key={`${entry.label}-${i}`}>
          {entry.divider && <div className="my-1 h-px bg-vdm-border/60" />}
          <button
            disabled={entry.disabled}
            onClick={() => { if (!entry.disabled) { entry.onClick(); onClose(); } }}
            className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
              entry.disabled
                ? "text-vdm-textMuted/40 cursor-not-allowed"
                : entry.danger
                  ? "text-vdm-danger hover:bg-vdm-danger/10"
                  : "text-vdm-text hover:bg-vdm-surfaceHover"
            }`}
          >
            {entry.icon && <Icon path={entry.icon} className="w-3.5 h-3.5 flex-shrink-0" />}
            <span className="flex-1 truncate">{entry.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

/** Convenience helper: open the context menu at a mouse event position. */
export function contextMenuAt(e: React.MouseEvent, entries: ContextMenuEntry[]): ContextMenuState {
  e.preventDefault();
  e.stopPropagation();
  return { x: e.clientX, y: e.clientY, entries };
}
