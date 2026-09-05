import { Cloud, HardDrive } from "lucide-react";
import type { UsageMode } from "@/types";
import { useLanguage } from "@/i18n";

export function UsageModePage({ allowLocal = true, onSelect }: { allowLocal?: boolean; onSelect: (mode: UsageMode) => void }) {
  const { t } = useLanguage();

  return (
    <div className="grid h-screen place-items-center bg-virtua-bg p-6 text-virtua-text">
      <div className="w-full max-w-4xl">
        <div className="mb-7 flex justify-center">
          <img src="/brand/auxinux-virtua-logo.svg" alt="AuxiNux Virtua - Desktop Client" className="h-auto w-72" draggable={false} />
        </div>

        <div className={`grid gap-4 ${allowLocal ? "md:grid-cols-2" : "mx-auto max-w-md"}`}>
          {allowLocal ? (
            <button
              type="button"
              onClick={() => onSelect("local")}
              className="group rounded border border-virtua-border bg-virtua-panel p-6 text-left transition-colors hover:border-virtua-accent hover:bg-virtua-panelHover"
            >
              <div className="mb-5 flex h-12 w-12 items-center justify-center rounded bg-virtua-accentSoft text-virtua-accent">
                <HardDrive className="h-6 w-6" />
              </div>
              <h1 className="text-2xl font-semibold">{t("mode.local")}</h1>
              <p className="mt-2 text-sm leading-6 text-virtua-muted">
                {t("mode.local_desc")}
              </p>
              <span className="mt-5 inline-flex h-9 items-center rounded border border-virtua-border px-4 text-sm text-virtua-text group-hover:border-virtua-accent">
                {t("mode.local")}
              </span>
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => onSelect("cloud")}
            className="group rounded border border-virtua-border bg-virtua-panel p-6 text-left transition-colors hover:border-virtua-accent hover:bg-virtua-panelHover"
          >
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded bg-virtua-accentSoft text-virtua-accent">
              <Cloud className="h-6 w-6" />
            </div>
            <h1 className="text-2xl font-semibold">{t("mode.remote")}</h1>
            <p className="mt-2 text-sm leading-6 text-virtua-muted">
              {t("mode.remote_desc")}
            </p>
            <span className="mt-5 inline-flex h-9 items-center rounded border border-virtua-border px-4 text-sm text-virtua-text group-hover:border-virtua-accent">
              {t("mode.remote")}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
