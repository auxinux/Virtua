import { invoke } from "@tauri-apps/api/core";

/**
 * Appearance of Virtua Desktop.
 *
 * - `auto` (default): AuxiNux palette, light or dark like the session. In
 *   AuxiNux Shell that is the Shell's own setting (sunrise/sunset included),
 *   its accent color, font, text size, contrast and animations; elsewhere the
 *   system light/dark preference.
 * - `light` / `dark`: AuxiNux palette, forced.
 * - `virtua`: the original dark Virtua look.
 */
export type ThemeChoice = "auto" | "light" | "dark" | "virtua";

export interface SessionAppearance {
  auxinuxShell: boolean;
  dark?: boolean | null;
  accent?: string | null;
  highContrast: boolean;
  fontFamily?: string | null;
  textScale: number;
  animations: boolean;
}

/** AuxiNux Shell's default accent ("AuxiNux" orange). */
export const AUXINUX_ACCENT = "#ef8a12";

const choiceKey = "auxinux-virtua-desktop-theme";
const appearanceKey = "auxinux-virtua-desktop-session-appearance";
const neutral: SessionAppearance = { auxinuxShell: false, highContrast: false, textScale: 1, animations: true };

/** Card color of each AuxiNux palette (index.css), to blend the soft accent. */
const panels = { "auxinux-dark": [50, 50, 52], "auxinux-light": [251, 251, 252] } as const;

function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private window or storage disabled: the theme still applies. */
  }
}

export function getThemeChoice(): ThemeChoice {
  const value = readStorage<string>(choiceKey, "auto");
  return value === "light" || value === "dark" || value === "virtua" ? value : "auto";
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: readonly number[], b: readonly number[], weightOfA: number) {
  return a.map((v, i) => Math.round(v * weightOfA + b[i] * (1 - weightOfA))) as [number, number, number];
}

function luminance([r, g, b]: readonly number[]) {
  const channel = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** White text when it reaches 3:1 on the accent, else near-black — AuxiNux Shell's rule. */
export function onAccent(rgb: readonly number[]): [number, number, number] {
  return 1.05 / (luminance(rgb) + 0.05) >= 3 ? [255, 255, 255] : [27, 27, 27];
}

/** Theme for a choice and what the session says. */
export function resolveTheme(choice: ThemeChoice, session: SessionAppearance, systemDark: boolean) {
  if (choice === "virtua") return "virtua" as const;
  const dark = choice === "dark" || (choice === "auto" && (session.dark ?? systemDark));
  return dark ? ("auxinux-dark" as const) : ("auxinux-light" as const);
}

/**
 * Accent of an AuxiNux palette. On light backgrounds the accent is darkened,
 * as Windows 11 and AuxiNux Shell do for text and buttons: the orange is
 * unreadable as text on white otherwise.
 */
export function accentFor(theme: "auxinux-dark" | "auxinux-light", accent: string | null | undefined) {
  const base = hexToRgb(accent ?? "") ?? hexToRgb(AUXINUX_ACCENT)!;
  const value = theme === "auxinux-light" ? mix(base, [0, 0, 0], 0.78) : base;
  return { accent: value, soft: mix(value, panels[theme], 0.22), on: onAccent(value) };
}

/** Whatever the backend (or the cache) returned, as a complete value. */
export function normalizeAppearance(value: unknown): SessionAppearance {
  const v = (value && typeof value === "object" ? value : {}) as Partial<SessionAppearance>;
  return {
    auxinuxShell: v.auxinuxShell === true,
    dark: typeof v.dark === "boolean" ? v.dark : null,
    accent: typeof v.accent === "string" && hexToRgb(v.accent) ? v.accent : null,
    highContrast: v.highContrast === true,
    fontFamily: typeof v.fontFamily === "string" && v.fontFamily.trim() ? v.fontFamily : null,
    textScale: typeof v.textScale === "number" && Number.isFinite(v.textScale) ? v.textScale : 1,
    animations: v.animations !== false,
  };
}

let session: SessionAppearance = normalizeAppearance(readStorage<unknown>(appearanceKey, neutral));

function systemPrefersDark() {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return true;
  }
}

export function applyTheme(choice: ThemeChoice = getThemeChoice()) {
  const root = document.documentElement;
  const theme = resolveTheme(choice, session, systemPrefersDark());
  root.dataset.theme = theme;
  const follow = choice !== "virtua";
  if (theme === "virtua") {
    for (const name of ["--v-accent", "--v-accent-soft", "--v-on-accent"]) root.style.removeProperty(name);
  } else {
    const { accent, soft, on } = accentFor(theme, choice === "auto" ? session.accent : null);
    root.style.setProperty("--v-accent", accent.join(" "));
    root.style.setProperty("--v-accent-soft", soft.join(" "));
    root.style.setProperty("--v-on-accent", on.join(" "));
  }
  // Accessibility settings of the session apply to every theme.
  root.dataset.contrast = session.highContrast ? "high" : "";
  root.dataset.motion = session.animations ? "" : "reduce";
  if (follow && session.fontFamily) {
    root.style.setProperty("--v-font", `"${session.fontFamily.replace(/["\\]/g, "")}", "Inter Variable", Inter`);
  } else {
    root.style.removeProperty("--v-font");
  }
  const scale = Number.isFinite(session.textScale) ? Math.min(2, Math.max(1, session.textScale)) : 1;
  root.style.fontSize = scale === 1 ? "" : `${16 * scale}px`;
  window.dispatchEvent(new CustomEvent("virtua-theme-changed", { detail: { choice, theme } }));
}

export function setThemeChoice(choice: ThemeChoice) {
  writeStorage(choiceKey, choice);
  applyTheme(choice);
}

export function getSessionAppearance() {
  return session;
}

async function refreshSession() {
  try {
    const next = normalizeAppearance(await invoke<unknown>("desktop_appearance"));
    if (JSON.stringify(next) !== JSON.stringify(session)) {
      session = next;
      writeStorage(appearanceKey, next);
      applyTheme();
    }
  } catch {
    /* Web preview or older backend: the system preference decides. */
  }
}

/**
 * Apply the theme before the first render (from the cached session look, no
 * flash), then follow the session: AuxiNux Shell switches light/dark at
 * sunset, and the accent can change any time from its Settings.
 */
export function startTheme() {
  applyTheme();
  void refreshSession();
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());
  } catch {
    /* Old engines without matchMedia listeners. */
  }
  window.addEventListener("focus", () => void refreshSession());
  window.setInterval(() => {
    if (!document.hidden) void refreshSession();
  }, 60_000);
}
