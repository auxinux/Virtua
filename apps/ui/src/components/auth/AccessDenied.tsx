import React from "react";
import { useTranslation } from "react-i18next";

export function AccessDenied({
  title,
  message,
}: {
  title?: string;
  message?: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-[40vh] items-center justify-center">
      <div className="card max-w-xl p-6 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-900/20 text-red-400">
          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
          </svg>
        </div>
        <h1 className="text-xl font-bold text-text-100">{title ?? t("access.deniedTitle")}</h1>
        <p className="mt-2 text-sm text-text-400">{message ?? t("access.deniedMessage")}</p>
      </div>
    </div>
  );
}
