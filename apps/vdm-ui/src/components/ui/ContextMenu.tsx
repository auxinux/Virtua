import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// ── Icon ────────────────────────────────────────────────────────────────────
function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

/**
 * Layering scale for floating VDM surfaces. Context menus sit above the page
 * but *below* dialogs, so a modal opened from a menu entry always paints on
 * top of whatever is left behind it.
 */
export const Z_CONTEXT_MENU = 1000;
export const Z_MODAL = 1100;

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
 * Right-click contextual menu, integrated in the UI (never the native browser
 * popup). Rendered through a portal on <body> so no ancestor `overflow`,
 * stacking context or transform can clip it, positioned from its measured size
 * so it always fits the viewport, and closed on outside click / Escape /
 * scroll. Each entry carries its own onClick; for destructive actions the
 * caller wraps the target in a ConfirmDialog.
 */
export function ContextMenu({ state, onClose }: { state: ContextMenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // Render off-screen for the first paint so the measuring pass never flashes
  // the menu at the wrong spot.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    if (!state) { setPos(null); return; }
    const el = ref.current;
    const menuW = el?.offsetWidth || 220;
    const menuH = el?.offsetHeight || Math.min(state.entries.length * 36 + 12, 480);
    // Flip above/left of the cursor when there is not enough room below/right.
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
    // Ignore events originating inside the menu itself: the menu lives in a
    // portal, so DOM containment — not event bubbling — is the reliable test.
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
      // Right-clicking the menu must not surface the native browser menu.
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
      className="fixed min-w-[210px] max-w-[280px] rounded-lg border border-vdm-border bg-vdm-surface shadow-xl py-1.5 text-sm"
      style={{
        left: pos?.x ?? state.x,
        top: pos?.y ?? state.y,
        zIndex: Z_CONTEXT_MENU,
        visibility: pos ? "visible" : "hidden",
      }}
    >
      {state.entries.map((entry, i) => (
        <div key={`${entry.label}-${i}`}>
          {entry.divider && <div className="my-1 h-px bg-vdm-border/60" />}
          <button
            type="button"
            role="menuitem"
            disabled={entry.disabled}
            onClick={() => { if (!entry.disabled) { entry.onClick(); close(); } }}
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
    </div>,
    document.body,
  );
}

/** Convenience helper: open the context menu at a mouse event position. */
export function contextMenuAt(e: React.MouseEvent, entries: ContextMenuEntry[]): ContextMenuState {
  e.preventDefault();
  e.stopPropagation();
  return { x: e.clientX, y: e.clientY, entries };
}
