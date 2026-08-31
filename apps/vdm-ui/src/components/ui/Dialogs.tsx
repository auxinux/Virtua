import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Z_MODAL } from "@/components/ui/ContextMenu";

// ── Icon ────────────────────────────────────────────────────────────────────
function Icon({ path, className = "w-4 h-4" }: { path: string; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

const ICONS = {
  warning: "M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z",
  info: "m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z",
};

// ── Modal (base) ────────────────────────────────────────────────────────────
export function Modal({ open, onClose, children, maxWidth = "max-w-md" }: {
  open: boolean; onClose: () => void; children: React.ReactNode; maxWidth?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  // Portalled on <body> with an explicit z-index above the context-menu layer:
  // a dialog opened from a context menu entry must always paint on top, no
  // matter which clipped/stacking ancestor the trigger lived in.
  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/60 p-4"
      style={{ zIndex: Z_MODAL }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div ref={ref} role="dialog" aria-modal="true" className={`vdm-card w-full ${maxWidth} p-5 space-y-4`}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

// ── ConfirmDialog (replaces native confirm()) ──────────────────────────────
export function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", tone = "danger", onConfirm, onClose }: {
  open: boolean; title: string; message: React.ReactNode;
  confirmLabel?: string; tone?: "danger" | "primary" | "warning";
  onConfirm: () => void; onClose: () => void;
}) {
  const btnCls = { danger: "vdm-btn-danger", primary: "vdm-btn-primary", warning: "vdm-btn-warning" }[tone];
  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-sm">
      <div className="flex items-start gap-3">
        <div className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${tone === "danger" ? "bg-vdm-danger/10 text-vdm-danger" : tone === "warning" ? "bg-vdm-warning/10 text-vdm-warning" : "bg-vdm-accent/10 text-vdm-accent"}`}>
          <Icon path={tone === "primary" ? ICONS.info : ICONS.warning} className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-vdm-text">{title}</h3>
          <div className="text-sm text-vdm-textMuted mt-1">{message}</div>
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className={btnCls} onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}

// ── PromptDialog (replaces native prompt()) ────────────────────────────────
export function PromptDialog({ open, title, label, placeholder, confirmLabel = "OK", onSubmit, onClose }: {
  open: boolean; title: string; label?: string; placeholder?: string;
  confirmLabel?: string; onSubmit: (value: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => { if (open) setValue(""); }, [open]);
  return (
    <Modal open={open} onClose={onClose} maxWidth="max-w-sm">
      <h3 className="text-base font-semibold text-vdm-text">{title}</h3>
      {label && <label className="vdm-label">{label}</label>}
      <input
        autoFocus
        className="vdm-input"
        value={value}
        placeholder={placeholder}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && value.trim()) onSubmit(value.trim()); }}
      />
      <div className="flex gap-2 justify-end">
        <button className="vdm-btn-ghost" onClick={onClose}>Cancel</button>
        <button className="vdm-btn-primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
