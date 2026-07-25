import React, { useEffect } from "react";
import ReactDOM from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  footer?: React.ReactNode;
}

const sizes = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

export function Modal({ open, onClose, title, children, size = "md", footer }: ModalProps) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    if (open) document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      {/* Dialog */}
      <div className={`relative z-10 w-full ${sizes[size]} bg-surface-700 border border-surface-500 rounded-lg shadow-2xl animate-fade-in`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-500">
          <h2 className="text-sm font-semibold text-text-100">{title}</h2>
          <button onClick={onClose} className="text-text-500 hover:text-text-200 transition-colors p-1 rounded hover:bg-surface-600">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Body */}
        <div className="px-4 py-4">{children}</div>
        {/* Footer */}
        {footer && <div className="px-4 py-3 border-t border-surface-500 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export interface ConfirmModalProps {
  open: boolean;
  onClose?: () => void;
  onCancel?: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  dangerous?: boolean;
  danger?: boolean;
  loading?: boolean;
  errorMessage?: string;
}

export function ConfirmModal({
  open,
  onClose,
  onCancel,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  dangerous = false,
  danger = false,
  loading = false,
  errorMessage,
}: ConfirmModalProps) {
  const handleClose = onCancel ?? onClose ?? (() => {});
  const isDangerous = dangerous || danger;
  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      size="sm"
      footer={
        <>
          <button onClick={handleClose} className="btn-secondary" disabled={loading}>Cancel</button>
          <button
            onClick={onConfirm}
            className={isDangerous ? "btn-danger" : "btn-primary"}
            disabled={loading}
          >
            {loading ? "..." : confirmLabel}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-text-300">{message}</p>
        {errorMessage && (
          <p className="text-sm text-red-300 border border-red-900/60 bg-red-950/30 rounded px-3 py-2">
            {errorMessage}
          </p>
        )}
      </div>
    </Modal>
  );
}
