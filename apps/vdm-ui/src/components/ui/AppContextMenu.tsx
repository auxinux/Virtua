import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "@/components/ui/ContextMenu";

const ICONS = {
  copy: "M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75",
  cut: "M7.848 8.25l1.536.887M7.848 8.25a3 3 0 1 1-5.196-3 3 3 0 0 1 5.196 3Zm1.536.887a2.165 2.165 0 0 1 1.083 1.839c.005.351.054.695.14 1.024M9.384 9.137l2.077 1.199M7.848 15.75l1.536-.887m-1.536.887a3 3 0 1 1-5.196 3 3 3 0 0 1 5.196-3Zm1.536-.887a2.165 2.165 0 0 0 1.083-1.838c.005-.352.054-.695.14-1.025m-1.223 2.863 2.077-1.199m0-3.328a4.323 4.323 0 0 1 2.068-1.379l5.325-1.628a4.5 4.5 0 0 1 2.48-.044l.803.215-7.794 4.5m-2.882-1.664A4.33 4.33 0 0 0 10.607 12m3.736 0 7.794 4.5-.802.215a4.5 4.5 0 0 1-2.48-.043l-5.326-1.629a4.324 4.324 0 0 1-2.068-1.379M14.343 12l-2.882 1.664",
  paste: "M15.666 3.888A2.25 2.25 0 0 0 13.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 0 1-.75.75H9a.75.75 0 0 1-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 0 1-2.25 2.25H6.75A2.25 2.25 0 0 1 4.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 0 1 1.927-.184",
  selectAll: "M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15",
  open: "M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25",
  back: "M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18",
  forward: "M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3",
  reload: "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99",
};

/** Elements that need the raw browser/guest event (VNC, SPICE, xterm surfaces). */
const NATIVE_MENU_SELECTOR = "canvas, .xterm, .xterm-screen, [data-native-contextmenu]";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

/** Input types that carry no editable text selection. */
const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "color", "file", "submit", "button", "reset", "image"]);

function editableAt(target: EventTarget | null): EditableElement | null {
  const el = target instanceof Element ? target.closest("input, textarea") : null;
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement) return NON_TEXT_INPUTS.has(el.type) ? null : el;
  return null;
}

function linkAt(target: EventTarget | null): HTMLAnchorElement | null {
  const el = target instanceof Element ? target.closest("a[href]") : null;
  return el instanceof HTMLAnchorElement ? el : null;
}

function notify(message: string) {
  window.dispatchEvent(new CustomEvent("vdm-api-error", { detail: message }));
}

async function writeClipboard(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    notify("Clipboard write was blocked by the browser");
  }
}

/**
 * Replace the input's value the way React expects: go through the native value
 * setter, then fire an `input` event so the controlled component updates.
 */
function setEditableValue(el: EditableElement, value: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  // setSelectionRange throws on input types that do not support selection
  // (number, email, …) — the value change is what matters there.
  try { el.setSelectionRange(caret, caret); } catch { /* unsupported input type */ }
}

function selectedTextIn(el: EditableElement): string {
  try {
    return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  } catch {
    return "";
  }
}

/**
 * Application-wide right-click handler: VDM never shows the browser's native
 * context menu, it always shows its own.
 *
 * Component-level menus (resource rows, sidebar tree, …) call
 * `preventDefault()` on the event and open their specific menu; this host sees
 * `defaultPrevented` and stays out of the way. Everywhere else it opens a
 * generic VDM menu with the clipboard / link / navigation actions the native
 * menu used to provide.
 */
export function AppContextMenu() {
  const navigate = useNavigate();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const buildEntries = useCallback((e: MouseEvent): ContextMenuEntry[] => {
    const entries: ContextMenuEntry[] = [];
    const editable = editableAt(e.target);
    const link = linkAt(e.target);
    const selection = window.getSelection()?.toString() ?? "";

    if (editable) {
      const readOnly = editable.readOnly || editable.disabled;
      const picked = selectedTextIn(editable);
      entries.push({
        label: "Cut", icon: ICONS.cut, disabled: !picked || readOnly,
        onClick: () => {
          const start = editable.selectionStart ?? 0;
          const end = editable.selectionEnd ?? 0;
          void writeClipboard(picked);
          setEditableValue(editable, editable.value.slice(0, start) + editable.value.slice(end), start);
        },
      });
      entries.push({ label: "Copy", icon: ICONS.copy, disabled: !picked, onClick: () => void writeClipboard(picked) });
      entries.push({
        label: "Paste", icon: ICONS.paste, disabled: readOnly,
        onClick: async () => {
          try {
            const text = await navigator.clipboard.readText();
            const start = editable.selectionStart ?? 0;
            const end = editable.selectionEnd ?? 0;
            setEditableValue(editable, editable.value.slice(0, start) + text + editable.value.slice(end), start + text.length);
          } catch {
            notify("Clipboard read was blocked by the browser — use Ctrl+V");
          }
        },
      });
      entries.push({ label: "Select all", icon: ICONS.selectAll, onClick: () => { editable.focus(); editable.select(); } });
    } else if (selection) {
      entries.push({ label: "Copy", icon: ICONS.copy, onClick: () => void writeClipboard(selection) });
    }

    if (link) {
      const href = link.href;
      const internal = link.origin === window.location.origin;
      entries.push({
        label: "Open link", icon: ICONS.open, divider: entries.length > 0,
        onClick: () => { if (internal) navigate(link.pathname + link.search + link.hash); else window.location.assign(href); },
      });
      entries.push({ label: "Open in new tab", icon: ICONS.open, onClick: () => window.open(href, "_blank", "noopener,noreferrer") });
      entries.push({ label: "Copy link address", icon: ICONS.copy, onClick: () => void writeClipboard(href) });
    }

    entries.push({ label: "Back", icon: ICONS.back, divider: entries.length > 0, onClick: () => navigate(-1) });
    entries.push({ label: "Forward", icon: ICONS.forward, onClick: () => navigate(1) });
    entries.push({ label: "Reload", icon: ICONS.reload, onClick: () => window.location.reload() });
    return entries;
  }, [navigate]);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // A component already claimed this right-click and is opening its own
      // VDM menu.
      if (e.defaultPrevented) return;
      // Console surfaces forward the event to the guest / terminal.
      if (e.target instanceof Element && e.target.closest(NATIVE_MENU_SELECTOR)) return;
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, entries: buildEntries(e) });
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [buildEntries]);

  return <ContextMenu state={menu} onClose={() => setMenu(null)} />;
}
