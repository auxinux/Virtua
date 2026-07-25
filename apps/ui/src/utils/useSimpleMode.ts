import { useState, useEffect } from "react";

const SIMPLE_MODE_KEY = "auxinux-simple-mode";

export function useSimpleMode() {
  const [isSimpleMode, setIsSimpleMode] = useState<boolean>(() => {
    const stored = localStorage.getItem(SIMPLE_MODE_KEY);
    return stored === "true";
  });

  useEffect(() => {
    localStorage.setItem(SIMPLE_MODE_KEY, String(isSimpleMode));
    // Dispatch a custom event so other components can react if they don't use the hook
    window.dispatchEvent(new CustomEvent("auxinux-simple-mode-change", { detail: isSimpleMode }));
  }, [isSimpleMode]);

  useEffect(() => {
    const handler = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail;
      if (next !== isSimpleMode) setIsSimpleMode(next);
    };
    window.addEventListener("auxinux-simple-mode-change", handler as EventListener);
    return () => window.removeEventListener("auxinux-simple-mode-change", handler as EventListener);
  }, [isSimpleMode]);

  return {
    isSimpleMode,
    toggleSimpleMode: () => setIsSimpleMode(!isSimpleMode),
  };
}
