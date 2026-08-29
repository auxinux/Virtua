import { useState } from "react";
import { ConfirmDialog, PromptDialog } from "@/components/ui/Dialogs";

// ── useConfirm — promise-based replacement for native confirm() ────────────
// Usage:  const { confirm, dialog } = useConfirm();
//         if (await confirm({ title, message, confirmLabel, tone })) { ... }
//         {dialog}
export function useConfirm() {
  const [state, setState] = useState<{
    title: string; message: React.ReactNode; confirmLabel?: string; tone?: "danger" | "primary" | "warning";
    resolve: (v: boolean) => void;
  } | null>(null);

  const confirm = (opts: { title: string; message: React.ReactNode; confirmLabel?: string; tone?: "danger" | "primary" | "warning" }) =>
    new Promise<boolean>((resolve) => setState({ ...opts, resolve }));

  const dialog = (
    <ConfirmDialog
      open={!!state}
      title={state?.title ?? ""}
      message={state?.message}
      confirmLabel={state?.confirmLabel}
      tone={state?.tone ?? "danger"}
      onConfirm={() => { state?.resolve(true); setState(null); }}
      onClose={() => { state?.resolve(false); setState(null); }}
    />
  );

  return { confirm, dialog };
}

// ── usePrompt — promise-based replacement for native prompt() ──────────────
// Usage:  const { prompt, dialog } = usePrompt();
//         const name = await prompt({ title, label, placeholder });
//         if (name) { ... }   // null if cancelled
//         {dialog}
export function usePrompt() {
  const [state, setState] = useState<{
    title: string; label?: string; placeholder?: string; confirmLabel?: string;
    resolve: (v: string | null) => void;
  } | null>(null);

  const prompt = (opts: { title: string; label?: string; placeholder?: string; confirmLabel?: string }) =>
    new Promise<string | null>((resolve) => setState({ ...opts, resolve }));

  const dialog = (
    <PromptDialog
      open={!!state}
      title={state?.title ?? ""}
      label={state?.label}
      placeholder={state?.placeholder}
      confirmLabel={state?.confirmLabel}
      onSubmit={(v) => { state?.resolve(v); setState(null); }}
      onClose={() => { state?.resolve(null); setState(null); }}
    />
  );

  return { prompt, dialog };
}
