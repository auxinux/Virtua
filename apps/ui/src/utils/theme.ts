export type AppTheme = "dark" | "light";

const STORAGE_KEY = "auxinux-theme";

export function getStoredTheme(): AppTheme {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" ? "light" : "dark";
}

export function applyTheme(theme: AppTheme) {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem(STORAGE_KEY, theme);
  window.dispatchEvent(new CustomEvent("auxinux-theme-change", { detail: theme }));
}

export function initializeTheme() {
  applyTheme(getStoredTheme());
}
