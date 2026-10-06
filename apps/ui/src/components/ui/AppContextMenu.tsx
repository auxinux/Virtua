import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft, ArrowRight, ClipboardPaste, Copy, ExternalLink, LayoutDashboard, Link2,
  MonitorPlay, Play, Plus, RotateCw, Scissors, Settings, Square, SquareDashedMousePointer, RefreshCw,
} from "lucide-react";
import { apiPost } from "../../api/client";
import { useAuth, type ResourceType } from "../../utils/useAuth";
import { ContextMenu, type ContextMenuEntry, type ContextMenuState } from "./ContextMenu";

/**
 * Surfaces that need the raw right-click: VNC/SPICE canvases forward it to the
 * guest, xterm uses it for its own selection. Anything can opt out with
 * data-native-contextmenu.
 */
const NATIVE_MENU_SELECTOR = "canvas, .xterm, [data-native-contextmenu]";

const NON_TEXT_INPUTS = new Set(["checkbox", "radio", "range", "color", "file", "submit", "button", "reset", "image"]);

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

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

interface ResourceRef { type: ResourceType; name: string }

const RESOURCE_ROUTE = /^\/(vms|lxc|docker)\/([^/]+)\/?$/;
const NOT_A_RESOURCE = new Set(["create", "compose", "volumes"]);
const ROUTE_TYPE: Record<string, ResourceType> = { vms: "vm", lxc: "lxc", docker: "docker" };
const TYPE_ROUTE: Record<ResourceType, string> = { vm: "vms", lxc: "lxc", docker: "docker" };

/** A VM/LXC/Docker addressed by a path such as /vms/web01. */
export function resourceFromPath(pathname: string): ResourceRef | null {
  const m = pathname.match(RESOURCE_ROUTE);
  if (!m || NOT_A_RESOURCE.has(m[2])) return null;
  return { type: ROUTE_TYPE[m[1]], name: decodeURIComponent(m[2]) };
}

/** Explicit tag first (data-resource-type/-name), then a resource link under the cursor. */
function resourceAt(target: EventTarget | null, link: HTMLAnchorElement | null): ResourceRef | null {
  const tagged = target instanceof Element ? target.closest<HTMLElement>("[data-resource-type][data-resource-name]") : null;
  if (tagged) {
    const type = tagged.dataset.resourceType as ResourceType;
    if (type === "vm" || type === "lxc" || type === "docker") return { type, name: tagged.dataset.resourceName! };
  }
  if (link && link.origin === window.location.origin) return resourceFromPath(link.pathname);
  return null;
}

/** Graceful power verbs per resource kind (the API allow-lists differ). */
const POWER_ACTIONS: Record<ResourceType, { start: string; stop: string; restart: string }> = {
  vm: { start: "start", stop: "shutdown", restart: "reboot" },
  lxc: { start: "start", stop: "stop", restart: "restart" },
  docker: { start: "start", stop: "stop", restart: "restart" },
};

function powerPath(ref: ResourceRef, action: string) {
  const name = encodeURIComponent(ref.name);
  if (ref.type === "vm") return `/api/vms/${name}/${action}`;
  if (ref.type === "lxc") return `/api/lxc/${name}/${action}`;
  return `/api/docker/containers/${name}/${action}`;
}

function setEditableValue(el: EditableElement, value: string, caret: number) {
  // Through the native setter + an input event, or React's controlled value
  // would overwrite the change on the next render.
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.focus();
  try { el.setSelectionRange(caret, caret); } catch { /* number/email inputs have no selection */ }
}

function selectedTextIn(el: EditableElement): string {
  try {
    return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  } catch {
    return "";
  }
}

/** navigator.clipboard only exists on HTTPS/localhost; fall back to execCommand. */
async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return true;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

/**
 * Application-wide right-click: Virtua shows its own menu everywhere.
 *
 * A component that wants a specific menu calls preventDefault() on the event;
 * this host then stays out of the way. Otherwise the menu is built from what
 * is under the cursor — a VM/LXC/Docker (link or tagged element, or the
 * detail page being viewed), editable text, a link — plus Virtua navigation.
 */
export function AppContextMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const { capabilities, getResourcePermissions } = useAuth();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const notify = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) window.clearTimeout(noticeTimer.current); }, []);

  const copy = useCallback(async (text: string) => {
    if (!(await writeClipboard(text))) notify(t("ctx.clipboardBlocked"));
  }, [notify, t]);

  /** Running state and display name from the sidebar's cached lists. */
  const describe = useCallback((ref: ResourceRef) => {
    const key = ref.type === "vm" ? "vms" : ref.type;
    const list = qc.getQueryData<Array<{ name: string; id?: string; state?: string; displayName?: string }>>(["sidebar", key]) ?? [];
    const entry = list.find((item) => item.name === ref.name || (item.id && (item.id === ref.name || item.id.startsWith(ref.name))));
    return {
      label: entry?.displayName || entry?.name || ref.name,
      running: entry?.state ? /running|paused|frozen|up/i.test(entry.state) : null,
    };
  }, [qc]);

  const resourceEntries = useCallback((ref: ResourceRef, openable: boolean): ContextMenuEntry[] => {
    const perms = getResourcePermissions(ref.type, ref.name);
    const { running } = describe(ref);
    const base = `/${TYPE_ROUTE[ref.type]}/${encodeURIComponent(ref.name)}`;
    const power = POWER_ACTIONS[ref.type];
    const act = (action: string) => {
      apiPost(powerPath(ref, action))
        .catch((error: unknown) => notify(t("ctx.actionFailed", { error: error instanceof Error ? error.message : String(error) })))
        .finally(() => void qc.invalidateQueries());
    };
    const entries: ContextMenuEntry[] = [];
    if (openable) entries.push({ label: t("ctx.open"), icon: <ExternalLink className="w-3.5 h-3.5" />, onClick: () => navigate(base) });
    if (perms.canConsole) {
      entries.push({ label: t("ctx.console"), icon: <MonitorPlay className="w-3.5 h-3.5" />, onClick: () => navigate(`${base}?tab=console`) });
    }
    if (perms.canPower) {
      // Unknown state (list not loaded yet): offer every verb, the API decides.
      entries.push({ label: t("ctx.start"), icon: <Play className="w-3.5 h-3.5" />, divider: entries.length > 0, disabled: running === true, onClick: () => act(power.start) });
      entries.push({ label: t("ctx.stop"), icon: <Square className="w-3.5 h-3.5" />, disabled: running === false, danger: true, onClick: () => act(power.stop) });
      entries.push({ label: t("ctx.restart"), icon: <RotateCw className="w-3.5 h-3.5" />, disabled: running === false, onClick: () => act(power.restart) });
    }
    entries.push({ label: t("ctx.copyName"), icon: <Copy className="w-3.5 h-3.5" />, divider: true, onClick: () => void copy(ref.name) });
    return entries;
  }, [copy, describe, getResourcePermissions, navigate, notify, qc, t]);

  const build = useCallback((e: MouseEvent): ContextMenuState | null => {
    const editable = editableAt(e.target);
    // Without HTTPS the page cannot read the clipboard: the native menu is the
    // only working "Paste", so leave text fields to the browser.
    if (editable && !window.isSecureContext) return null;

    const entries: ContextMenuEntry[] = [];
    let title: string | undefined;
    const link = linkAt(e.target);
    const selection = window.getSelection()?.toString() ?? "";
    const pointed = resourceAt(e.target, link);
    const current = resourceFromPath(location.pathname);
    const resource = pointed ?? (editable ? null : current);

    if (editable) {
      const readOnly = editable.readOnly || editable.disabled;
      const picked = selectedTextIn(editable);
      entries.push({
        label: t("ctx.cut"), icon: <Scissors className="w-3.5 h-3.5" />, disabled: !picked || readOnly,
        onClick: () => {
          const start = editable.selectionStart ?? 0;
          const end = editable.selectionEnd ?? 0;
          void copy(picked);
          setEditableValue(editable, editable.value.slice(0, start) + editable.value.slice(end), start);
        },
      });
      entries.push({ label: t("ctx.copy"), icon: <Copy className="w-3.5 h-3.5" />, disabled: !picked, onClick: () => void copy(picked) });
      entries.push({
        label: t("ctx.paste"), icon: <ClipboardPaste className="w-3.5 h-3.5" />, disabled: readOnly,
        onClick: async () => {
          try {
            const text = await navigator.clipboard.readText();
            const start = editable.selectionStart ?? 0;
            const end = editable.selectionEnd ?? 0;
            setEditableValue(editable, editable.value.slice(0, start) + text + editable.value.slice(end), start + text.length);
          } catch {
            notify(t("ctx.clipboardBlocked"));
          }
        },
      });
      entries.push({ label: t("ctx.selectAll"), icon: <SquareDashedMousePointer className="w-3.5 h-3.5" />, onClick: () => { editable.focus(); editable.select(); } });
    } else if (selection) {
      entries.push({ label: t("ctx.copy"), icon: <Copy className="w-3.5 h-3.5" />, onClick: () => void copy(selection) });
    }

    if (resource) {
      const kind = resource.type === "vm" ? "VM" : resource.type === "lxc" ? "LXC" : "Docker";
      title = `${kind} · ${describe(resource).label}`;
      const onItsPage = !!current && current.type === resource.type && current.name === resource.name;
      const items = resourceEntries(resource, !onItsPage);
      if (entries.length > 0 && items[0]) items[0] = { ...items[0], divider: true };
      entries.push(...items);
    }

    if (link && !resource) {
      const internal = link.origin === window.location.origin;
      entries.push({
        label: t("ctx.openLink"), icon: <Link2 className="w-3.5 h-3.5" />, divider: entries.length > 0,
        onClick: () => { if (internal) navigate(link.pathname + link.search + link.hash); else window.location.assign(link.href); },
      });
      entries.push({ label: t("ctx.copyLink"), icon: <Copy className="w-3.5 h-3.5" />, onClick: () => void copy(link.href) });
    }
    if (link) {
      entries.push({ label: t("ctx.openNewTab"), icon: <ExternalLink className="w-3.5 h-3.5" />, divider: !!resource, onClick: () => window.open(link.href, "_blank", "noopener,noreferrer") });
    }

    // Virtua navigation, only where the account may go.
    const sections = capabilities?.sections;
    const nav: ContextMenuEntry[] = [];
    if (sections?.dashboard && location.pathname !== "/dashboard") {
      nav.push({ label: t("ctx.dashboard"), icon: <LayoutDashboard className="w-3.5 h-3.5" />, onClick: () => navigate("/dashboard") });
    }
    if (sections?.createWizard) nav.push({ label: t("ctx.create"), icon: <Plus className="w-3.5 h-3.5" />, onClick: () => navigate("/create") });
    if (sections?.settings && location.pathname !== "/settings") {
      nav.push({ label: t("ctx.settings"), icon: <Settings className="w-3.5 h-3.5" />, onClick: () => navigate("/settings") });
    }
    if (nav.length > 0 && entries.length > 0) nav[0] = { ...nav[0], divider: true };
    entries.push(...nav);

    entries.push({ label: t("ctx.back"), icon: <ArrowLeft className="w-3.5 h-3.5" />, divider: entries.length > 0, onClick: () => navigate(-1) });
    entries.push({ label: t("ctx.forward"), icon: <ArrowRight className="w-3.5 h-3.5" />, onClick: () => navigate(1) });
    entries.push({ label: t("ctx.reload"), icon: <RefreshCw className="w-3.5 h-3.5" />, onClick: () => window.location.reload() });

    return { x: e.clientX, y: e.clientY, title, entries };
  }, [capabilities, copy, describe, location.pathname, navigate, notify, resourceEntries, t]);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest(NATIVE_MENU_SELECTOR)) return;
      const next = build(e);
      if (!next) return;
      e.preventDefault();
      setMenu(next);
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [build]);

  return (
    <>
      <ContextMenu state={menu} onClose={() => setMenu(null)} />
      {notice && (
        <div className="fixed bottom-4 right-4 z-[60] max-w-sm rounded border border-surface-500 bg-surface-700 px-3 py-2 text-sm text-text-200 shadow-xl">
          {notice}
        </div>
      )}
    </>
  );
}
