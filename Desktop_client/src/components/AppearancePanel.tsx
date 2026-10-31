import { useEffect, useState } from "react";
import { Palette } from "lucide-react";
import { getSessionAppearance, getThemeChoice, setThemeChoice, type ThemeChoice } from "@/theme";

const choices: Array<{ id: ThemeChoice; label: string; detail: string }> = [
  { id: "auto", label: "Automatique", detail: "Comme la session : clair/sombre, couleur d’accent, police et taille du texte d’AuxiNux Shell." },
  { id: "light", label: "Clair", detail: "Palette AuxiNux claire." },
  { id: "dark", label: "Sombre", detail: "Palette AuxiNux sombre." },
  { id: "virtua", label: "Virtua classique", detail: "L’apparence d’origine de Virtua Desktop." },
];

export function AppearancePanel() {
  const [choice, setChoice] = useState<ThemeChoice>(getThemeChoice);
  const [shell, setShell] = useState(() => getSessionAppearance().auxinuxShell);

  useEffect(() => {
    const update = () => setShell(getSessionAppearance().auxinuxShell);
    window.addEventListener("virtua-theme-changed", update);
    return () => window.removeEventListener("virtua-theme-changed", update);
  }, []);

  return (
    <section className="rounded border border-virtua-border bg-virtua-panel p-4">
      <div className="mb-1 flex items-center gap-2">
        <Palette className="h-4 w-4 text-virtua-accent" />
        <h2 className="text-sm font-semibold">Apparence</h2>
      </div>
      <p className="mb-3 text-xs text-virtua-muted">
        {shell ? "Session AuxiNux Shell détectée : en automatique, Virtua suit ses réglages en direct." : "En automatique, Virtua suit le mode clair ou sombre du système."}
      </p>
      <div role="radiogroup" aria-label="Apparence" className="grid grid-cols-2 gap-2">
        {choices.map((item) => (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={choice === item.id}
            onClick={() => {
              setChoice(item.id);
              setThemeChoice(item.id);
            }}
            className={`rounded border p-3 text-left transition-colors ${choice === item.id ? "border-virtua-accent bg-virtua-accentSoft" : "border-virtua-border hover:bg-virtua-panelHover"}`}
          >
            <span className="block text-sm font-medium">{item.label}</span>
            <span className="mt-1 block text-xs text-virtua-muted">{item.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
